'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');
const WebSocket = require('ws');

const ROOT = path.resolve(__dirname, '..');
let serverProcess;
let port;

function request(pathname, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: '127.0.0.1',
      port,
      path: pathname,
      headers: { Host: `127.0.0.1:${port}`, ...headers },
    }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve({
        statusCode: response.statusCode,
        headers: response.headers,
        body,
      }));
    });
    request.on('error', reject);
    request.end();
  });
}

function connectWebSocket(origin) {
  return new Promise((resolve, reject) => {
    const options = origin ? { origin } : {};
    const socket = new WebSocket(`ws://127.0.0.1:${port}`, options);
    const timeout = setTimeout(() => {
      socket.terminate();
      reject(new Error('WebSocket connection timed out'));
    }, 5000);

    socket.once('message', (raw) => {
      clearTimeout(timeout);
      const message = JSON.parse(raw);
      socket.close();
      resolve(message);
    });
    socket.once('unexpected-response', (_request, response) => {
      clearTimeout(timeout);
      socket.terminate();
      resolve({ rejectedStatus: response.statusCode });
    });
    socket.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

test.before(async () => {
  serverProcess = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, HOST: '127.0.0.1', PORT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  port = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Server startup timed out')), 10000);
    let stderr = '';

    serverProcess.stderr.on('data', (chunk) => { stderr += chunk; });
    serverProcess.once('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`Server exited with code ${code}: ${stderr}`));
    });
    serverProcess.stdout.on('data', (chunk) => {
      const match = chunk.toString().match(/127\.0\.0\.1:(\d+)/);
      if (!match) return;
      clearTimeout(timeout);
      resolve(Number(match[1]));
    });
  });
});

test.after(async () => {
  if (!serverProcess || serverProcess.exitCode !== null) return;
  serverProcess.kill('SIGTERM');
  await new Promise((resolve) => serverProcess.once('exit', resolve));
});

test('serves the app to a loopback host with security headers', async () => {
  const response = await request('/');

  assert.equal(response.statusCode, 200);
  assert.match(response.body, /Evolution/);
  assert.equal(response.headers['x-content-type-options'], 'nosniff');
  assert.equal(response.headers['x-frame-options'], 'DENY');
  assert.match(response.headers['content-security-policy'], /frame-ancestors 'none'/);
});

test('rejects untrusted Host headers', async () => {
  const response = await request('/', { Host: 'attacker.example' });

  assert.equal(response.statusCode, 421);
});

test('does not serve arbitrary repository files', async () => {
  const direct = await request('/package.json');
  const traversal = await request('/%2e%2e/package.json');

  assert.equal(direct.statusCode, 404);
  assert.equal(traversal.statusCode, 404);
  assert.doesNotMatch(direct.body, /"dependencies"/);
  assert.doesNotMatch(traversal.body, /"dependencies"/);
});

test('accepts a non-browser WebSocket monitor connection', async () => {
  const message = await connectWebSocket();

  assert.equal(message.type, 'terrain');
});

test('rejects WebSocket connections from foreign browser origins', async () => {
  const result = await connectWebSocket('https://attacker.example');

  assert.equal(result.rejectedStatus, 403);
});
