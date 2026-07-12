#!/usr/bin/env node
'use strict';

const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

const LOG_FILE = path.join(__dirname, 'monitor_log.jsonl');
const CHECK_INTERVAL = 5 * 60 * 1000; // 5 minutes
let checkCount = 0;

function check() {
  checkCount++;
  const ws = new WebSocket('ws://localhost:3333');
  let timeout = setTimeout(() => {
    console.log(`[CHECK ${checkCount}] Server not responding`);
    ws.close();
    logEntry({ time: new Date().toISOString(), status: 'NO_RESPONSE', check: checkCount });
  }, 5000);

  ws.on('open', () => {
    // Wait for first state message
  });

  ws.on('message', (data) => {
    clearTimeout(timeout);
    try {
      const msg = JSON.parse(data);
      if (msg.type === 'state' || msg.type === 'stats') {
        const s = msg.stats || {};
        const agentCount = msg.agents ? msg.agents.length : (s.population || 0);
        const foodCount = msg.food ? msg.food.length : (s.foodCount || 0);

        const entry = {
          time: new Date().toISOString(),
          check: checkCount,
          status: agentCount > 0 ? 'ALIVE' : 'EXTINCT',
          agents: agentCount,
          food: foodCount,
          maxGen: s.maxGen || 0,
          totalBorn: s.totalBorn || 0,
          totalDeaths: s.totalDeaths || 0,
          avgFitness: Math.round(s.avgFitness || 0),
        };

        console.log(`[CHECK ${checkCount}] ${entry.status} | Agents: ${entry.agents} | Food: ${entry.food} | MaxGen: ${entry.maxGen} | Born: ${entry.totalBorn} | Deaths: ${entry.totalDeaths}`);
        logEntry(entry);

        if (entry.status === 'EXTINCT') {
          console.log(`[CHECK ${checkCount}] POPULATION EXTINCT! Saving diagnostic data...`);
          logEntry({ ...entry, diagnosis: 'Population went extinct. Check energy balance, food density, and reproduction rate.' });
        }
      }
    } catch (e) {
      console.log(`[CHECK ${checkCount}] Parse error: ${e.message}`);
    }
    ws.close();
  });

  ws.on('error', (err) => {
    clearTimeout(timeout);
    console.log(`[CHECK ${checkCount}] Connection error: ${err.message}`);
    logEntry({ time: new Date().toISOString(), status: 'ERROR', check: checkCount, error: err.message });
  });
}

function logEntry(entry) {
  fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n');
}

console.log(`[MONITOR] Starting — checking every 5 minutes`);
console.log(`[MONITOR] Log file: ${LOG_FILE}`);

// First check immediately
check();

// Then every 5 minutes
setInterval(check, CHECK_INTERVAL);
