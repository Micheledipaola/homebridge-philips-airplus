'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cloud = require('../src/cloud');
const { Account } = require('../src/account');
const { parseConcatenatedJson } = require('../src/connection');
const { findModel, speedModes } = require('../src/models');
const { quiet } = require('./helpers');

function res(status, body, headers = {}) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers });
}

test('email login: OTP, prompt=none authorize, code exchange, device list', async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const u = new URL(url);
    if (u.pathname.endsWith('otp.email.sendCode')) return res(200, { errorCode: 0, vToken: 'VT' });
    if (u.pathname.endsWith('otp.email.login')) return res(200, { errorCode: 0, sessionInfo: { cookieValue: 'SESSION' } }, { 'set-cookie': 'glt=abc; Path=/' });
    if (u.pathname.endsWith('/authorize')) return res(302, '', { location: 'https://cdc.accounts.home.id/pages/proxy?context=CTX' });
    if (u.pathname.endsWith('socialize.getIDs')) return res(200, { gmidTicket: 'GMID' });
    if (u.pathname.endsWith('/authorize/continue')) return res(302, '', { location: 'com.philips.air://loginredirect?code=AUTHCODE&state=x' });
    if (u.pathname.endsWith('/token')) return res(200, { access_token: 'AT', refresh_token: 'RT', expires_in: 3600 });
    if (u.pathname.endsWith('/user/self/device')) return res(200, { devices: [{ uuid: 'da-abc', name: 'Bedroom', ctn: 'AC1715/11' }] });
    if (u.pathname.endsWith('/user/self')) return res(200, { id: 'USER' });
    return res(404, 'nope');
  };

  const s = new cloud.LoginSession({ fetchImpl });
  await s.sendCode(' me@example.com ');
  await s.verifyCode('123456');
  const r = await s.completeLogin();

  assert.equal(r.refreshToken, 'RT');
  assert.equal(r.clientId, '-XsK7O6iEkLml77yDGDUi0ku');
  assert.equal(r.userId, 'USER');
  assert.deepEqual(r.devices, [{ uuid: 'da-abc', name: 'Bedroom', model: 'AC1715/11' }]);

  const authorize = new URL(calls.find((c) => c.url.includes('/authorize?')).url);
  assert.equal(authorize.searchParams.get('prompt'), 'none');
  assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256');
  const cont = new URL(calls.find((c) => c.url.includes('/authorize/continue')).url);
  assert.equal(cont.searchParams.get('login_token'), 'SESSION');
  assert.equal(cont.searchParams.get('gmidTicket'), 'GMID');
  assert.equal(cont.searchParams.get('context'), 'CTX');
  // cookie from the Gigya host is sent back to the same host
  assert.match(calls.find((c) => c.url.includes('/authorize?')).init.headers.Cookie, /glt=abc/);
  const tokenBody = new URLSearchParams(calls.find((c) => c.url.endsWith('/token')).init.body);
  assert.equal(tokenBody.get('code'), 'AUTHCODE');
  assert.ok(tokenBody.get('code_verifier').length >= 43);
});

test('login reports Gigya errors clearly', async () => {
  const s = new cloud.LoginSession({ fetchImpl: async () => res(200, { errorCode: 206001 }) });
  s.vToken = 'x';
  s.email = 'a@b.c';
  await assert.rejects(s.verifyCode('1'), /not a fully registered/);
});

test('refresh: rotating refresh token is persisted and reused after restart', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'airplus-'));
  let n = 0;
  const fetchImpl = async (url, init) => {
    const body = new URLSearchParams(init.body);
    assert.equal(body.get('grant_type'), 'refresh_token');
    n++;
    return res(200, { access_token: `AT${n}`, refresh_token: `RT${n}`, expires_in: 3600 });
  };
  const a = new Account({ refreshToken: 'SEED', storageDir: dir, log: quiet, fetchImpl });
  assert.equal(await a.ensureToken(), true);
  assert.equal(a.accessToken, 'AT1');
  assert.equal(await a.ensureToken(), false); // still valid

  const b = new Account({ refreshToken: 'SEED', storageDir: dir, log: quiet, fetchImpl });
  assert.equal(b.refreshToken, 'RT1');
  assert.equal(b.accessToken, 'AT1');

  // a fresh login (new seed in config) wins over the cache
  const c = new Account({ refreshToken: 'NEWSEED', storageDir: dir, log: quiet, fetchImpl });
  assert.equal(c.refreshToken, 'NEWSEED');
});

test('refresh: revoked token raises AuthExpiredError', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'airplus-'));
  const a = new Account({ refreshToken: 'S', storageDir: dir, log: quiet, fetchImpl: async () => res(400, '{"error":"invalid_grant"}') });
  await assert.rejects(a.ensureToken(), cloud.AuthExpiredError);
  assert.equal(a.expired, true);
});

test('client id matches the HA scheme with its own suffix', () => {
  assert.equal(
    cloud.buildClientId('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', 'da-11111111-2222-3333-4444-555555555555'),
    'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee_11111111-2222-3333-4444-555555555555_hb',
  );
  assert.equal(cloud.buildClientId('weird', 'abc'), 'client-abc_hb');
});

test('concatenated JSON parsing keeps braces inside strings intact', () => {
  const out = parseConcatenatedJson('{"a":"}{"} \n{"b":{"c":1}}');
  assert.deepEqual(out, [{ a: '}{' }, { b: { c: 1 } }]);
});

test('models.yaml is shared with the HA integration', () => {
  assert.equal(findModel('AC0651/10').modes.Auto, 0);
  assert.equal(findModel('AC3221/10').key, 'AC3221');
  assert.equal(findModel('nope'), null);
  assert.deepEqual(speedModes(findModel('AC1715/11')), ['Sleep', 'Medium', 'Fast', 'Turbo']);
  assert.deepEqual(speedModes(findModel('AC0650/10')), ['Sleep', 'Turbo']);
});
