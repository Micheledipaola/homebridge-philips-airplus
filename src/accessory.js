'use strict';

// One HomeKit accessory per purifier: Air Purifier + Air Quality Sensor +
// Filter Maintenance (main filter and pre-filter cleaning).

const { DeviceConnection } = require('./connection');
const { findModel, speedModes, modeName } = require('./models');
const C = require('./constants');

// Used when the device reports a model that models.yaml does not know: the
// D03/D05 keys are shared by every known Air+ model, the mode values are not,
// so only power, PM2.5 and filters are exposed.
const FALLBACK_MODEL = {
  key: 'unknown',
  name: 'Philips Air+',
  modes: {},
  ports: C.DEFAULT_PORTS,
  properties: {
    mode: 'D0310C',
    power: 'D0310D',
    pm25: 'D03221',
    filter_replace_nominal: 'D05408',
    filter_replace_remaining: 'D0540E',
    filter_clean_nominal: 'D05207',
    filter_clean_remaining: 'D0520D',
  },
};

function pm25ToAirQuality(pm) {
  if (pm == null || Number.isNaN(pm)) return 0; // UNKNOWN
  if (pm <= 12) return 1; // EXCELLENT
  if (pm <= 35) return 2; // GOOD
  if (pm <= 55) return 3; // FAIR
  if (pm <= 150) return 4; // INFERIOR
  return 5; // POOR
}

class PurifierAccessory {
  constructor(platform, accessory, { account, mqttConnect } = {}) {
    this.platform = platform;
    this.api = platform.api;
    this.accessory = accessory;
    this.hap = platform.api.hap;
    const name = accessory.displayName;
    const plog = platform.log;
    this.log = {
      info: (m) => plog.info(`[${name}] ${m}`),
      warn: (m) => plog.warn(`[${name}] ${m}`),
      error: (m) => plog.error(`[${name}] ${m}`),
      debug: (m) => plog.debug(`[${name}] ${m}`),
    };

    this.state = {};
    this.filter = {};
    this.model = null;
    this.lastManualMode = accessory.context.lastManualMode || null;
    this.filterThreshold = platform.config.filterChangeThreshold ?? 10;

    this.conn = new DeviceConnection({ account, uuid: accessory.context.uuid, log: this.log, mqttConnect });
    this.conn.on('connected', () => {
      this.conn.requestAll();
      this.conn.shadowGet();
    });
    this.conn.on('message', (m) => this._onMessage(m));

    const known = accessory.context.model;
    if (known) this._applyModel(known, false);
    else this.log.info('Model not known yet; waiting for the device to report it');

    this._setInfo();
  }

  start() {
    this.conn.start();
    const pollS = Math.max(30, Number(this.platform.config.pollInterval) || C.STATUS_POLL_INTERVAL_S);
    this.pollTimer = setInterval(async () => {
      await this.conn.refreshIfNeeded();
      if (this.conn.connected) this.conn.getPort(this.conn.ports.status);
    }, pollS * 1000);
    this.filterTimer = setInterval(() => {
      if (this.conn.connected) this.conn.getPort(this.conn.ports.filter_read);
    }, C.FILTER_POLL_INTERVAL_MS);
  }

  stop() {
    clearInterval(this.pollTimer);
    clearInterval(this.filterTimer);
    this.conn.stop();
  }

  // ---------------------------------------------------------------- model

  _applyModel(ctn, persist = true) {
    const model = findModel(ctn);
    if (!model) {
      this.log.warn(`Model ${ctn} is not in models.yaml: exposing power, PM2.5 and filters only`);
    }
    this.model = model || { ...FALLBACK_MODEL, name: `Philips ${ctn}` };
    this.speeds = speedModes(this.model);
    this.hasAuto = Object.keys(this.model.modes || {}).some((m) => m.toLowerCase() === 'auto');
    this.conn.setPorts(this.model.ports);
    if (persist && this.accessory.context.model !== ctn) {
      this.accessory.context.model = ctn;
      this.platform.updateAccessory(this.accessory);
    }
    this._setupServices();
    this._setInfo();
    this._pushAll();
    this.log.info(`Using model profile "${this.model.name}" (${this.speeds.length} manual speeds${this.hasAuto ? ' + Auto' : ''})`);
  }

