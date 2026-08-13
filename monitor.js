#!/usr/bin/env node
'use strict';

const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

const LOG_FILE = path.join(__dirname, 'monitor_log.jsonl');
const CHECK_INTERVAL = 5 * 60 * 1000; // 5 minutes
const SERVER_URL = process.env.EVOLUTION_SERVER_URL || 'ws://127.0.0.1:3333';
let checkCount = 0;

function finiteMetric(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function singleLine(value) {
  return String(value).replace(/[\r\n\u001b]/g, ' ').slice(0, 500);
}

function check() {
  checkCount++;
  const ws = new WebSocket(SERVER_URL);
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
        const agentCount = finiteMetric(msg.agents ? msg.agents.length : s.population);
        const foodCount = finiteMetric(msg.food ? msg.food.length : s.foodCount);

        const entry = {
          time: new Date().toISOString(),
          check: checkCount,
          status: agentCount > 0 ? 'ALIVE' : 'EXTINCT',
          agents: agentCount,
          food: foodCount,
          maxGen: finiteMetric(s.maxGeneration),
          totalBorn: finiteMetric(s.totalBorn),
          totalDeaths: finiteMetric(s.totalDeaths),
          avgFitness: finiteMetric(s.avgFitness),
          topTier: finiteMetric(s.topTierAlive),
        };

        console.log(`[CHECK ${checkCount}] ${entry.status} | Agents: ${entry.agents} | Food: ${entry.food} | MaxGen: ${entry.maxGen} | TopTier: T${entry.topTier} | Born: ${entry.totalBorn} | Deaths: ${entry.totalDeaths}`);
        logEntry(entry);

        if (entry.status === 'EXTINCT') {
          console.log(`[CHECK ${checkCount}] POPULATION EXTINCT! Saving diagnostic data...`);
          logEntry({ ...entry, diagnosis: 'Population went extinct. Check energy balance, food density, and reproduction rate.' });
        }
      }
    } catch (e) {
      console.log(`[CHECK ${checkCount}] Parse error: ${singleLine(e.message)}`);
    }
    ws.close();
  });

  ws.on('error', (err) => {
    clearTimeout(timeout);
    const errorMessage = singleLine(err.message);
    console.log(`[CHECK ${checkCount}] Connection error: ${errorMessage}`);
    logEntry({ time: new Date().toISOString(), status: 'ERROR', check: checkCount, error: errorMessage });
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
