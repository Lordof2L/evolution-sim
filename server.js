// Evolution Simulator Server — NEAT Brains — v8 Full Rewrite
const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

// ─── CONSTANTS ───────────────────────────────────────────────
const requestedPort = Number.parseInt(process.env.PORT || '3333', 10);
const PORT = Number.isInteger(requestedPort) && requestedPort >= 0 && requestedPort <= 65535 ? requestedPort : 3333;
const HOST = process.env.HOST || '127.0.0.1';
const TICK_RATE = 30;
const MAP_SIZE = 800;
const MAP_CENTER = 400;
const MAP_RADIUS = 400;
const MAX_SPEED = 1.5;
const TURN_RATE = 0.1;
const MAX_ENERGY = 200;
const MAX_HP = 50;
const INITIAL_AGENTS = 80;
const SENSING_RANGE = 100;
const SPATIAL_CELL = 50;
const SAVE_FILE = path.join(__dirname, 'save.json');
const SAVE_VERSION = 8;
const MAX_HTTP_BODY_BYTES = 1024;
const MAX_WEBSOCKET_PAYLOAD_BYTES = 16 * 1024;
const HISTORY_KEYS = Object.freeze(['lifespan', 'gen', 'foodPerMin', 'survivalRate', 'avgConnections']);
const STATIC_FILES = new Map([
  ['/', 'index.html'],
  ['/index.html', 'index.html'],
]);
const SECURITY_HEADERS = Object.freeze({
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; connect-src 'self' ws://127.0.0.1:* ws://localhost:*; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
});

function createHistory(source = {}) {
  const historySource = source && typeof source === 'object' && !Array.isArray(source) ? source : {};
  const safeSeries = (key) => Array.isArray(historySource[key])
    ? historySource[key].filter(Number.isFinite).slice(-50)
    : [];

  return {
    lifespan: safeSeries('lifespan'),
    gen: safeSeries('gen'),
    foodPerMin: safeSeries('foodPerMin'),
    survivalRate: safeSeries('survivalRate'),
    avgConnections: safeSeries('avgConnections'),
  };
}

function isLoopbackHost(hostHeader) {
  if (typeof hostHeader !== 'string') return false;
  try {
    const hostname = new URL(`http://${hostHeader}`).hostname.toLowerCase();
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
  } catch {
    return false;
  }
}

function isAllowedBrowserOrigin(origin, hostHeader) {
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:')
      && isLoopbackHost(parsed.host)
      && parsed.host.toLowerCase() === String(hostHeader).toLowerCase();
  } catch {
    return false;
  }
}

function sendHttp(res, statusCode, body, headers = {}) {
  res.writeHead(statusCode, { ...SECURITY_HEADERS, ...headers });
  res.end(body);
}

// ─── GLOBAL STATE ────────────────────────────────────────────
let agents = [];
let food = [];
let terrain = [];
let tickCount = 0;
let paused = false;
let simSpeed = 1;
let lastSave = Date.now();
let nextId = 1;
let nextInnovation = 0;
const innovationMap = new Map();
let possessedId = null;
let possessedInput = { keys: {}, mouse: null };
let emptyTicks = 0;

// Stats
let stats = { population: 0, maxGen: 0, totalBorn: 0, totalDeaths: 0, avgFitness: 0, avgConnections: 0 };
let nnHistory = createHistory();

// ─── TERRAIN ─────────────────────────────────────────────────
function generateTerrain() {
  terrain = [];
  for (let y = 0; y < 40; y++) {
    terrain[y] = [];
    for (let x = 0; x < 40; x++) {
      const cx = (x - 20) / 20, cy = (y - 20) / 20;
      const dist = Math.sqrt(cx * cx + cy * cy);
      if (dist > 1.0) { terrain[y][x] = 2; continue; }
      const n = Math.sin(x * 0.8 + y * 0.3) * 0.4 + Math.cos(y * 0.7 - x * 0.5) * 0.3 + Math.sin(x * 0.2 + y * 0.9) * 0.3;
      terrain[y][x] = n > 0.15 ? 1 : 0;
    }
  }
}

function getTerrainAt(x, y) {
  const cellPx = MAP_SIZE / 40;
  const gx = Math.floor(x / cellPx), gy = Math.floor(y / cellPx);
  if (gx < 0 || gx >= 40 || gy < 0 || gy >= 40) return 2;
  return terrain[gy][gx];
}

// ─── SPATIAL GRID ────────────────────────────────────────────
const spatialGrid = {
  cells: new Map(),
  clear() { this.cells.clear(); },
  key(cx, cy) { return cx * 10000 + cy; },
  insert(entity) {
    const cx = Math.floor(entity.x / SPATIAL_CELL), cy = Math.floor(entity.y / SPATIAL_CELL);
    const k = this.key(cx, cy);
    if (!this.cells.has(k)) this.cells.set(k, []);
    this.cells.get(k).push(entity);
  },
  query(x, y, range) {
    const results = [];
    const minCx = Math.floor((x - range) / SPATIAL_CELL), maxCx = Math.floor((x + range) / SPATIAL_CELL);
    const minCy = Math.floor((y - range) / SPATIAL_CELL), maxCy = Math.floor((y + range) / SPATIAL_CELL);
    for (let cx = minCx; cx <= maxCx; cx++) {
      for (let cy = minCy; cy <= maxCy; cy++) {
        const cell = this.cells.get(this.key(cx, cy));
        if (cell) for (const e of cell) {
          const dx = e.x - x, dy = e.y - y;
          if (dx * dx + dy * dy <= range * range) results.push(e);
        }
      }
    }
    return results;
  }
};

