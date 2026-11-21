'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const { fork } = require('node:child_process');

const SERVER = path.join(__dirname, '..', 'homebridge-ui', 'server.js');
const MOCK = path.join(__dirname, 'fixtures', 'mock-cloud.js');

/** Start the settings-panel server as Homebridge UI does (child process + IPC). */
function startServer(env = {}) {
  const child = fork(SERVER, [], {
    execArgv: ['--require', MOCK],
    env: { ...process.env, HOMEBRIDGE_STORAGE_PATH: os.tmpdir(), ...env },
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  });
  let id = 0;
  const waiting = new Map();
  const ready = new Promise((resolve) => {
    child.on('message', (m) => {
      if (m.action === 'ready') resolve();
      const r = m.action === 'response' && m.payload;
      if (r && waiting.has(r.requestId)) {
        waiting.get(r.requestId)(r);
        waiting.delete(r.requestId);
      }
    });
  });
  const request = (p, body) =>
    new Promise((resolve) => {
      id += 1;
      waiting.set(id, resolve);
      child.send({ action: 'request', requestId: id, path: p, body });
    });
  return { child, ready, request, stop: () => child.kill() };
}

test('login still works if the panel server restarts between "Send code" and "Log in"', async (t) => {
  const first = startServer();
  t.after(() => first.stop());
  await first.ready;
  const sent = await first.request('/send-code', { email: 'me@example.com' });
  assert.equal(sent.success, true, JSON.stringify(sent));
  assert.equal(sent.data.vToken, 'VT-123');
  first.stop(); // the page reloads while the user reads the email

  const second = startServer();
  t.after(() => second.stop());
  await second.ready;
  const r = await second.request('/verify-code', { code: '111222', email: sent.data.email, vToken: sent.data.vToken });
  assert.equal(r.success, true, JSON.stringify(r));
  assert.equal(r.data.refreshToken, 'RT');
  assert.equal(r.data.devices[0].uuid, 'da-abc');
});

test('without the pending request the panel still asks for a new code', async (t) => {
  const s = startServer();
  t.after(() => s.stop());
  await s.ready;
  const r = await s.request('/verify-code', { code: '111222' });
  assert.equal(r.success, false);
  assert.match(JSON.stringify(r.data), /Request a new code first/);
});

test('a failing /user/self does not fail the login', async (t) => {
  const s = startServer({ MOCK_USER_SELF: '403' });
  t.after(() => s.stop());
  await s.ready;
  const sent = await s.request('/send-code', { email: 'me@example.com' });
  const r = await s.request('/verify-code', { code: '111222', email: sent.data.email, vToken: sent.data.vToken });
  assert.equal(r.success, true, JSON.stringify(r));
  assert.equal(r.data.refreshToken, 'RT');
  assert.equal(r.data.userId, null);
});
