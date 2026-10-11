'use strict';

// MQTT-over-WebSocket connection to the Versuni AWS IoT broker for one device.
// Port of mqtt_client.py. Reconnection is handled here (not by mqtt.js) so
// that every attempt uses a fresh access token and a matching signature.

const { EventEmitter } = require('node:events');
const crypto = require('node:crypto');
const C = require('./constants');
const { buildClientId, AuthExpiredError } = require('./cloud');

/** Split a payload that may contain several concatenated JSON objects. */
function parseConcatenatedJson(text) {
  const out = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && start >= 0) {
        out.push(JSON.parse(text.slice(start, i + 1)));
        start = -1;
      }
    }
  }
  return out;
}

function buildCommand(command, portName, properties) {
  return JSON.stringify({
    cid: crypto.randomBytes(4).toString('hex'),
    time: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    type: 'command',
    cn: command,
    ct: 'mobile',
    data: { portName, properties },
  });
}

class DeviceConnection extends EventEmitter {
  /**
   * @param {object} opts
   * @param {import('./account').Account} opts.account
   * @param {string} opts.uuid device uuid (with or without "da-")
   * @param {Function} [opts.mqttConnect] injectable for tests (defaults to mqtt.connect)
   */
  constructor({ account, uuid, log, mqttConnect }) {
    super();
    this.account = account;
    this.log = log;
    this.uuid = uuid.startsWith('da-') ? uuid.slice(3) : uuid;
    this.deviceId = `da-${this.uuid}`;
    this.mqttConnect = mqttConnect || require('mqtt').connect;
    this.client = null;
    this.connected = false;
    this.stopped = false;
    this.attempt = 0;
    this.timer = null;
    this.ports = { ...C.DEFAULT_PORTS };
    this.lastMessageAt = Date.now();
  }

  /** Drop the current connection and connect again with fresh credentials. */
  reconnect() {
    if (this.stopped) return;
    this.connected = false;
    this.attempt = 0;
    clearTimeout(this.timer);
    this._connect();
  }

  setPorts(ports) {
    this.ports = { ...C.DEFAULT_PORTS, ...(ports || {}) };
  }

  start() {
    this.stopped = false;
    this._connect();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    if (this.client) {
      this.client.removeAllListeners();
      this.client.on('error', () => {});
      this.client.end(true);
      this.client = null;
    }
    this.connected = false;
  }