// ─── NEAT BRAIN ──────────────────────────────────────────────
function getInnovation(from, to) {
  const key = `${from}_${to}`;
  if (innovationMap.has(key)) return innovationMap.get(key);
  const inn = nextInnovation++;
  innovationMap.set(key, inn);
  return inn;
}

function createBrain() {
  const nodes = new Map();
  for (let i = 0; i < 8; i++) nodes.set(i, { value: 0, type: 'input' });
  for (let i = 8; i < 12; i++) nodes.set(i, { value: 0, type: 'output' });
  // SEED: basic survival connections — can be mutated away but start functional
  const connections = [
    { from: 0, to: 8, weight: 0.5 + Math.random() * 0.5, enabled: true, innovation: getInnovation(0, 8) },   // constant → accelerate (always move)
    { from: 2, to: 9, weight: 0.5 + Math.random() * 0.5, enabled: true, innovation: getInnovation(2, 9) },   // foodAngleX → rotate (turn to food)
    { from: 6, to: 10, weight: 0.8 + Math.random() * 0.4, enabled: true, innovation: getInnovation(6, 10) }, // onFood → eat (eat when touching)
  ];
  return { nodes, connections, nextNode: 12 };
}

function cloneBrain(brain) {
  const nodes = new Map();
  for (const [id, n] of brain.nodes) nodes.set(id, { value: 0, type: n.type });
  const connections = brain.connections.map(c => ({ ...c }));
  return { nodes, connections, nextNode: brain.nextNode };
}

function brainForward(brain, inputValues) {
  // Reset non-input nodes
  for (const [id, node] of brain.nodes) {
    if (id >= 8) node.value = 0;
  }
  // Set inputs
  for (let i = 0; i < 8; i++) brain.nodes.get(i).value = inputValues[i];
  // 3 settling iterations
  for (let iter = 0; iter < 3; iter++) {
    for (const conn of brain.connections) {
      if (!conn.enabled) continue;
      const fromNode = brain.nodes.get(conn.from);
      const toNode = brain.nodes.get(conn.to);
      if (fromNode && toNode) toNode.value += fromNode.value * conn.weight;
    }
    for (const [id, node] of brain.nodes) {
      if (id >= 8) node.value = Math.max(-1, Math.min(1, Math.tanh(node.value)));
    }
  }
  return {
    accelerate: brain.nodes.get(8).value,
    rotate: brain.nodes.get(9).value,
    eat: brain.nodes.get(10).value,
    reproduce: brain.nodes.get(11).value,
  };
}

function mutateAddConnection(brain) {
  const nodeIds = [...brain.nodes.keys()];
  for (let attempt = 0; attempt < 20; attempt++) {
    const from = nodeIds[Math.floor(Math.random() * nodeIds.length)];
    const to = nodeIds[Math.floor(Math.random() * nodeIds.length)];
    if (from === to) continue;
    if (brain.nodes.get(to).type === 'input') continue;
    if (brain.nodes.get(from).type === 'output' && brain.nodes.get(to).type === 'output') continue;
    if (brain.connections.some(c => c.from === from && c.to === to)) continue;
    brain.connections.push({ from, to, weight: Math.random() * 2 - 1, enabled: true, innovation: getInnovation(from, to) });
    return;
  }
}

function mutateAddNode(brain) {
  const enabled = brain.connections.filter(c => c.enabled);
  if (enabled.length === 0) return;
  const conn = enabled[Math.floor(Math.random() * enabled.length)];
  conn.enabled = false;
  const newId = brain.nextNode++;
  brain.nodes.set(newId, { value: 0, type: 'hidden' });
  brain.connections.push({ from: conn.from, to: newId, weight: 1.0, enabled: true, innovation: getInnovation(conn.from, newId) });
  brain.connections.push({ from: newId, to: conn.to, weight: conn.weight, enabled: true, innovation: getInnovation(newId, conn.to) });
}

function mutateWeights(brain) {
  for (const conn of brain.connections) {
    if (Math.random() < 0.4) { // conservative: don't destroy most weights
      if (Math.random() < 0.1) {
        conn.weight = Math.random() * 2 - 1; // full reset 10%
      } else {
        conn.weight += (Math.random() * 2 - 1) * 0.15; // small perturbation
        conn.weight = Math.max(-2, Math.min(2, conn.weight)); // tight clamp
      }
    }
  }
}

function mutateToggle(brain) {
  if (brain.connections.length === 0) return;
  const conn = brain.connections[Math.floor(Math.random() * brain.connections.length)];
  conn.enabled = !conn.enabled;
}

function mutateBrain(brain) {
  if (Math.random() < 0.25) {
    const r = Math.random();
    if (r < 0.03) mutateAddNode(brain);
    else if (r < 0.20) mutateAddConnection(brain);
    else if (r < 0.25) mutateToggle(brain);
  }
  mutateWeights(brain);
}

function crossover(brainA, brainB, fitnessA, fitnessB) {
  const better = fitnessA >= fitnessB ? brainA : brainB;
  const worse = fitnessA >= fitnessB ? brainB : brainA;
  const child = { nodes: new Map(), connections: [], nextNode: 12 };
  // Init base input/output nodes
  for (let i = 0; i < 8; i++) child.nodes.set(i, { value: 0, type: 'input' });
  for (let i = 8; i < 12; i++) child.nodes.set(i, { value: 0, type: 'output' });
  child.nextNode = Math.max(better.nextNode, worse.nextNode);
  for (const [id, n] of better.nodes) child.nodes.set(id, { value: 0, type: n.type });
  for (const [id, n] of worse.nodes) {
    if (!child.nodes.has(id)) child.nodes.set(id, { value: 0, type: n.type });
  }
  const worseMap = new Map();
  for (const c of worse.connections) worseMap.set(c.innovation, c);
  for (const c of better.connections) {
    const match = worseMap.get(c.innovation);
    if (match) {
      child.connections.push({ ...c, weight: Math.random() < 0.5 ? c.weight : match.weight });
    } else {
      child.connections.push({ ...c });
    }
  }
  return child;
}

