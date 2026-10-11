'use strict';

const { Account } = require('./account');
const { PurifierAccessory } = require('./accessory');
const C = require('./constants');

class PhilipsAirPlusPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config || {};
    this.api = api;
    this.cached = new Map(); // homebridge uuid -> PlatformAccessory
    this.handlers = new Map();

    if (!this.config.refreshToken) {
      this.log.error('Not logged in: open the plugin settings in Homebridge UI and log in with your Philips account email.');
      return;
    }

    this.account = new Account({
      refreshToken: this.config.refreshToken,
      clientId: this.config.clientId,
      userId: this.config.userId,
      storageDir: api.user.storagePath(),
      log,
    });

    api.on('didFinishLaunching', () => {
      this.discover().catch((e) => this.log.error(`Startup failed: ${e.stack || e.message}`));
    });
    api.on('shutdown', () => {
      for (const h of this.handlers.values()) h.stop();
    });
  }

  configureAccessory(accessory) {
    this.cached.set(accessory.UUID, accessory);
  }

  updateAccessory(accessory) {
    this.api.updatePlatformAccessories([accessory]);
  }

  async discover() {
    const configured = Array.isArray(this.config.devices) ? this.config.devices.filter((d) => d && d.uuid) : [];
    let cloudDevices = null;
    try {
      cloudDevices = await this.account.listDevices();
      this.log.info(`Philips account has ${cloudDevices.length} device(s): ${cloudDevices.map((d) => `${d.name} [${d.model || '?'}]`).join(', ') || '-'}`);
    } catch (e) {
      this.log.warn(`Could not list devices from the cloud (${e.message}); using configured/cached devices`);
    }

    // Desired set: configured devices (if any), else everything in the account.
    let wanted;
    if (configured.length) {
      wanted = configured.map((c) => {
        const found = cloudDevices && cloudDevices.find((d) => strip(d.uuid) === strip(c.uuid));
        return { uuid: strip(c.uuid), name: c.name || (found && found.name) || `Air+ ${strip(c.uuid).slice(0, 8)}`, model: c.model || (found && found.model) };
      });
    } else if (cloudDevices) {
      wanted = cloudDevices.map((d) => ({ uuid: strip(d.uuid), name: d.name, model: d.model }));
    } else {
      wanted = [...this.cached.values()].map((a) => ({ uuid: a.context.uuid, name: a.displayName, model: a.context.model }));
    }

    const keep = new Set();
    for (const dev of wanted) {
      // homekitIdentity: changing it gives the accessory a brand-new HomeKit
      // identity, for when the Home app has a stuck record of the old one.
      const identity = String(this.config.homekitIdentity || '').trim();
      const hbUuid = this.api.hap.uuid.generate(`${C.PLATFORM_NAME}:${dev.uuid}${identity ? `:${identity}` : ''}`);
      keep.add(hbUuid);
      let acc = this.cached.get(hbUuid);
      if (!acc) {
        acc = new this.api.platformAccessory(dev.name, hbUuid, this.api.hap.Categories.AIR_PURIFIER);
        acc.context.uuid = dev.uuid;
        if (dev.model) acc.context.model = dev.model;
        this.log.info(`Adding ${dev.name}`);
        this.api.registerPlatformAccessories(C.PLUGIN_NAME, C.PLATFORM_NAME, [acc]);
      } else if (!acc.context.model && dev.model) {
        acc.context.model = dev.model;
      }
      const handler = new PurifierAccessory(this, acc, { account: this.account });
      this.handlers.set(hbUuid, handler);
      handler.conn.on('authExpired', () => this._authExpired());
      handler.start();
    }

    // Only prune when we actually know the full list.
    if (configured.length || cloudDevices) {
      const stale = [...this.cached.entries()].filter(([u]) => !keep.has(u)).map(([, a]) => a);
      if (stale.length) {
        this.log.info(`Removing ${stale.map((a) => a.displayName).join(', ')}`);
        this.api.unregisterPlatformAccessories(C.PLUGIN_NAME, C.PLATFORM_NAME, stale);
      }
    }
  }

  _authExpired() {
    if (this._authWarned) return;
    this._authWarned = true;
    this.log.error('Philips login expired. Open the plugin settings, log in again with your email and restart Homebridge.');
  }
}

function strip(u) {
  return String(u).startsWith('da-') ? String(u).slice(3) : String(u);
}

module.exports = { PhilipsAirPlusPlatform };
