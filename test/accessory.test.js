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
  assert.equal(p.getCharacteristic(Characteristic.RotationSpeed).value, 100); // Turbo = top band
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
  assert.equal(p.getCharacteristic(Characteristic.RotationSpeed).value, 33); // Sleep = first of 3 bands
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
  await p.getCharacteristic(Characteristic.RotationSpeed).handleSetRequest(15); // ~15% -> first band (Sleep)
  assert.deepEqual(c.published.find((x) => x.payload.cn === 'setPort').payload.data.properties, { D0310C: 17 });
  c.published.length = 0;
  await p.getCharacteristic(Characteristic.RotationSpeed).handleSetRequest(60); // Sleep, Medium, Turbo -> Medium
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
  const { dev, acc, client } = await setup(undefined);
  t.after(() => dev.stop());
  client().deliver({ cn: 'getPort', data: { portName: 'Config', properties: { ctn: 'AC9999/10' } } });
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

test('Sleep switch sets and leaves Sleep mode', async (t) => {
  const { dev, acc, client } = await setup('AC0651/10');
  t.after(() => dev.stop());
  const c = client();
  c.deliver(status({ D0310D: 2, D0310C: 0 }));
  const sw = acc.getServiceById(Service.Switch, 'sleep');
  assert.equal(sw.getCharacteristic(Characteristic.On).value, false);
  c.published.length = 0;
  await sw.getCharacteristic(Characteristic.On).handleSetRequest(true);
  assert.deepEqual(c.published.find((x) => x.payload.cn === 'setPort').payload.data.properties, { D0310C: 17 });
  c.deliver(status({ D0310C: 17 }));
  assert.equal(sw.getCharacteristic(Characteristic.On).value, true);
  c.published.length = 0;
  await sw.getCharacteristic(Characteristic.On).handleSetRequest(false);
  assert.deepEqual(c.published.find((x) => x.payload.cn === 'setPort').payload.data.properties, { D0310C: 0 }); // back to Auto
});

test('display light appears once reported; percentage scheme', async (t) => {
  const { dev, acc, client } = await setup('AC0651/10');
  t.after(() => dev.stop());
  const c = client();
  assert.equal(acc.getServiceById(Service.Lightbulb, 'display'), undefined);
  c.deliver(status({ D0310D: 2, D03105: 100 }));
  const l = acc.getServiceById(Service.Lightbulb, 'display');
  assert.ok(l);
  assert.equal(l.getCharacteristic(Characteristic.On).value, true);
  assert.equal(l.getCharacteristic(Characteristic.Brightness).value, 100);
  c.published.length = 0;
  await l.getCharacteristic(Characteristic.Brightness).handleSetRequest(40);
  assert.deepEqual(c.published[0].payload.data, { portName: 'Control', properties: { D03105: 40 } });
  await l.getCharacteristic(Characteristic.On).handleSetRequest(false);
  assert.deepEqual(c.published.filter((x) => x.payload.cn === 'setPort').at(-1).payload.data.properties, { D03105: 0 });
  await l.getCharacteristic(Characteristic.On).handleSetRequest(true);
  assert.deepEqual(c.published.filter((x) => x.payload.cn === 'setPort').at(-1).payload.data.properties, { D03105: 40 });
});

test('display light: three-step scheme is learned from values above 100', async (t) => {
  const { dev, acc, client } = await setup('AC0651/10');
  t.after(() => dev.stop());
  const c = client();
  c.deliver(status({ D0310D: 2, D03105: 123 }));
  const l = acc.getServiceById(Service.Lightbulb, 'display');
  assert.equal(l.getCharacteristic(Characteristic.Brightness).value, 100);
  c.published.length = 0;
  await l.getCharacteristic(Characteristic.Brightness).handleSetRequest(30);
  assert.deepEqual(c.published[0].payload.data.properties, { D03105: 115 });
  c.deliver(status({ D03105: 115 }));
  assert.equal(l.getCharacteristic(Characteristic.Brightness).value, 50);
});

test('secondary services are linked to the purifier with short labels', async (t) => {
  const { dev, acc, client } = await setup('AC0651/10');
  t.after(() => dev.stop());
  client().deliver(status({ D0310D: 2, D03105: 100 }));
  const p = acc.getService(Service.AirPurifier);
  const sw = acc.getServiceById(Service.Switch, 'sleep');
  const light = acc.getServiceById(Service.Lightbulb, 'display');
  for (const [svc, label] of [[sw, 'Sleep'], [light, 'Display'], [acc.getService(Service.AirQualitySensor), 'Air Quality'], [acc.getServiceById(Service.FilterMaintenance, 'filter'), 'Filter']]) {
    assert.ok(p.linkedServices.includes(svc), label);
    assert.equal(svc.getCharacteristic(Characteristic.Name).value, label);
    assert.equal(svc.getCharacteristic(Characteristic.ConfiguredName).value, label);
  }
  assert.equal(p.isPrimaryService, true);
});