// ─── FOOD ────────────────────────────────────────────────────
const FOOD_TYPES = {
  plankton: { r: 2, energy: 80, hp: 2, color: '#88ff88', type: 'plankton' },
  algae: { r: 4, energy: 250, hp: 5, color: '#44cc44', type: 'algae' },
  meat: { r: 6, energy: 600, hp: 1, color: '#cc4444', type: 'meat' },
  fruit: { r: 9, energy: 1500, hp: 30, color: '#ffaa00', type: 'fruit' },
};

function isFoodTooClose(x, y, r) {
  const minDist = r * 3;
  const nearby = spatialGrid.query(x, y, minDist);
  for (const e of nearby) {
    if (e._isFood) {
      const dx = e.x - x, dy = e.y - y;
      if (Math.sqrt(dx * dx + dy * dy) < minDist) return true;
    }
  }
  return false;
}

function spawnFood(type, x, y) {
  const t = FOOD_TYPES[type];
  food.push({ id: nextId++, x, y, r: t.r, energy: t.energy, hp: t.hp, maxHp: t.hp, color: t.color, type, _isFood: true });
}

function randomInCircle() {
  const angle = Math.random() * Math.PI * 2;
  const r = Math.sqrt(Math.random()) * MAP_RADIUS * 0.95;
  return { x: MAP_CENTER + Math.cos(angle) * r, y: MAP_CENTER + Math.sin(angle) * r };
}

function growFood() {
  // Cache food counts once
  let planktonCount = 0, algaeCount = 0, planktonList = [], algaeList = [];
  for (const f of food) {
    if (f.type === 'plankton') { planktonCount++; planktonList.push(f); }
    else if (f.type === 'algae') { algaeCount++; algaeList.push(f); }
  }

  // Target plankton scales with population — ensures enough food
  const target = 500 + agents.length * 3;

  // Bootstrap if critically low
  if (planktonCount < 80 && tickCount % 10 === 0) {
    for (let i = 0; i < 5; i++) {
      const pos = randomInCircle();
      spawnFood('plankton', pos.x, pos.y);
    }
  }

  // Plankton: grow near existing, rate based on deficit
  if (planktonCount < target && planktonList.length > 0) {
    const grow = Math.max(2, Math.floor(Math.sqrt(target - planktonCount) * 1.2));
    for (let i = 0; i < grow; i++) {
      const parent = planktonList[Math.floor(Math.random() * planktonList.length)];
      const spread = 8 + Math.random() * 12;
      const a = Math.random() * Math.PI * 2;
      const nx = parent.x + Math.cos(a) * spread, ny = parent.y + Math.sin(a) * spread;
      const dx = nx - MAP_CENTER, dy = ny - MAP_CENTER;
      if (dx*dx+dy*dy < MAP_RADIUS*MAP_RADIUS*0.9 && !isFoodTooClose(nx, ny, FOOD_TYPES.plankton.r)) {
        spawnFood('plankton', nx, ny);
      }
    }
  }

  // Algae: rare, near existing
  if (algaeCount < 40 + agents.length * 0.2 && tickCount % 20 === 0 && algaeList.length > 0) {
    const parent = algaeList[Math.floor(Math.random() * algaeList.length)];
    const nx = parent.x + (Math.random()-0.5)*20, ny = parent.y + (Math.random()-0.5)*20;
    if (!isFoodTooClose(nx, ny, FOOD_TYPES.algae.r)) spawnFood('algae', nx, ny);
  }

  // Fruit: very rare, land only
  if (tickCount % 50 === 0) {
    const pos = randomInCircle();
    if (getTerrainAt(pos.x, pos.y) === 1) spawnFood('fruit', pos.x, pos.y);
  }

  // Hard trim
  if (planktonCount > 2500) food = food.filter(f => f.type !== 'plankton' || Math.random() > 0.4);
  if (food.length - planktonCount > 300) food = food.filter(f => f.type === 'plankton' || Math.random() > 0.5);
}

function dropMeat(x, y, totalEnergy, count) {
  for (let i = 0; i < count; i++) {
    const angle = Math.random() * Math.PI * 2;
    const dist = Math.random() * 10;
    const mx = x + Math.cos(angle) * dist, my = y + Math.sin(angle) * dist;
    const t = FOOD_TYPES.meat;
    food.push({ id: nextId++, x: mx, y: my, r: t.r, energy: Math.floor(totalEnergy / count), hp: t.hp, maxHp: t.hp, color: t.color, type: 'meat', _isFood: true });
  }
}

// ─── AGENTS (multicellular) ──────────────────────────────────
// Cells: each organism has cells arranged around center
// Types: core (base), mouth (eat bonus), muscle (speed), sensor (vision), armor (hp)
const CELL_TYPES = ['core', 'mouth', 'muscle', 'sensor', 'armor'];
const CELL_PROPS = {
  core:   { hpBonus: 10, speedMod: 0,    eatMod: 0,   senseMod: 0,   color: '#888' },
  mouth:  { hpBonus: 5,  speedMod: 0,    eatMod: 1.5, senseMod: 0,   color: '#ff6666' },
  muscle: { hpBonus: 5,  speedMod: 0.3,  eatMod: 0,   senseMod: 0,   color: '#6688ff' },
  sensor: { hpBonus: 3,  speedMod: 0,    eatMod: 0,   senseMod: 20,  color: '#ffffff' },
  armor:  { hpBonus: 25, speedMod: -0.1, eatMod: 0,   senseMod: 0,   color: '#666666' },
};