  _schedule(delayMs) {
    if (this.stopped) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this._connect(), delayMs);
  }

  _backoff(rc) {
    this.attempt = Math.min(this.attempt + 1, 10);
    // rc 7 / "not authorized" style drops: AWS asks for a cooldown
    const base = rc === 7 ? 120000 : 5000;
    return Math.min(base * 2 ** (this.attempt - 1), 300000);
  }

  async _connect() {
    if (this.stopped) return;
    if (this.client) {
      this.client.removeAllListeners();
      this.client.on('error', () => {});
      this.client.end(true);
      this.client = null;
    }

    let accessToken;
    let signature;
    let clientId;
    try {
      // Always get a signature matching the current token before connecting.
      await this.account.ensureToken();
      signature = await this.account.getSignature(true);
      accessToken = this.account.accessToken;
      clientId = buildClientId(await this.account.getUserId(), this.uuid);
    } catch (e) {
      if (e instanceof AuthExpiredError) {
        this.log.error(`${e.message}. The device stays offline until you log in again.`);
        this.emit('authExpired');
        return;
      }
      const wait = this._backoff();
      this.log.warn(`Cloud login step failed (${e.message}); retrying in ${Math.round(wait / 1000)}s`);
      this._schedule(wait);
      return;
    }

    this.log.debug(`Connecting MQTT as ${clientId}`);
    const client = this.mqttConnect(C.MQTT_URL, {
      clientId,
      protocolVersion: 4,
      keepalive: C.MQTT_KEEPALIVE,
      clean: true,
      reconnectPeriod: 0,
      connectTimeout: 15000,
      wsOptions: {
        headers: {
          'x-amz-customauthorizer-name': C.MQTT_CUSTOM_AUTHORIZER,
          'x-amz-customauthorizer-signature': signature,
          tenant: 'da',
          'content-type': 'application/json',
          'token-header': `Bearer ${accessToken.trim()}`,
        },
      },
    });
    this.client = client;
    this.tokenUsed = accessToken;

    client.on('connect', () => {
      if (client !== this.client) return;
      this.connected = true;
      this.attempt = 0;
      this.lastMessageAt = Date.now();
      client.subscribe(C.TOPIC_STATUS(this.deviceId), { qos: 0 });
      this.log.info('Connected to Philips cloud');
      this.emit('connected');
    });

    client.on('message', (topic, payload) => {
      if (client !== this.client) return;
      this.lastMessageAt = Date.now();
      let messages;
      try {
        messages = parseConcatenatedJson(payload.toString('utf8'));
      } catch (e) {
        this.log.debug(`Undecodable MQTT payload on ${topic}: ${e.message}`);
        return;
      }
      for (const m of messages) {
        this.log.debug(`MQTT <- ${topic} ${JSON.stringify(m)}`);
        this.emit('message', m, topic);
      }
    });

    client.on('error', (err) => {
      if (client !== this.client) return;
      this.log.debug(`MQTT error: ${err.message}`);
      client.__rc = err.code;
    });

    client.on('close', () => {
      if (client !== this.client || this.stopped) return;
      const wasConnected = this.connected;
      this.connected = false;
      this.client = null;
      const wait = this._backoff(client.__rc);
      if (wasConnected) {
        this.log.warn(`Disconnected from Philips cloud; reconnecting in ${Math.round(wait / 1000)}s`);
        this.emit('disconnected');
      } else {
        this.log.warn(`MQTT connection failed${client.__rc ? ` (rc=${client.__rc})` : ''}; retrying in ${Math.round(wait / 1000)}s`);
      }
      this._schedule(wait);
    });
  }

  /** Reconnect if the account token changed since we connected (tokens expire hourly). */
  async refreshIfNeeded() {
    if (this.stopped) return;
    try {
      await this.account.ensureToken();
    } catch (e) {
      this.log.warn(`Token refresh failed: ${e.message}`);
      return;
    }
    if (this.connected && this.tokenUsed !== this.account.accessToken) {
      this.log.debug('Access token changed, reconnecting with new credentials');
      this._connect();
    }
  }

  _publish(topic, payload, qos = 0) {
    if (!this.client || !this.connected) {
      this.log.warn('Not connected to the Philips cloud, command dropped');
      return false;
    }
    this.log.debug(`MQTT -> ${topic} ${payload}`);
    this.client.publish(topic, payload, { qos });
    return true;
  }

  getPort(port) {
    return this._publish(C.TOPIC_CONTROL(this.deviceId), buildCommand('getPort', port, {}));
  }

  setPort(port, properties, qos = 0) {
    const ok = this._publish(C.TOPIC_CONTROL(this.deviceId), buildCommand('setPort', port, properties), qos);
    if (ok) this.getPort(port === this.ports.filter_write ? this.ports.filter_read : this.ports.status);
    return ok;
  }

  setControl(properties) {
    return this.setPort(this.ports.control, properties);
  }

  setPower(on) {
    const ok = this._publish(C.TOPIC_SHADOW_UPDATE(this.deviceId), JSON.stringify({ state: { desired: { powerOn: !!on } } }));
    if (ok) this.getPort(this.ports.status);
    return ok;
  }

  shadowGet() {
    return this._publish(C.TOPIC_SHADOW_GET(this.deviceId), '{}');
  }

  /**
   * Diagnostics: ask for the port list and the AWS IoT shadow, which may hold
   * settings the Status port does not report. Only used when logDeviceData is on,
   * because subscribing to shadow topics is outside what the app normally does.
   */
  discover() {
    if (!this.client || !this.connected) return;
    this.client.subscribe(`$aws/things/${this.deviceId}/shadow/get/accepted`, { qos: 0 });
    this.client.subscribe(`$aws/things/${this.deviceId}/shadow/update/documents`, { qos: 0 });
    this._publish(C.TOPIC_CONTROL(this.deviceId), JSON.stringify({
      cid: crypto.randomBytes(4).toString('hex'),
      time: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      type: 'command',
      cn: 'getAllPorts',
      ct: 'mobile',
      data: {},
    }));
    setTimeout(() => this.shadowGet(), 500);
  }

  requestAll() {
    this.getPort(this.ports.status);
    this.getPort(this.ports.config);
    this.getPort(this.ports.filter_read);
  }
}

module.exports = { DeviceConnection, parseConcatenatedJson, buildCommand };
