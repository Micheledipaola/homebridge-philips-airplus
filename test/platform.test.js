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

test('a new accessory is registered only after its services exist', async () => {
  const api = fakeApi();
  const p = new PhilipsAirPlusPlatform(log, { refreshToken: 'x' }, api);
  p.account.listDevices = async () => [{ uuid: 'abc', name: 'Camera', model: 'AC0651' }];
  const { PurifierAccessory } = require('../src/accessory');
  const origStart = PurifierAccessory.prototype.start;
  PurifierAccessory.prototype.start = function () {};
  let servicesAtRegister;
  api.registerPlatformAccessories = (pl, n, accs) => {
    servicesAtRegister = accs[0].services.map((s) => s.subtype || s.constructor.name);
    api.registered.push(...accs);
  };
  try {
    await p.discover();
  } finally {
    PurifierAccessory.prototype.start = origStart;
  }
  assert.equal(api.registered.length, 1);
  assert.ok(servicesAtRegister.includes('AirPurifier'));
  assert.ok(servicesAtRegister.includes('sleep'));
  assert.ok(servicesAtRegister.includes('filter'));
});

test('unknown model: registration waits for the device to report it', async () => {
  const api = fakeApi();
  const p = new PhilipsAirPlusPlatform(log, { refreshToken: 'x' }, api);
  p.account.listDevices = async () => [{ uuid: 'abc', name: 'Camera' }];
  const { PurifierAccessory } = require('../src/accessory');
  const origStart = PurifierAccessory.prototype.start;
  PurifierAccessory.prototype.start = function () {};
  try {
    await p.discover();
  } finally {
    PurifierAccessory.prototype.start = origStart;
  }
  assert.equal(api.registered.length, 0);
  const h = [...p.handlers.values()][0];
  h._onMessage({ cn: 'getPort', data: { portName: 'Config', properties: { ctn: 'AC0651/10' } } });
  assert.equal(api.registered.length, 1);
});
