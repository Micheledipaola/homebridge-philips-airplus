'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { hap, FakeMqttClient, fakeAccount, fakePlatform, newAccessory, tick } = require('./helpers');
const { PurifierAccessory } = require('../src/accessory');

const { Service, Characteristic } = hap;
const UUID = '11111111-2222-3333-4444-555555555555';

async function setup(model, config = {}) {
  let client;
  const platform = fakePlatform(config);
  const acc = newAccessory('Living Room', UUID, model);
  const dev = new PurifierAccessory(platform, acc, {
    account: fakeAccount(),
    mqttConnect: (url, opts) => (client = new FakeMqttClient(url, opts)),
  });
  dev.conn.start();
  await tick();
  await tick();
  return { dev, acc, platform, client: () => client };
}

const status = (props) => ({ cn: 'getPort', data: { portName: 'Status', properties: props } });

test('connects with the custom-authorizer headers and a distinct client id', async (t) => {
  const { dev, client } = await setup('AC0651/10');
  t.after(() => dev.stop());
  const c = client();
  assert.equal(c.url, 'wss://ats.prod.eu-da.iot.versuni.com:443/mqtt');
  assert.equal(c.opts.clientId, `01234567-89ab-cdef-0123-456789abcdef_${UUID}_hb`);
  assert.equal(c.opts.wsOptions.headers['x-amz-customauthorizer-signature'], 'SIG');
  assert.equal(c.opts.wsOptions.headers['token-header'], 'Bearer ACCESS');
  assert.deepEqual(c.subscribed, [`da_ctrl/da-${UUID}/from_ncp`]);
  // initial requests: Status, Config, filtRd + shadow get
  const ports = c.published.filter((p) => p.payload.cn === 'getPort').map((p) => p.payload.data.portName);
  assert.deepEqual(ports, ['Status', 'Config', 'filtRd']);
  assert.ok(c.published.some((p) => p.topic === `$aws/things/da-${UUID}/shadow/get`));
});

test('maps status to the HomeKit air purifier', async (t) => {
  const { dev, acc, client } = await setup('AC0651/10');
  t.after(() => dev.stop());
  client().deliver(status({ D0310D: 2, D0310C: 0, D03221: 8 }));
  const p = acc.getService(Service.AirPurifier);
  assert.equal(p.getCharacteristic(Characteristic.Active).value, 1);
  assert.equal(p.getCharacteristic(Characteristic.CurrentAirPurifierState).value, 2);
  assert.equal(p.getCharacteristic(Characteristic.TargetAirPurifierState).value, 1); // Auto
  const aq = acc.getService(Service.AirQualitySensor);
  assert.equal(aq.getCharacteristic(Characteristic.PM2_5Density).value, 8);
  assert.equal(aq.getCharacteristic(Characteristic.AirQuality).value, 1);

  client().deliver(status({ D0310C: 18, D03221: 60 })); // Turbo, bad air
  assert.equal(p.getCharacteristic(Characteristic.TargetAirPurifierState).value, 0); // Manual
  assert.equal(p.getCharacteristic(Characteristic.RotationSpeed).value, 3); // Turbo = notch 3 of 3
  assert.equal(aq.getCharacteristic(Characteristic.AirQuality).value, 4);

  client().deliver(status({ D0310D: 0 }));
  assert.equal(p.getCharacteristic(Characteristic.Active).value, 0);
  assert.equal(p.getCharacteristic(Characteristic.CurrentAirPurifierState).value, 0);
});

test('handles concatenated JSON payloads in one frame', async (t) => {
  const { dev, acc, client } = await setup('AC0651/10');
  t.after(() => dev.stop());
  client().deliver(JSON.stringify(status({ D0310D: 2 })) + JSON.stringify(status({ D0310C: 17 })));
  const p = acc.getService(Service.AirPurifier);
  assert.equal(p.getCharacteristic(Characteristic.Active).value, 1);
  assert.equal(p.getCharacteristic(Characteristic.RotationSpeed).value, 1); // Sleep = notch 1 of 3
});

