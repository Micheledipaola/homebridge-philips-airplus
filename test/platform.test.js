'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const { hap } = require('./helpers');
const { PlatformAccessory } = require('homebridge/lib/platformAccessory');
const { PhilipsAirPlusPlatform } = require('../src/platform');

function fakeApi() {
  const api = {
    hap,
    platformAccessory: PlatformAccessory,
    user: { storagePath: () => os.tmpdir() },
    registered: [],
    unregistered: [],
    on() {},
    registerPlatformAccessories: (p, n, accs) => api.registered.push(...accs),
    unregisterPlatformAccessories: (p, n, accs) => api.unregistered.push(...accs),
    updatePlatformAccessories() {},
  };
  return api;
}
const log = { info() {}, warn() {}, error() {}, debug() {} };

test('homekitIdentity gives a new accessory UUID and removes the old one', async () => {
  const dev = { uuid: 'abc', name: 'Camera', model: 'AC0651/10' };
  const api = fakeApi();
  const p = new PhilipsAirPlusPlatform(log, { refreshToken: 'x', homekitIdentity: '2' }, api);
  const oldAcc = new PlatformAccessory('Camera', hap.uuid.generate('PhilipsAirPlus:abc'));
  oldAcc.context.uuid = 'abc';
  p.configureAccessory(oldAcc);
  p.account.listDevices = async () => [dev];
  const { PurifierAccessory } = require('../src/accessory');
  const origStart = PurifierAccessory.prototype.start;
  PurifierAccessory.prototype.start = function () {};
  try {
    await p.discover();
  } finally {
    PurifierAccessory.prototype.start = origStart;
  }
  assert.equal(api.registered.length, 1);
  assert.equal(api.registered[0].UUID, hap.uuid.generate('PhilipsAirPlus:abc:2'));
  assert.notEqual(api.registered[0].UUID, oldAcc.UUID);
  assert.deepEqual(api.unregistered, [oldAcc]);
});