  _prop(name) {
    const key = this.model && this.model.properties && this.model.properties[name];
    return key ? key : null;
  }

  /** Filter values come from the filter port, everything else from the status port. */
  _value(name) {
    const key = this._prop(name);
    if (!key) return undefined;
    const [first, second] = name.startsWith('filter_') ? [this.filter, this.state] : [this.state, this.filter];
    return first[key] !== undefined ? first[key] : second[key];
  }

  // ------------------------------------------------------------- services

  _setInfo() {
    const { Service, Characteristic } = this.hap;
    const info = this.accessory.getService(Service.AccessoryInformation) || this.accessory.addService(Service.AccessoryInformation);
    info
      .setCharacteristic(Characteristic.Manufacturer, 'Philips')
      .setCharacteristic(Characteristic.Model, this.accessory.context.model || 'Air+')
      .setCharacteristic(Characteristic.SerialNumber, this.accessory.context.uuid.slice(-12))
      .setCharacteristic(Characteristic.FirmwareRevision, require('../package.json').version);
  }

  _service(type, name, subtype) {
    const existing = subtype ? this.accessory.getServiceById(type, subtype) : this.accessory.getService(type);
    if (existing) return existing;
    const s = this.accessory.addService(type, name, subtype);
    if (this.hap.Characteristic.ConfiguredName) {
      if (!s.testCharacteristic(this.hap.Characteristic.ConfiguredName)) s.addOptionalCharacteristic(this.hap.Characteristic.ConfiguredName);
      s.setCharacteristic(this.hap.Characteristic.ConfiguredName, name);
    }
    return s;
  }

  _remove(type, subtype) {
    const s = subtype ? this.accessory.getServiceById(type, subtype) : this.accessory.getService(type);
    if (s) this.accessory.removeService(s);
  }

  _setupServices() {
    const { Service, Characteristic } = this.hap;
    const name = this.accessory.displayName;
    const cfg = this.platform.config;

    // --- Air purifier
    const p = this._service(Service.AirPurifier, name);
    this.purifier = p;
    p.setPrimaryService(true);
    p.getCharacteristic(Characteristic.Active)
      .onGet(() => this._active())
      .onSet((v) => this._setActive(v));
    p.getCharacteristic(Characteristic.CurrentAirPurifierState).onGet(() => this._currentState());

    const target = p.getCharacteristic(Characteristic.TargetAirPurifierState);
    if (this.hasAuto && this.speeds.length) {
      target.setProps({ validValues: [0, 1] });
    } else {
      // Only one of the two makes sense; keep the characteristic but lock it.
      const only = this.hasAuto ? 1 : 0;
      target.setProps({ validValues: [only] });
    }
    target.onGet(() => this._targetState()).onSet((v) => this._setTargetState(v));

    if (this.speeds.length) {
      // One slider notch per manual mode (Sleep … Turbo); 0 = off.
      p.getCharacteristic(Characteristic.RotationSpeed)
        .setProps({ minValue: 0, maxValue: this.speeds.length, minStep: 1 })
        .onGet(() => this._rotationSpeed())
        .onSet((v) => this._setRotationSpeed(v));
    } else if (p.testCharacteristic(Characteristic.RotationSpeed)) {
      p.removeCharacteristic(p.getCharacteristic(Characteristic.RotationSpeed));
    }

    // --- Air quality
    if (this._prop('pm25') && cfg.airQualitySensor !== false) {
      const aq = this._service(Service.AirQualitySensor, `${name} Air Quality`);
      this.aq = aq;
      aq.getCharacteristic(Characteristic.AirQuality).onGet(() => pm25ToAirQuality(this._num('pm25')));
      aq.getCharacteristic(Characteristic.PM2_5Density).onGet(() => Math.min(1000, Math.max(0, this._num('pm25') ?? 0)));
      aq.getCharacteristic(Characteristic.StatusActive).onGet(() => this.conn.connected);
    } else {
      this._remove(Service.AirQualitySensor);
      this.aq = null;
    }

    // --- Filters
    this.filters = {};
    const filterDefs = [
      { kind: 'replace', subtype: 'filter', label: `${name} Filter` },
      { kind: 'clean', subtype: 'prefilter', label: `${name} Pre-filter` },
    ];
    for (const f of filterDefs) {
      const enabled = this._prop(`filter_${f.kind}_remaining`) && cfg.filterSensors !== false;
      if (!enabled) {
        this._remove(Service.FilterMaintenance, f.subtype);
        continue;
      }
      const s = this._service(Service.FilterMaintenance, f.label, f.subtype);
      s.getCharacteristic(Characteristic.FilterChangeIndication).onGet(() => this._filterChange(f.kind));
      s.getCharacteristic(Characteristic.FilterLifeLevel).onGet(() => this._filterLife(f.kind) ?? 100);
      if (this._prop(`filter_${f.kind}_reset_raw`)) {
        s.getCharacteristic(Characteristic.ResetFilterIndication).onSet(() => this._resetFilter(f.kind));
      }
      this.filters[f.kind] = s;
    }
  }