test('HomeKit commands become the same MQTT commands the app sends', async (t) => {
  const { dev, acc, client } = await setup('AC0651/10');
  t.after(() => dev.stop());
  const c = client();
  c.deliver(status({ D0310D: 0, D0310C: 0 }));
  const p = acc.getService(Service.AirPurifier);
  c.published.length = 0;

  await p.getCharacteristic(Characteristic.Active).handleSetRequest(1);
  assert.deepEqual(c.published[0], { topic: `$aws/things/da-${UUID}/shadow/update`, payload: { state: { desired: { powerOn: true } } } });

  c.published.length = 0;
  await p.getCharacteristic(Characteristic.RotationSpeed).handleSetRequest(2); // Sleep, Medium, Turbo -> Medium
  const set = c.published.find((x) => x.payload.cn === 'setPort');
  assert.equal(set.topic, `da_ctrl/da-${UUID}/to_ncp`);
  assert.equal(set.payload.ct, 'mobile');
  assert.equal(set.payload.type, 'command');
  assert.deepEqual(set.payload.data, { portName: 'Control', properties: { D0310C: 1 } });

  c.published.length = 0;
  await p.getCharacteristic(Characteristic.TargetAirPurifierState).handleSetRequest(1);
  assert.deepEqual(c.published.find((x) => x.payload.cn === 'setPort').payload.data.properties, { D0310C: 0 });

  // back to manual restores the last manual speed (Medium)
  c.published.length = 0;
  await p.getCharacteristic(Characteristic.TargetAirPurifierState).handleSetRequest(0);
  assert.deepEqual(c.published.find((x) => x.payload.cn === 'setPort').payload.data.properties, { D0310C: 1 });
});

test('filters: life level, change alert and reset', async (t) => {
  const { dev, acc, client } = await setup('AC0651/10');
  t.after(() => dev.stop());
  const c = client();
  c.deliver({ cn: 'getPort', data: { portName: 'filtRd', properties: { D05408: 4800, D0540E: 240, D05207: 720, D0520D: 360 } } });
  const main = acc.getServiceById(Service.FilterMaintenance, 'filter');
  const pre = acc.getServiceById(Service.FilterMaintenance, 'prefilter');
  assert.equal(main.getCharacteristic(Characteristic.FilterLifeLevel).value, 5);
  assert.equal(main.getCharacteristic(Characteristic.FilterChangeIndication).value, 1);
  assert.equal(pre.getCharacteristic(Characteristic.FilterLifeLevel).value, 50);
  assert.equal(pre.getCharacteristic(Characteristic.FilterChangeIndication).value, 0);

  c.published.length = 0;
  await main.getCharacteristic(Characteristic.ResetFilterIndication).handleSetRequest(1);
  assert.deepEqual(c.published[0].payload.data, { portName: 'filtWr', properties: { D0540E: 4800 } });
  assert.equal(c.published[1].payload.data.portName, 'filtRd');
});

test('model is learned from the Config port and cached', async (t) => {
  const { dev, acc, platform, client } = await setup(undefined);
  t.after(() => dev.stop());
  assert.equal(acc.getService(Service.AirPurifier), undefined);
  client().deliver({ cn: 'getPort', data: { portName: 'Config', properties: { ctn: 'AC3221/10' } } });
  assert.equal(acc.context.model, 'AC3221/10');
  assert.ok(platform.updated.includes(acc));
  const p = acc.getService(Service.AirPurifier);
  assert.ok(p);
  // Sleep, Speed1..5, Medium, Turbo = 8 manual speeds
  assert.equal(dev.speeds.length, 8);
  assert.equal(dev.speeds[0], 'Sleep');
  assert.equal(dev.speeds.at(-1), 'Turbo');
});

test('unknown model still gets power, PM2.5 and filters', async (t) => {
  const { dev, acc, client } = await setup('AC9999/10');
  t.after(() => dev.stop());
  client().deliver(status({ D0310D: 2, D03221: 20 }));
  const p = acc.getService(Service.AirPurifier);
  assert.equal(p.getCharacteristic(Characteristic.Active).value, 1);
  assert.equal(p.testCharacteristic(Characteristic.RotationSpeed), false);
  assert.equal(acc.getService(Service.AirQualitySensor).getCharacteristic(Characteristic.AirQuality).value, 2);
});

test('commands fail with a HomeKit "no response" when offline', async (t) => {
  const { dev, acc } = await setup('AC0650/10');
  t.after(() => dev.stop());
  dev.conn.connected = false;
  const p = acc.getService(Service.AirPurifier);
  await assert.rejects(p.getCharacteristic(Characteristic.Active).handleSetRequest(1));
});

test('options can hide the extra services', async (t) => {
  const { dev, acc } = await setup('AC0651/10', { airQualitySensor: false, filterSensors: false });
  t.after(() => dev.stop());
  assert.equal(acc.getService(Service.AirQualitySensor), undefined);
  assert.equal(acc.getService(Service.FilterMaintenance), undefined);
});