test('labels from older versions are migrated once, later renames are kept', async (t) => {
  const { hap: h, FakeMqttClient: F, fakeAccount: fa, fakePlatform: fp, newAccessory: na, tick: tk } = require('./helpers');
  const acc = na('Living Room', UUID, 'AC0651/10');
  const old = acc.addService(h.Service.Switch, 'Living Room Sleep', 'sleep');
  old.setCharacteristic(h.Characteristic.ConfiguredName, 'Living Room Sleep');
  let dev = new PurifierAccessory(fp(), acc, { account: fa(), mqttConnect: (u, o) => new F(u, o) });
  assert.equal(old.getCharacteristic(h.Characteristic.ConfiguredName).value, 'Sleep');
  dev.stop();
  old.setCharacteristic(h.Characteristic.ConfiguredName, 'Notte');
  dev = new PurifierAccessory(fp(), acc, { account: fa(), mqttConnect: (u, o) => new F(u, o) });
  t.after(() => dev.stop());
  await tk();
  assert.equal(old.getCharacteristic(h.Characteristic.ConfiguredName).value, 'Notte');
});

test('display light property can be set by hand', async (t) => {
  const { dev, acc, client } = await setup('AC0651/10', { displayLightProperty: 'D03199' });
  t.after(() => dev.stop());
  const l = acc.getServiceById(Service.Lightbulb, 'display');
  assert.ok(l, 'light exists before any report');
  const c = client();
  c.published.length = 0;
  await l.getCharacteristic(Characteristic.Brightness).handleSetRequest(50);
  assert.deepEqual(c.published[0].payload.data.properties, { D03199: 50 });
});

test('display light on D03104 with the 0/115/123 scheme', async (t) => {
  const { dev, acc, client } = await setup('AC0650/10');
  t.after(() => dev.stop());
  const c = client();
  c.deliver(status({ D0310D: 2, D03104: 115 }));
  const l = acc.getServiceById(Service.Lightbulb, 'display');
  assert.ok(l);
  assert.equal(l.getCharacteristic(Characteristic.Brightness).value, 50);
  c.published.length = 0;
  await l.getCharacteristic(Characteristic.Brightness).handleSetRequest(90);
  assert.deepEqual(c.published[0].payload.data.properties, { D03104: 123 });
});

test('logDeviceData asks for all ports and the shadow, then reads each port', async (t) => {
  const { dev, client } = await setup('AC0651/10', { logDeviceData: true });
  t.after(() => dev.stop());
  const c = client();
  await new Promise((r) => setTimeout(r, 2200));
  assert.ok(c.published.some((p) => p.payload.cn === 'getAllPorts'));
  assert.ok(c.subscribed.some((s) => s.endsWith('/shadow/get/accepted')));
  c.published.length = 0;
  c.deliver({ cn: 'getAllPorts', data: [{ portName: 'Status' }, { portName: 'Display' }] });
  await new Promise((r) => setTimeout(r, 500));
  const asked = c.published.filter((p) => p.payload.cn === 'getPort').map((p) => p.payload.data.portName);
  assert.ok(asked.includes('Display'));
});

test('Sleep can be shown as a second air purifier service', async (t) => {
  const { dev, acc, client } = await setup('AC0651/10', { sleepSwitchStyle: 'purifier' });
  t.after(() => dev.stop());
  const c = client();
  c.deliver(status({ D0310D: 2, D0310C: 0 }));
  const main = acc.services.find((s) => s.UUID === Service.AirPurifier.UUID && !s.subtype);
  const sleep = acc.getServiceById(Service.AirPurifier, 'sleep');
  assert.ok(sleep && main && sleep !== main);
  assert.equal(acc.getServiceById(Service.Switch, 'sleep'), undefined);
  assert.equal(main.isPrimaryService, true);
  assert.ok(main.linkedServices.includes(sleep));
  assert.equal(sleep.getCharacteristic(Characteristic.Active).value, 0);
  c.published.length = 0;
  await sleep.getCharacteristic(Characteristic.Active).handleSetRequest(1);
  assert.deepEqual(c.published.find((x) => x.payload.cn === 'setPort').payload.data.properties, { D0310C: 17 });
  c.deliver(status({ D0310C: 17 }));
  assert.equal(sleep.getCharacteristic(Characteristic.Active).value, 1);
  assert.equal(sleep.getCharacteristic(Characteristic.CurrentAirPurifierState).value, 2);
  assert.equal(main.getCharacteristic(Characteristic.Active).value, 1);
  c.published.length = 0;
  await sleep.getCharacteristic(Characteristic.Active).handleSetRequest(0);
  assert.deepEqual(c.published.find((x) => x.payload.cn === 'setPort').payload.data.properties, { D0310C: 0 });
});