function createCells(count) {
  const cells = [{ type: 'core', lx: 0, ly: 0 }];
  for (let i = 1; i < count; i++) {
    const parent = cells[Math.floor(Math.random() * cells.length)];
    const type = CELL_TYPES[Math.floor(Math.random() * CELL_TYPES.length)];
    const angle = Math.random() * Math.PI * 2;
    cells.push({ type, lx: parent.lx + Math.cos(angle) * 6, ly: parent.ly + Math.sin(angle) * 6 });
  }
  return cells;
}

function mutateCells(cells) {
  // 15% chance: add a cell (grow)
  if (Math.random() < 0.35 && cells.length < 25) {
    const parent = cells[Math.floor(Math.random() * cells.length)];
    const type = CELL_TYPES[Math.floor(Math.random() * CELL_TYPES.length)];
    // Directional: mouth→front, muscle→back, sensor→side
    let angle;
    if (type === 'mouth') angle = (Math.random() - 0.5) * 0.8; // front
    else if (type === 'muscle') angle = Math.PI + (Math.random() - 0.5) * 0.8; // back
    else if (type === 'sensor') angle = (Math.random() > 0.5 ? 1 : -1) * Math.PI/2 + (Math.random()-0.5)*0.5;
    else angle = Math.random() * Math.PI * 2;
    cells.push({ type, lx: parent.lx + Math.cos(angle) * 6, ly: parent.ly + Math.sin(angle) * 6 });
  }
  // 5% chance: lose a non-core cell
  if (Math.random() < 0.05 && cells.length > 1) {
    const idx = 1 + Math.floor(Math.random() * (cells.length - 1));
    cells.splice(idx, 1);
  }
  // 10% chance: change a cell type
  if (Math.random() < 0.10 && cells.length > 1) {
    const idx = 1 + Math.floor(Math.random() * (cells.length - 1));
    cells[idx].type = CELL_TYPES[Math.floor(Math.random() * CELL_TYPES.length)];
  }
  return cells;
}

function agentRadius(a) {
  const cellCount = a.cells ? a.cells.length : 1;
  return 3 + Math.sqrt(cellCount) * 2.5 + (a.energy / MAX_ENERGY) * 2;
}

function agentMaxHp(a) {
  let hp = 0;
  for (const c of (a.cells || [])) hp += CELL_PROPS[c.type].hpBonus;
  return Math.max(20, hp);
}

function agentSpeedMod(a) {
  let mod = 0;
  for (const c of (a.cells || [])) mod += CELL_PROPS[c.type].speedMod;
  return 1 + mod;
}

function agentEatMod(a) {
  let mod = 0;
  for (const c of (a.cells || [])) mod += CELL_PROPS[c.type].eatMod;
  return 1 + mod;
}

function agentSenseRange(a) {
  let bonus = 0;
  for (const c of (a.cells || [])) bonus += CELL_PROPS[c.type].senseMod;
  return SENSING_RANGE + bonus;
}

function agentFitness(a) { return a.foodEaten * 100 + a.kills * 200 + a.age + (a.cells ? a.cells.length * 50 : 0); }

function createAgent(x, y, brain, generation, bloodline, cells) {
  const a = {
    id: nextId++, x, y, angle: Math.random() * Math.PI * 2, speed: 0,
    energy: MAX_ENERGY, hp: MAX_HP, age: 0,
    brain: brain || createBrain(),
    cells: cells || [{ type: 'core', lx: 0, ly: 0 }],
    foodEaten: 0, kills: 0, offspringCount: 0,
    generation: generation || 0, bloodline: bloodline || nextId,
    alive: true, reproTimer: 0, touchingFood: null, touchingAgent: null,
    eatCooldown: 0, memoryCell: 0,
    outputs: { accelerate: 0, rotate: 0, eat: 0, reproduce: 0 },
  };
  a.hp = agentMaxHp(a);
  return a;
}

function spawnInitialAgents(count) {
  for (let i = 0; i < count; i++) {
    const pos = randomInCircle();
    const a = createAgent(pos.x, pos.y, null, 0, nextId);
    mutateBrain(a.brain);
    agents.push(a);
    stats.totalBorn++;
  }
}

