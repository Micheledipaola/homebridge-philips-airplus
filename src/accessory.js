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

// Display light properties in the Philips D03 family: D03104 is what
// homebridge-philips-air-purifier-complete sends to Air+ cloud devices other
// than the AC1715 (0/115/123); D03105 and D0312D come from
// kongo09/philips-airpurifier-coap.
const LIGHT_KEYS = ['D03104', 'D03105', 'D0312D'];

// Bump to re-apply default service labels once on existing accessories.
const NAMES_VERSION = 2;

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
    this.diag = !!platform.config.logDeviceData;
    this.conn.on('connected', () => {
      this.conn.requestAll();
      this.conn.shadowGet();
      if (this.diag && !this._discovered) {
        this._discovered = true;
        this.log.info('logDeviceData is on: asking the device for all its ports and its cloud shadow');
        setTimeout(() => this.conn.discover(), 1500);
      }
    });
    this.conn.on('message', (m, topic) => this._onMessage(m, topic));

    // The cached/cloud model code is only a hint: if it does not match a
    // models.yaml entry, wait for the device to report its exact code on the
    // Config port instead of starting with the reduced fallback profile.
    const known = accessory.context.model;
    if (known && findModel(known)) this._applyModel(known, false);
    else this.log.info(`Model ${known ? `${known} ` : ''}not identified yet; waiting for the device to report it`);

    this._setInfo();
  }

  start() {
    this.conn.start();
    this._scheduleLabelRefresh();
    const pollS = Math.max(30, Number(this.platform.config.pollInterval) || C.STATUS_POLL_INTERVAL_S);
    // Watchdog: the cloud connection can stay open but stop delivering data.
    // Every poll asks the device for its status, so if nothing has arrived for
    // three polls (at least 6 minutes) the connection is rebuilt.
    const silenceMs = Math.max(3 * pollS, 360) * 1000;
    this.pollTimer = setInterval(async () => {
      await this.conn.refreshIfNeeded();
      if (!this.conn.connected) return;
      const silent = Date.now() - this.conn.lastMessageAt;
      if (silent > silenceMs) {
        // Warn once; if the purifier is simply unplugged keep retrying quietly.
        const msg = `No data from the purifier for ${Math.round(silent / 60000)} min; reconnecting to the Philips cloud`;
        if (this._silenceWarned) this.log.debug(msg);
        else this.log.warn(msg);
        this._silenceWarned = true;
        this.conn.reconnect();
        return;
      }
      if (this._silenceWarned) {
        this._silenceWarned = false;
        this.log.info('Receiving data from the purifier again');
      }
      this.conn.getPort(this.conn.ports.status);
    }, pollS * 1000);
    this.filterTimer = setInterval(() => {
      if (this.conn.connected) this.conn.getPort(this.conn.ports.filter_read);
    }, C.FILTER_POLL_INTERVAL_MS);
  }

  /**
   * labelRefresh: replays what made the Home app show labels under each
   * component in the purifier's combined view — the plugin renaming the
   * components while Home is connected (as the 0.2.1 update did, from
   * "<purifier> Air Quality" to "Air Quality"). Runs once per new value.
   * Names given in the Home app are replaced by the default labels.
   */
  _scheduleLabelRefresh() {
    const want = String(this.platform.config.labelRefresh || '').trim();
    if (!want || this.accessory.context.labelRefresh === want) return;
    const { Characteristic } = this.hap;
    const STEP_MS = 20000;
    const targets = () => this.accessory.services.filter((x) => x.__label && x !== this.purifier);
    const rename = (long) => {
      for (const x of targets()) {
        const name = long ? `${this.accessory.displayName} ${x.__label}` : x.__label;
        x.updateCharacteristic(Characteristic.Name, name);
        if (x.testCharacteristic(Characteristic.ConfiguredName)) x.updateCharacteristic(Characteristic.ConfiguredName, name);
      }
    };
    this._labelTimers = [
      setTimeout(() => {
        if (!targets().length) return;
        this.log.info('labelRefresh: renaming components in two steps so the Home app shows their labels');
        rename(true);
      }, STEP_MS),
      setTimeout(() => {
        if (!targets().length) return;
        rename(false);
        this.accessory.context.labelRefresh = want;
        this.platform.updateAccessory(this.accessory);
        this.log.info('labelRefresh: done');
      }, 2 * STEP_MS),
    ];
  }

  stop() {
    (this._labelTimers || []).forEach(clearTimeout);
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
    if (this.onModelReady) {
      const cb = this.onModelReady;
      this.onModelReady = null;
      cb();
    }
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

  /**
   * Get or create a service with a short, explicit label. Secondary services
   * are linked to the purifier so the Home app shows them as labelled controls
   * inside the purifier instead of as unnamed tiles.
   */
  _service(type, label, subtype, { link = true } = {}) {
    const { Characteristic } = this.hap;
    // Without a subtype, match only the service that has none: the Sleep
    // control can be a second AirPurifier service (subtype "sleep").
    const existing = subtype
      ? this.accessory.getServiceById(type, subtype)
      : this.accessory.services.find((x) => x.UUID === type.UUID && !x.subtype);
    const s = existing || this.accessory.addService(type, label, subtype);
    s.__label = label; // default label, used by labelRefresh (not persisted)
    // Set the label on new services, and once on services created by older
    // versions (which used long "<device> Sleep" names). Later user renames
    // made in the Home app are kept.
    if (!existing || (this.accessory.context.namesVersion || 0) < NAMES_VERSION) {
      s.setCharacteristic(Characteristic.Name, label);
      if (Characteristic.ConfiguredName) {
        if (!s.testCharacteristic(Characteristic.ConfiguredName)) s.addOptionalCharacteristic(Characteristic.ConfiguredName);
        s.setCharacteristic(Characteristic.ConfiguredName, label);
      }
    }
    if (link && this.purifier && s !== this.purifier && !this.purifier.linkedServices.includes(s)) {
      this.purifier.addLinkedService(s);
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
    const p = this._service(Service.AirPurifier, name, undefined, { link: false });
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
      const aq = this._service(Service.AirQualitySensor, 'Air Quality');
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
      { kind: 'replace', subtype: 'filter', label: 'Filter' },
      { kind: 'clean', subtype: 'prefilter', label: 'Pre-filter' },
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
    // "switch": a plain switch. "purifier": a second Air Purifier service, so
    // the Home app shows it with the purifier icon (it only turns Sleep on/off).
    const sleepStyle = cfg.sleepSwitchStyle === 'purifier' ? 'purifier' : 'switch';
    this.sleepSwitch = null;
    this.sleepPurifier = null;
    if (this.sleepModeName && cfg.sleepSwitch !== false && sleepStyle === 'switch') {
      this._remove(Service.AirPurifier, 'sleep');
      const s = this._service(Service.Switch, 'Sleep', 'sleep');
      s.getCharacteristic(Characteristic.On)
        .onGet(() => this._isSleep())
        .onSet((v) => this._setSleep(!!v));
      this.sleepSwitch = s;
    } else if (this.sleepModeName && cfg.sleepSwitch !== false) {
      this._remove(Service.Switch, 'sleep');
      const s = this._service(Service.AirPurifier, 'Sleep', 'sleep');
      s.getCharacteristic(Characteristic.Active)
        .onGet(() => (this._isSleep() ? 1 : 0))
        .onSet((v) => this._setSleep(v === 1 || v === true));
      s.getCharacteristic(Characteristic.CurrentAirPurifierState).onGet(() => (this._isSleep() ? 2 : 0));
      // Sleep is a fixed manual setting: lock the Auto/Manual choice.
      s.getCharacteristic(Characteristic.TargetAirPurifierState)
        .setProps({ validValues: [0] })
        .updateValue(0)
        .onGet(() => 0)
        .onSet(() => {});
      this.sleepPurifier = s;
    } else {
      this._remove(Service.Switch, 'sleep');
      this._remove(Service.AirPurifier, 'sleep');
    }

    this._setupLight();

    if ((this.accessory.context.namesVersion || 0) < NAMES_VERSION) {
      this.accessory.context.namesVersion = NAMES_VERSION;
      this.platform.updateAccessory(this.accessory);
    }
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
    const s = this._service(Service.Lightbulb, 'Display', 'display');
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
    const fromConfig = this.platform.config.displayLightProperty;
    if (fromConfig) return String(fromConfig).trim();
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

  _onMessage(m, topic = '') {
    if (this.diag) this._logDiag(m, topic);
    const data = m && m.data;
    if (!data || Array.isArray(data) || typeof data !== 'object') return;
    const port = data.portName;
    const props = data.properties;
    if (!props || typeof props !== 'object' || !Object.keys(props).length) return;

    if (port === this.conn.ports.config) {
      if (!this._loggedConfig) {
        this._loggedConfig = true;
        this.log.info(`Config properties reported by the device: ${JSON.stringify(props)}`);
      }
      if (LIGHT_KEYS.some((k) => props[k] !== undefined)) {
        Object.assign(this.state, Object.fromEntries(LIGHT_KEYS.filter((k) => props[k] !== undefined).map((k) => [k, props[k]])));
        this._learnLight(props);
      }
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

  _logDiag(m, topic) {
    if (topic.includes('/shadow/')) {
      this.log.info(`[diag] shadow ${topic.split('/shadow/')[1]}: ${JSON.stringify(m)}`);
      return;
    }
    const data = m && m.data;
    if (Array.isArray(data)) {
      const ports = data.map((d) => d && d.portName).filter(Boolean);
      this.log.info(`[diag] device ports: ${JSON.stringify(data)}`);
      this._diagPorts = this._diagPorts || new Set();
      for (const port of ports) {
        if (this._diagPorts.has(port)) continue;
        this._diagPorts.add(port);
        setTimeout(() => this.conn.getPort(port), 200 * this._diagPorts.size);
      }
      return;
    }
    if (data && data.portName) {
      const key = `${data.portName}:${JSON.stringify(data.properties)}`;
      if (this._diagSeen === undefined) this._diagSeen = new Set();
      if (this._diagSeen.has(key)) return;
      this._diagSeen.add(key);
      this.log.info(`[diag] port ${data.portName} (${m.cn}): ${JSON.stringify(data.properties)}`);
    } else {
      this.log.info(`[diag] message: ${JSON.stringify(m)}`);
    }
  }

  /** Remember which light property the device uses and which value scheme. */
  _learnLight(props) {
    const ctx = this.accessory.context;
    let changed = false;
    if (!this.platform.config.displayLightProperty && !this._prop('light_brightness') && !ctx.lightKey) {
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
    if (this.sleepPurifier) {
      this.sleepPurifier.updateCharacteristic(Characteristic.Active, this._isSleep() ? 1 : 0);
      this.sleepPurifier.updateCharacteristic(Characteristic.CurrentAirPurifierState, this._isSleep() ? 2 : 0);
    }
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