  // ------------------------------------------------------------ getters

  _num(name) {
    const v = this._value(name);
    if (v === undefined || v === null || v === '') return null;
    const n = Number(v);
    return Number.isNaN(n) ? null : n;
  }

  _isOn() {
    const p = this._num('power');
    return p !== null && p !== 0;
  }

  _active() {
    return this._isOn() ? 1 : 0;
  }

  _currentState() {
    return this._isOn() ? 2 : 0; // PURIFYING_AIR : INACTIVE
  }

  _currentModeName() {
    const v = this._num('mode');
    return v === null ? null : modeName(this.model, v);
  }

  _targetState() {
    if (!this.speeds.length) return this.hasAuto ? 1 : 0;
    if (!this.hasAuto) return 0;
    const m = this._currentModeName();
    return m && m.toLowerCase() !== 'auto' ? 0 : 1; // MANUAL : AUTO
  }

  _rotationSpeed() {
    if (!this._isOn() || !this.speeds.length) return 0;
    const m = this._currentModeName();
    const idx = m ? this.speeds.indexOf(m) : -1;
    // In Auto, show the slider at the "auto" position the app would use: middle.
    const i = idx >= 0 ? idx : Math.floor((this.speeds.length - 1) / 2);
    return i + 1;
  }

  _filterLife(kind) {
    const nom = this._num(`filter_${kind}_nominal`);
    const rem = this._num(`filter_${kind}_remaining`);
    if (!nom || rem === null || nom <= 0) return null;
    return Math.max(0, Math.min(100, Math.round((rem / nom) * 100)));
  }

  _filterChange(kind) {
    const life = this._filterLife(kind);
    return life !== null && life <= this.filterThreshold ? 1 : 0;
  }

  // ------------------------------------------------------------ setters

