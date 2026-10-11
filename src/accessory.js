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

// Display light properties in the Philips D03 family (see kongo09/philips-airpurifier-coap).
const LIGHT_KEYS = ['D03105', 'D0312D'];

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
      // The Home app always shows this as a percentage: split 0-100 into one
      // band per manual mode (Sleep … Turbo) and snap to it after each change.
      p.getCharacteristic(Characteristic.RotationSpeed)
        .setProps({ minValue: 0, maxValue: 100, minStep: 1 })
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

    // --- Sleep mode switch
    this.sleepModeName = Object.keys(this.model.modes || {}).find((m) => m.toLowerCase() === 'sleep');
    if (this.sleepModeName && cfg.sleepSwitch !== false) {
      const s = this._service(Service.Switch, `${name} Sleep`, 'sleep');
      s.getCharacteristic(Characteristic.On)
        .onGet(() => this._isSleep())
        .onSet((v) => this._setSleep(!!v));
      this.sleepSwitch = s;
    } else {
      this._remove(Service.Switch, 'sleep');
      this.sleepSwitch = null;
    }

    this._setupLight();
  }

  /** Display light: only exposed once the device has reported a light property. */
  _setupLight() {
    const { Service, Characteristic } = this.hap;
    const key = this._lightKey();
    if (!key) return; // not reported yet; _learnLight() calls us again once it is
    if (this.platform.config.displayLight === false) {
      this._remove(Service.Lightbulb, 'display');
      this.light = null;
      return;
    }
    if (this.light) return;
    const s = this._service(Service.Lightbulb, `${this.accessory.displayName} Display`, 'display');
    s.getCharacteristic(Characteristic.On)
      .onGet(() => this._lightOn())
      .onSet((v) => this._setLight(v ? null : 0));
    s.getCharacteristic(Characteristic.Brightness)
      .setProps({ minValue: 0, maxValue: 100, minStep: 1 })
      .onGet(() => this._lightBrightness())
      .onSet((v) => this._setLight(v));
    this.light = s;
  }

  _lightKey() {
    const fromModel = this._prop('light_brightness');
    if (fromModel) return fromModel;
    if (this.accessory.context.lightKey) return this.accessory.context.lightKey;
    return LIGHT_KEYS.find((k) => this.state[k] !== undefined) || null;
  }

  /**
   * Two value schemes exist in the Philips D03 property family:
   *  - percentage 0..100 (0 = off, 100 = full)
   *  - three steps 0 / 115 / 123 (off / dim / full), some with 101 = auto
   * The scheme is learned from the values the device reports.
   */
  _lightSteps() {
    const s = this.model.properties && this.model.properties.light_steps;
    if (Array.isArray(s)) return s;
    return this.accessory.context.lightSteps ? [0, 115, 123] : null;
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
    return Math.round(((i + 1) * 100) / this.speeds.length);
  }

  _filterLife(kind) {
    const nom = this._num(`filter_${kind}_nominal`);
    const rem = this._num(`filter_${kind}_remaining`);
    if (!nom || rem === null || nom <= 0) return null;
    return Math.max(0, Math.min(100, Math.round((rem / nom) * 100)));
  }

  _isSleep() {
    return this._isOn() && !!this.sleepModeName && this._currentModeName() === this.sleepModeName;
  }

  _lightRaw() {
    const key = this._lightKey();
    if (!key || this.state[key] === undefined) return null;
    const n = Number(this.state[key]);
    return Number.isNaN(n) ? null : n;
  }

  _lightOn() {
    const v = this._lightRaw();
    return v !== null && v > 0;
  }

  _lightBrightness() {
    const v = this._lightRaw();
    if (v === null || v <= 0) return 0;
    const steps = this._lightSteps();
    if (steps) {
      if (v === 101) return 100; // auto: show as full
      const idx = steps.indexOf(v);
      return idx > 0 ? Math.round((idx * 100) / (steps.length - 1)) : 100;
    }
    return Math.min(100, v);
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
    const n = this.speeds.length;
    const idx = Math.min(n - 1, Math.max(0, Math.ceil((v * n) / 100) - 1));
    const name = this.speeds[idx];
    if (name !== this._currentModeName()) this._setMode(name);
    setTimeout(() => this._pushAll(), 0);
  }

  async _setSleep(on) {
    this._ensureConnected();
    if (on === this._isSleep()) return;
    if (on) {
      this._setMode(this.sleepModeName);
    } else {
      // leave Sleep: back to Auto if the model has it, else the last manual speed
      const auto = Object.keys(this.model.modes).find((m) => m.toLowerCase() === 'auto');
      const back = auto || (this.speeds.includes(this.lastManualMode) && this.lastManualMode !== this.sleepModeName ? this.lastManualMode : this.speeds[1] || this.speeds[0]);
      this._setMode(back);
    }
    setTimeout(() => this._pushAll(), 0);
  }

  /** @param {number|null} brightness 0 = off, null = "on" at the last level */
  async _setLight(brightness) {
    this._ensureConnected();
    const key = this._lightKey();
    if (!key) return;
    let raw;
    const steps = this._lightSteps();
    if (brightness === 0) raw = 0;
    else if (brightness === null) {
      if (this._lightOn()) return;
      raw = this.accessory.context.lastLightRaw || (steps ? steps[steps.length - 1] : 100);
    } else if (steps) {
      const idx = Math.max(1, Math.round((brightness * (steps.length - 1)) / 100));
      raw = steps[idx];
    } else {
      raw = Math.max(1, Math.min(100, Math.round(brightness)));
    }
    if (raw === this._lightRaw()) return;
    this.log.info(`Display light -> ${raw}`);
    this.conn.setControl({ [key]: raw });
    this.state[key] = raw;
    if (raw > 0) this.accessory.context.lastLightRaw = raw;
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
      if (!this._loggedKeys) {
        this._loggedKeys = true;
        this.log.info(`Status properties reported by the device: ${JSON.stringify(props)}`);
      }
      Object.assign(this.state, props);
      this._learnLight(props);
    } else {
      return;
    }
    this._pushAll();
  }

  /** Remember which light property the device uses and which value scheme. */
  _learnLight(props) {
    const ctx = this.accessory.context;
    let changed = false;
    if (!this._prop('light_brightness') && !ctx.lightKey) {
      const k = LIGHT_KEYS.find((x) => props[x] !== undefined);
      if (k) {
        ctx.lightKey = k;
        changed = true;
        this.log.info(`Display light found on property ${k}`);
      }
    }
    const key = this._lightKey();
    if (key && props[key] !== undefined) {
      const v = Number(props[key]);
      if (v > 100 && !ctx.lightSteps) {
        ctx.lightSteps = true;
        changed = true;
      }
      if (v > 0) ctx.lastLightRaw = v;
    }
    if (changed) {
      this.platform.updateAccessory(this.accessory);
      this._setupLight();
    }
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
    if (this.sleepSwitch) this.sleepSwitch.updateCharacteristic(Characteristic.On, this._isSleep());
    if (this.light && this._lightRaw() !== null) {
      this.light.updateCharacteristic(Characteristic.On, this._lightOn());
      if (this._lightOn()) this.light.updateCharacteristic(Characteristic.Brightness, this._lightBrightness());
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