// ─── SENSING ─────────────────────────────────────────────────
function sense(agent) {
  const range = agentSenseRange(agent);
  const nearby = spatialGrid.query(agent.x, agent.y, range);
  const nearbyFood = [], nearbyAgents = [];
  for (const e of nearby) {
    if (e._isFood) nearbyFood.push(e);
    else if (e.alive && e.id !== agent.id) nearbyAgents.push(e);
  }

  let foodAngle = 0, foodDist = 1;
  let nearestFoodDist = Infinity;
  for (const f of nearbyFood) {
    const dx = f.x - agent.x, dy = f.y - agent.y;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d < nearestFoodDist) {
      nearestFoodDist = d;
      foodAngle = Math.atan2(dy, dx) - agent.angle;
      foodDist = Math.min(1, d / SENSING_RANGE);
    }
  }
  foodAngle = ((foodAngle + Math.PI) % (Math.PI * 2)) - Math.PI;

  let agentAngle = 0, agentDist = 1;
  let nearestAgentDist = Infinity;
  for (const a of nearbyAgents) {
    const dx = a.x - agent.x, dy = a.y - agent.y;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d < nearestAgentDist) {
      nearestAgentDist = d;
      agentAngle = Math.atan2(dy, dx) - agent.angle;
      agentDist = Math.min(1, d / SENSING_RANGE);
    }
  }
  agentAngle = ((agentAngle + Math.PI) % (Math.PI * 2)) - Math.PI;

  const ar = agentRadius(agent);
  agent.touchingFood = null;
  for (const f of nearbyFood) {
    const dx = f.x - agent.x, dy = f.y - agent.y;
    if (dx*dx+dy*dy < (ar+f.r)*(ar+f.r)) { agent.touchingFood = f; break; }
  }

  agent.touchingAgent = null;
  for (const a of nearbyAgents) {
    const dx = a.x - agent.x, dy = a.y - agent.y;
    const tr = ar + agentRadius(a); if (dx*dx+dy*dy < tr*tr) { agent.touchingAgent = a; break; }
  }

  // Memory cell: decays slowly, persists between ticks
  if (agent.memoryCell === undefined) agent.memoryCell = 0;

  return [
    1.0,                                              // constant bias
    agent.energy / MAX_ENERGY,                        // energy %
    Math.sin(foodAngle),                              // food direction X — always clear signal
    Math.cos(foodAngle) * (1 - foodDist),              // food Y weighted by proximity
    Math.sin(agentAngle),                             // agent direction X
    Math.cos(agentAngle) * (1 - agentDist),           // agent direction Y weighted by proximity
    agent.touchingFood ? 1 : (foodDist < 0.3 ? 0.5 : -1), // gradient: touching/near/far
    agent.memoryCell,                                  // persistent memory
  ];
}