  _ensureConnected() {
    if (!this.conn.connected) {
      throw new this.api.hap.HapStatusError(this.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  async _setActive(v) {
    this._ensureConnected();
    const on = v === 1 || v === true;
    if (on === this._isOn()) return;
    this.log.info(`Power ${on ? 'on' : 'off'}`);
    this.conn.setPower(on);
    // optimistic update until the device confirms
    const key = this._prop('power');
    if (key) this.state[key] = on ? 1 : 0;
    this.purifier.updateCharacteristic(this.hap.Characteristic.CurrentAirPurifierState, this._currentState());
  }

  _setMode(name) {
    const value = this.model.modes[name];
    const key = this._prop('mode');
    if (value === undefined || !key) return;
    this.log.info(`Mode -> ${name}`);
    if (!this._isOn()) this.conn.setPower(true);
    this.conn.setControl({ [key]: value });
    this.state[key] = value;
    if (name.toLowerCase() !== 'auto') {
      this.lastManualMode = name;
      this.accessory.context.lastManualMode = name;
    }
  }

  async _setTargetState(v) {
    this._ensureConnected();
    if (!this.speeds.length || !this.hasAuto) return;
    if (v === 1) {
      if (this._targetState() !== 1) this._setMode(Object.keys(this.model.modes).find((m) => m.toLowerCase() === 'auto'));
    } else if (this._targetState() !== 0) {
      const fallback = this.speeds[Math.floor((this.speeds.length - 1) / 2)];
      this._setMode(this.speeds.includes(this.lastManualMode) ? this.lastManualMode : fallback);
    }
    setTimeout(() => this._pushAll(), 0);
  }

  async _setRotationSpeed(v) {
    this._ensureConnected();
    if (!this.speeds.length) return;
    if (v <= 0) return; // HomeKit sends Active=0 for "off"
    const idx = Math.min(this.speeds.length, Math.max(1, Math.round(v))) - 1;
    const name = this.speeds[idx];
    if (name !== this._currentModeName()) this._setMode(name);
    setTimeout(() => this._pushAll(), 0);
  }

  async _resetFilter(kind) {
    this._ensureConnected();
    const key = this._prop(`filter_${kind}_reset_raw`);
    // Same value the official app writes (models.yaml), else the nominal life.
    const value = this.model.properties[`filter_${kind}_reset_value`] ?? this._num(`filter_${kind}_nominal`);
    if (!key || value === undefined) return;
    this.log.info(`Resetting ${kind === 'replace' ? 'filter' : 'pre-filter'} timer to ${value}h`);
    this.conn.setPort(this.conn.ports.filter_write, { [key]: value }, 1);
  }

  // ------------------------------------------------------------- inbound

  _onMessage(m) {
    const data = m && m.data;
    if (!data || Array.isArray(data) || typeof data !== 'object') return;
    const port = data.portName;
    const props = data.properties;
    if (!props || typeof props !== 'object' || !Object.keys(props).length) return;

    if (port === this.conn.ports.config) {
      if (props.ctn && (!this.model || this.accessory.context.model !== props.ctn)) {
        this.log.info(`Device reports model ${props.ctn}`);
        this._applyModel(props.ctn);
      }
      return;
    }
    if (port === this.conn.ports.filter_read) {
      Object.assign(this.filter, props);
    } else if (!port || port === this.conn.ports.status) {
      Object.assign(this.state, props);
    } else {
      return;
    }
    this._pushAll();
  }

  _pushAll() {
    if (!this.model || !this.purifier) return;
    const { Characteristic } = this.hap;
    this.purifier.updateCharacteristic(Characteristic.Active, this._active());
    this.purifier.updateCharacteristic(Characteristic.CurrentAirPurifierState, this._currentState());
    this.purifier.updateCharacteristic(Characteristic.TargetAirPurifierState, this._targetState());
    if (this.speeds.length) this.purifier.updateCharacteristic(Characteristic.RotationSpeed, this._rotationSpeed());

    if (this.aq) {
      const pm = this._num('pm25');
      if (pm !== null) {
        this.aq.updateCharacteristic(Characteristic.AirQuality, pm25ToAirQuality(pm));
        this.aq.updateCharacteristic(Characteristic.PM2_5Density, Math.min(1000, Math.max(0, pm)));
      }
      this.aq.updateCharacteristic(Characteristic.StatusActive, this.conn.connected);
    }
    for (const [kind, s] of Object.entries(this.filters || {})) {
      const life = this._filterLife(kind);
      if (life === null) continue;
      s.updateCharacteristic(Characteristic.FilterLifeLevel, life);
      s.updateCharacteristic(Characteristic.FilterChangeIndication, this._filterChange(kind));
    }
  }
}

module.exports = { PurifierAccessory, pm25ToAirQuality, FALLBACK_MODEL };