test('short cloud model code gets the full profile without a warning', async (t) => {
  const warnings = [];
  const { hap: h, FakeMqttClient: F, fakeAccount: fa, fakePlatform: fp, newAccessory: na, tick: tk } = require('./helpers');
  const platform = fp();
  platform.log = { ...platform.log, warn: (m) => warnings.push(m) };
  const acc = na('Camera', UUID, 'AC0651');
  let client;
  const dev = new PurifierAccessory(platform, acc, { account: fa(), mqttConnect: (u, o) => (client = new F(u, o)) });
  t.after(() => dev.stop());
  assert.equal(dev.model.key, 'AC0651/10');
  assert.equal(dev.speeds.length, 3);
  dev.conn.start();
  await tk(); await tk();
  client.deliver({ cn: 'getPort', data: { portName: 'Config', properties: { ctn: 'AC0651/10' } } });
  assert.equal(acc.context.model, 'AC0651/10');
  assert.deepEqual(warnings, []);
  assert.ok(acc.getService(h.Service.AirPurifier).testCharacteristic(h.Characteristic.RotationSpeed));
});

test('unknown cached model waits for the device instead of the fallback', async (t) => {
  const { fakeAccount: fa, fakePlatform: fp, newAccessory: na, FakeMqttClient: F } = require('./helpers');
  const acc = na('X', UUID, 'ZZ9999');
  const dev = new PurifierAccessory(fp(), acc, { account: fa(), mqttConnect: (u, o) => new F(u, o) });
  t.after(() => dev.stop());
  assert.equal(dev.model, null);
});

test('watchdog reconnects when the device goes silent', async (t) => {
  const { dev, client } = await setup('AC0651/10', { pollInterval: 30 });
  t.after(() => dev.stop());
  let reconnects = 0;
  dev.conn.reconnect = () => { reconnects++; };
  dev.conn.lastMessageAt = Date.now() - 7 * 60 * 1000;
  // run one poll tick by hand
  dev.start = PurifierAccessory.prototype.start;
  const realSetInterval = global.setInterval;
  let tickFn;
  global.setInterval = (fn) => { if (!tickFn) tickFn = fn; return 0; };
  try { dev.start(); } finally { global.setInterval = realSetInterval; }
  await tickFn();
  assert.equal(reconnects, 1);
  // fresh data: no reconnect, a status request instead
  client().published.length = 0;
  dev.conn.lastMessageAt = Date.now();
  await tickFn();
  assert.equal(reconnects, 1);
  assert.ok(client().published.some((p) => p.payload.cn === 'getPort' && p.payload.data.portName === 'Status'));
});

test('labelRefresh renames components long then short, once per value', async (t) => {
  const { hap: h, FakeMqttClient: F, fakeAccount: fa, fakePlatform: fp, newAccessory: na } = require('./helpers');
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const platform = fp({ labelRefresh: '1', sleepSwitchStyle: 'purifier' });
  const acc = na('Camera', UUID, 'AC0651/10');
  const dev = new PurifierAccessory(platform, acc, { account: fa(), mqttConnect: (u, o) => new F(u, o) });
  t.after(() => dev.stop());
  dev.start();
  const aq = acc.getService(h.Service.AirQualitySensor);
  const sleep = acc.getServiceById(h.Service.AirPurifier, 'sleep');
  const main = acc.services.find((x) => x.UUID === h.Service.AirPurifier.UUID && !x.subtype);
  const seen = [];
  aq.getCharacteristic(h.Characteristic.ConfiguredName).on('change', (e) => seen.push(e.newValue));
  t.mock.timers.tick(20000);
  assert.equal(aq.getCharacteristic(h.Characteristic.ConfiguredName).value, 'Camera Air Quality');
  assert.equal(sleep.getCharacteristic(h.Characteristic.Name).value, 'Camera Sleep');
  assert.equal(main.getCharacteristic(h.Characteristic.ConfiguredName).value, 'Camera');
  t.mock.timers.tick(20000);
  assert.equal(aq.getCharacteristic(h.Characteristic.ConfiguredName).value, 'Air Quality');
  assert.equal(sleep.getCharacteristic(h.Characteristic.ConfiguredName).value, 'Sleep');
  assert.deepEqual(seen, ['Camera Air Quality', 'Air Quality']);
  assert.equal(acc.context.labelRefresh, '1');
  // same value again: nothing happens
  dev.stop();
  const dev2 = new PurifierAccessory(platform, acc, { account: fa(), mqttConnect: (u, o) => new F(u, o) });
  dev2.start();
  t.mock.timers.tick(40000);
  assert.deepEqual(seen, ['Camera Air Quality', 'Air Quality']);
  dev2.stop();
});