// ─── TICK ────────────────────────────────────────────────────
function tick() {
  tickCount++;

  spatialGrid.clear();
  for (const a of agents) if (a.alive) spatialGrid.insert(a);
  for (const f of food) { f._isFood = true; spatialGrid.insert(f); }

  growFood();

  for (const agent of agents) {
    if (!agent.alive) continue;
    agent.age++;
    if (agent.reproTimer > 0) agent.reproTimer--;
    if (agent.eatCooldown > 0) agent.eatCooldown--;

    if (agent.memoryCell === undefined) agent.memoryCell = 0;
    agent.memoryCell *= 0.98;
    const inputs = sense(agent);
    let outputs;

    if (agent.id === possessedId) {
      outputs = { accelerate: 0, rotate: 0, eat: 0, reproduce: 0 };
      if (possessedInput.keys) {
        if (possessedInput.keys.w || possessedInput.keys.ArrowUp) outputs.accelerate = 1;
        if (possessedInput.keys.s || possessedInput.keys.ArrowDown) outputs.accelerate = -1;
        if (possessedInput.keys.a || possessedInput.keys.ArrowLeft) outputs.rotate = -1;
        if (possessedInput.keys.d || possessedInput.keys.ArrowRight) outputs.rotate = 1;
        if (possessedInput.keys.e || possessedInput.keys[' ']) outputs.eat = 1;
        if (possessedInput.keys.r) outputs.reproduce = 1;
      }
    } else {
      outputs = brainForward(agent.brain, inputs);
    }
    agent.outputs = outputs;
    // Memory: blend of eat+reproduce outputs — persists to next tick
    agent.memoryCell = (agent.memoryCell || 0) * 0.8 + (outputs.eat + outputs.reproduce) * 0.1;

    agent.angle += outputs.rotate * TURN_RATE * 1.5; // more responsive turning
    // Speed: muscle cells provide thrust, bigger body = more drag
    const thrust = agentSpeedMod(agent);
    const drag = Math.sqrt(1 + (agent.cells ? agent.cells.length : 1) * 0.2);
    agent.speed = Math.max(0, (outputs.accelerate + 1) * 0.5) * MAX_SPEED * thrust / drag;
    agent.x += Math.cos(agent.angle) * agent.speed;
    agent.y += Math.sin(agent.angle) * agent.speed;

    const dx = agent.x - MAP_CENTER, dy = agent.y - MAP_CENTER;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist > MAP_RADIUS - 5) {
      const norm = Math.atan2(dy, dx);
      agent.x = MAP_CENTER + Math.cos(norm) * (MAP_RADIUS - 6);
      agent.y = MAP_CENTER + Math.sin(norm) * (MAP_RADIUS - 6);
      agent.angle = norm + Math.PI + (Math.random() - 0.5) * 0.5;
    }

    const cellCount = agent.cells ? agent.cells.length : 1;
    agent.energy -= 0.002 * cellCount + agent.speed * 0.002;

    const mhp = agentMaxHp(agent);
    if (agent.energy > MAX_ENERGY * 0.5) agent.hp = Math.min(mhp, agent.hp + 0.1);

    if (agent.touchingFood && outputs.eat > 0 && agent.eatCooldown <= 0) {
      const f = agent.touchingFood;
      const bite = (2 + (agent.energy / MAX_ENERGY) * 3) * agentEatMod(agent);
      f.hp -= bite;
      agent.eatCooldown = 3;
      if (f.hp <= 0) {
        let gain = f.energy;
        if (f.type === 'meat') gain *= 2;
        if (getTerrainAt(f.x, f.y) === 1) gain *= 2;
        agent.energy = Math.min(MAX_ENERGY * 2, agent.energy + gain);
        agent.foodEaten++;
        f.eaten = true; // mark for removal (filtered at end of tick)
      }
    }

    if (agent.touchingAgent) {
      const other = agent.touchingAgent;
      const ar = agentRadius(agent), or = agentRadius(other);
      if (ar > or && other.alive) {
        const toAngle = Math.atan2(other.y - agent.y, other.x - agent.x);
        let angleDiff = Math.abs(toAngle - agent.angle);
        if (angleDiff > Math.PI) angleDiff = Math.PI * 2 - angleDiff;
        if (angleDiff < Math.PI / 6) {
          const dmg = 3 + (agent.energy / 200) * 2;
          other.hp -= dmg;
          if (other.hp <= 0) {
            other.alive = false;
            agent.kills++;
            agent.energy = Math.min(MAX_ENERGY * 2, agent.energy + other.energy * 0.5);
            dropMeat(other.x, other.y, MAX_ENERGY * 0.4, 2 + Math.floor(Math.random() * 2));
            stats.totalDeaths++;
          }
        }
      }
    }

    // Soft cap: above 800 agents, reproduction chance drops (no hard block)
    const reproPenalty = agents.length > 800 ? agents.length / 800 : 1;
    if (outputs.reproduce > 0 && agent.energy > 100 && agent.age > 120 && agent.reproTimer <= 0 && Math.random() < (1 / reproPenalty)) {
      const cost = agent.energy * 0.4;
      agent.energy -= cost;
      agent.reproTimer = 90;
      agent.offspringCount++;

      let childBrain;
      if (agent.touchingAgent && agent.touchingAgent.alive) {
        const other = agent.touchingAgent;
        childBrain = crossover(agent.brain, other.brain, agentFitness(agent), agentFitness(other));
      } else {
        childBrain = cloneBrain(agent.brain);
      }
      mutateBrain(childBrain);

      const cAngle = Math.random() * Math.PI * 2;
      // Child inherits cells — only fit parents grow complex bodies
      // Cell growth: anyone who survived long enough gets to evolve morphology
      const childCells = mutateCells(JSON.parse(JSON.stringify(agent.cells)));
      const child = createAgent(
        agent.x + Math.cos(cAngle) * 15, agent.y + Math.sin(cAngle) * 15,
        childBrain, agent.generation + 1, agent.bloodline, childCells
      );
      child.energy = cost * 0.8;
      agents.push(child);
      stats.totalBorn++;
    }

    if (agent.energy <= 0) {
      agent.alive = false;
      dropMeat(agent.x, agent.y, MAX_ENERGY * 0.4, 2 + Math.floor(Math.random() * 3));
      stats.totalDeaths++;
    }
  }

  agents = agents.filter(a => a.alive);
  food = food.filter(f => !f.eaten); // remove eaten food

  if (agents.length === 0) {
    emptyTicks++;
    if (emptyTicks >= 300) { spawnInitialAgents(50); emptyTicks = 0; }
  } else {
    emptyTicks = 0;
  }

  stats.population = agents.length;
  stats.maxGen = agents.reduce((m, a) => Math.max(m, a.generation), 0);
  stats.avgFitness = agents.length > 0 ? agents.reduce((s, a) => s + agentFitness(a), 0) / agents.length : 0;
  stats.avgConnections = agents.length > 0 ? agents.reduce((s, a) => s + a.brain.connections.length, 0) / agents.length : 0;

  if (tickCount % 300 === 0 && agents.length > 0) {
    const avgLifespan = agents.reduce((s, a) => s + a.age, 0) / agents.length;
    const avgGen = agents.reduce((s, a) => s + a.generation, 0) / agents.length;
    const avgFPM = agents.reduce((s, a) => s + (a.age > 1 ? (a.foodEaten * TICK_RATE * 60) / a.age : 0), 0) / agents.length;
    nnHistory.lifespan.push(Math.round(avgLifespan));
    nnHistory.gen.push(Math.round(avgGen * 10) / 10);
    nnHistory.foodPerMin.push(Math.round(avgFPM * 100) / 100);
    nnHistory.survivalRate.push(agents.length);
    nnHistory.avgConnections.push(Math.round(stats.avgConnections * 10) / 10);
    const maxHist = 50;
    for (const key of HISTORY_KEYS) {
      if (nnHistory[key].length > maxHist) nnHistory[key] = nnHistory[key].slice(-maxHist);
    }
  }
}

