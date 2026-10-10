'use strict';

const { EventEmitter } = require('node:events');
const hap = require('hap-nodejs');
const { PlatformAccessory } = require('homebridge/lib/platformAccessory');

const quiet = { info() {}, warn() {}, error() {}, debug() {} };

/** Stands in for an mqtt.js client: records publishes and lets tests inject messages. */
class FakeMqttClient extends EventEmitter {
  constructor(url, opts) {
    super();
    this.url = url;
    this.opts = opts;
    this.published = [];
    this.subscribed = [];
    setImmediate(() => this.emit('connect'));
  }
  subscribe(topic) {
    this.subscribed.push(topic);
  }
  publish(topic, payload) {
    this.published.push({ topic, payload: JSON.parse(payload) });
  }
  end() {}
  deliver(obj) {
    this.emit('message', 'da_ctrl/x/from_ncp', Buffer.from(typeof obj === 'string' ? obj : JSON.stringify(obj)));
  }
}

function fakeAccount() {
  return {
    accessToken: 'ACCESS',
    async ensureToken() {
      return false;
    },
    async getSignature() {
      return 'SIG';
    },
    async getUserId() {
      return '0123456789abcdef0123456789abcdef';
    },
  };
}

function fakePlatform(config = {}) {
  const updated = [];
  return {
    log: quiet,
    config,
    api: { hap, updatePlatformAccessories: (a) => updated.push(...a) },
    updateAccessory(a) {
      updated.push(a);
    },
    updated,
  };
}

function newAccessory(name, uuid, model) {
  const acc = new PlatformAccessory(name, hap.uuid.generate(uuid));
  acc.context.uuid = uuid;
  if (model) acc.context.model = model;
  return acc;
}

const tick = () => new Promise((r) => setImmediate(r));

module.exports = { hap, FakeMqttClient, fakeAccount, fakePlatform, newAccessory, tick, quiet };