// ─── BLOODLINES ──────────────────────────────────────────────
function getTopBloodlines() {
  const counts = new Map();
  for (const agent of agents) counts.set(agent.bloodline, (counts.get(agent.bloodline) || 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([bloodline, count]) => ({ bloodline, count }));
}

// ─── SAVE / LOAD ─────────────────────────────────────────────
function saveState() {
  const data = {
    version: SAVE_VERSION, tickCount, nextId, nextInnovation,
    innovationEntries: [...innovationMap.entries()],
    agents: agents.map(a => ({
      id: a.id, x: a.x, y: a.y, angle: a.angle, speed: a.speed,
      energy: a.energy, hp: a.hp, age: a.age,
      foodEaten: a.foodEaten, kills: a.kills, offspringCount: a.offspringCount,
      generation: a.generation, bloodline: a.bloodline,
      reproTimer: a.reproTimer, eatCooldown: a.eatCooldown,
      brain: {
        connections: a.brain.connections,
        nextNode: a.brain.nextNode,
        nodeTypes: [...a.brain.nodes.entries()].map(([id, n]) => [id, n.type]),
      },
    })),
    food: food.map(f => ({ id: f.id, x: f.x, y: f.y, r: f.r, energy: f.energy, hp: f.hp, maxHp: f.maxHp, color: f.color, type: f.type })),
    terrain, stats, nnHistory,
  };
  try { fs.writeFileSync(SAVE_FILE, JSON.stringify(data)); } catch (e) { console.error('Save error:', e.message); }
}

function loadState() {
  try {
    if (!fs.existsSync(SAVE_FILE)) return false;
    const data = JSON.parse(fs.readFileSync(SAVE_FILE, 'utf8'));
    if (data.version < SAVE_VERSION) { console.log('Old save version, ignoring.'); return false; }
    tickCount = Number.isSafeInteger(data.tickCount) && data.tickCount >= 0 ? data.tickCount : 0;
    nextId = Number.isSafeInteger(data.nextId) && data.nextId >= 1 ? data.nextId : 1;
    nextInnovation = Number.isSafeInteger(data.nextInnovation) && data.nextInnovation >= 0 ? data.nextInnovation : 0;
    innovationMap.clear();
    if (data.innovationEntries) for (const [k, v] of data.innovationEntries) innovationMap.set(k, v);
    terrain = data.terrain || [];
    stats = data.stats || stats;
    nnHistory = createHistory(data.nnHistory);
    food = (data.food || []).map(f => ({ ...f, _isFood: true }));
    agents = (data.agents || []).map(a => {
      const agentId = Number(a.id);
      if (!Number.isSafeInteger(agentId) || agentId < 1) throw new TypeError('Invalid agent ID in save file');
      const brain = createBrain();
      brain.nextNode = a.brain.nextNode || 12;
      brain.connections = a.brain.connections || [];
      if (a.brain.nodeTypes) {
        brain.nodes.clear();
        for (const [id, type] of a.brain.nodeTypes) brain.nodes.set(id, { value: 0, type });
      }
      return {
        id: agentId, x: a.x, y: a.y, angle: a.angle, speed: a.speed || 0,
        energy: a.energy, hp: a.hp, age: a.age,
        brain, foodEaten: a.foodEaten, kills: a.kills, offspringCount: a.offspringCount,
        generation: a.generation, bloodline: a.bloodline,
        alive: true, reproTimer: a.reproTimer || 0, eatCooldown: a.eatCooldown || 0,
        touchingFood: null, touchingAgent: null,
        outputs: { accelerate: 0, rotate: 0, eat: 0, reproduce: 0 },
      };
    });
    console.log(`Loaded save: ${agents.length} agents, tick ${tickCount}`);
    return true;
  } catch (e) { console.error('Load error:', e.message); return false; }
}

// ─── HTTP SERVER ─────────────────────────────────────────────
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };

const server = http.createServer((req, res) => {
  if (!isLoopbackHost(req.headers.host)) {
    return sendHttp(res, 421, 'Misdirected request', { 'Content-Type': 'text/plain; charset=utf-8' });
  }

  let requestUrl;
  try {
    requestUrl = new URL(req.url, 'http://localhost');
  } catch {
    return sendHttp(res, 400, 'Bad request', { 'Content-Type': 'text/plain; charset=utf-8' });
  }

  if (req.method === 'GET' && requestUrl.pathname === '/stats') {
    return sendHttp(
      res,
      200,
      JSON.stringify({ ...stats, tickCount, foodCount: food.length, bloodlines: getTopBloodlines(), nnHistory }),
      { 'Content-Type': 'application/json' },
    );
  }

  if (req.method === 'POST' && requestUrl.pathname === '/speed') {
    if (!isAllowedBrowserOrigin(req.headers.origin, req.headers.host)) {
      return sendHttp(res, 403, 'Forbidden', { 'Content-Type': 'text/plain; charset=utf-8' });
    }

    let body = '';
    let bodyBytes = 0;
    let bodyTooLarge = false;
    req.on('data', (chunk) => {
      bodyBytes += chunk.length;
      if (bodyBytes > MAX_HTTP_BODY_BYTES) {
        bodyTooLarge = true;
        return;
      }
      body += chunk;
    });
    req.on('end', () => {
      if (bodyTooLarge) {
        return sendHttp(res, 413, 'Payload too large', { 'Content-Type': 'text/plain; charset=utf-8' });
      }
      try {
        const requestedSpeed = Number(JSON.parse(body).speed);
        if (!Number.isFinite(requestedSpeed)) throw new TypeError('speed must be a finite number');
        simSpeed = Math.max(1, Math.min(1000, requestedSpeed));
        return sendHttp(res, 200, JSON.stringify({ speed: simSpeed }), { 'Content-Type': 'application/json' });
      } catch {
        return sendHttp(res, 400, 'Invalid speed', { 'Content-Type': 'text/plain; charset=utf-8' });
      }
    });
    return;
  }

  if (req.method !== 'GET') {
    return sendHttp(res, 405, 'Method not allowed', {
      Allow: 'GET, POST',
      'Content-Type': 'text/plain; charset=utf-8',
    });
  }

  const fileName = STATIC_FILES.get(requestUrl.pathname);
  if (!fileName) return sendHttp(res, 404, 'Not found', { 'Content-Type': 'text/plain; charset=utf-8' });

  const filePath = path.join(__dirname, fileName);
  const ext = path.extname(filePath);
  fs.readFile(filePath, (err, data) => {
    if (err) return sendHttp(res, 404, 'Not found', { 'Content-Type': 'text/plain; charset=utf-8' });
    return sendHttp(res, 200, data, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
  });
});

// ─── WEBSOCKET ───────────────────────────────────────────────
const wss = new WebSocket.Server({
  server,
  maxPayload: MAX_WEBSOCKET_PAYLOAD_BYTES,
  verifyClient(info, done) {
    const allowed = isLoopbackHost(info.req.headers.host)
      && isAllowedBrowserOrigin(info.origin, info.req.headers.host);
    if (allowed) done(true);
    else done(false, 403, 'Forbidden');
  },
});

function broadcastState() {
  if (wss.clients.size === 0) return;
  // Slim payload — only what client needs to render
  const agentData = agents.map(a => ({
    id: a.id, x: a.x|0, y: a.y|0,
    angle: (a.angle*100|0)/100, energy: a.energy|0, maxEnergy: MAX_ENERGY,
    hp: a.hp|0, maxHp: MAX_HP, generation: a.generation, bloodline: a.bloodline,
    age: a.age, kills: a.kills, foodEaten: a.foodEaten, offspringCount: a.offspringCount,
    brainSize: (a.brain && a.brain.connections) ? a.brain.connections.length : 0,
    cellCount: a.cells ? a.cells.length : 1,
    cells: a.cells && a.cells.length > 1 ? a.cells : undefined, // only send if multicellular
    outputs: a.outputs,
    brainConnections: a.id === possessedId ? a.brain.connections : undefined,
  }));
  const foodData = food.map(f => ({ x: f.x|0, y: f.y|0, r: f.r, c: f.color }));
  // Slim nnHistory: only last 50 datapoints per series
  const slimHist = {
    lifespan: nnHistory.lifespan.slice(-50),
    gen: nnHistory.gen.slice(-50),
    foodPerMin: nnHistory.foodPerMin.slice(-50),
    survivalRate: nnHistory.survivalRate.slice(-50),
    avgConnections: nnHistory.avgConnections.slice(-50),
  };
  const msg = JSON.stringify({ type: 'state', tick: tickCount, agents: agentData, food: foodData, stats: { ...stats, foodCount: food.length, bloodlines: getTopBloodlines(), nnHistory: slimHist } });
  for (const ws of wss.clients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  }
}

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'terrain', terrain, mapSize: MAP_SIZE }));
  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (!msg || typeof msg !== 'object' || Array.isArray(msg) || typeof msg.type !== 'string') return;
      switch (msg.type) {
        case 'speed': {
          const requestedSpeed = Number(msg.value);
          if (Number.isFinite(requestedSpeed)) simSpeed = Math.max(1, Math.min(1000, requestedSpeed));
          break;
        }
        case 'pause': paused = !paused; ws.send(JSON.stringify({ type: 'paused', paused })); break;
        case 'possess': {
          if (agents.length === 0) break;
          const best = agents.reduce((b, a) => agentFitness(a) > agentFitness(b) ? a : b, agents[0]);
          possessedId = best.id;
          ws.send(JSON.stringify({ type: 'possessed', agentId: possessedId }));
          break;
        }
        case 'possessId': {
          const requestedId = Number(msg.id);
          if (!Number.isSafeInteger(requestedId) || requestedId < 1) break;
          const target = agents.find(a => a.id === requestedId);
          if (target) { possessedId = target.id; ws.send(JSON.stringify({ type: 'possessed', agentId: possessedId })); }
          break;
        }
        case 'release': possessedId = null; possessedInput = { keys: {}, mouse: null }; break;
        case 'input': {
          const inputKeys = msg.keys && typeof msg.keys === 'object' && !Array.isArray(msg.keys) ? msg.keys : {};
          possessedInput = {
            keys: {
              w: inputKeys.w === true,
              s: inputKeys.s === true,
              a: inputKeys.a === true,
              d: inputKeys.d === true,
              e: inputKeys.e === true,
              r: inputKeys.r === true,
              ArrowUp: inputKeys.ArrowUp === true,
              ArrowDown: inputKeys.ArrowDown === true,
              ArrowLeft: inputKeys.ArrowLeft === true,
              ArrowRight: inputKeys.ArrowRight === true,
              ' ': inputKeys[' '] === true,
            },
            mouse: null,
          };
          break;
        }
        case 'catastrophe': {
          const killCount = Math.floor(agents.length * 0.7);
          const shuffled = [...agents].sort(() => Math.random() - 0.5);
          for (let i = 0; i < killCount; i++) {
            shuffled[i].alive = false;
            dropMeat(shuffled[i].x, shuffled[i].y, MAX_ENERGY * 0.3, 2);
            stats.totalDeaths++;
          }
          agents = agents.filter(a => a.alive);
          break;
        }
      }
    } catch {
      console.warn('Ignored invalid WebSocket message');
    }
  });
});

// ─── GAME LOOP ───────────────────────────────────────────────
function gameLoop() {
  try {
    if (paused) return;
    const pop = agents.length;
    const budget = pop > 1000 ? 30 : pop > 500 ? 100 : pop > 200 ? 300 : 1000;
    const maxTicks = Math.min(simSpeed, budget);
    for (let i = 0; i < maxTicks; i++) {
      tick();
      if (simSpeed <= 10 && tickCount % 20 === 0) broadcastState();
    }
    if (simSpeed > 10) broadcastState();
    if (Date.now() - lastSave > 120000) { saveState(); lastSave = Date.now(); }
  } catch(e) { console.error('Loop error:', e.message); }
}

// ─── INIT ────────────────────────────────────────────────────
function init() {
  generateTerrain();
  const loaded = loadState();
  if (!loaded) spawnInitialAgents(INITIAL_AGENTS);
  if (terrain.length === 0) generateTerrain();
  setInterval(gameLoop, Math.round(1000 / TICK_RATE));
  server.listen(PORT, HOST, () => {
    const address = server.address();
    console.log(`Evolution Simulator running on http://${HOST}:${address.port}`);
  });
}

init();
