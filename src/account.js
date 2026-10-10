'use strict';

// Holds the account tokens shared by all devices, refreshes them before they
// expire and persists the rotating refresh token in Homebridge's storage dir.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const C = require('./constants');
const cloud = require('./cloud');

class Account {
  /**
   * @param {object} opts
   * @param {string} opts.refreshToken refresh token from config.json (seed)
   * @param {string} [opts.clientId]
   * @param {string} [opts.userId]
   * @param {string} opts.storageDir directory for the token cache
   */
  constructor({ refreshToken, clientId, userId, storageDir, log, fetchImpl }) {
    this.log = log;
    this.fetch = fetchImpl || fetch;
    this.clientId = clientId || C.CLIENT_ID_AIRPLUS;
    this.userId = userId || null;
    this.seed = refreshToken;
    this.file = path.join(storageDir, 'philips-airplus', `${crypto.createHash('sha1').update(refreshToken).digest('hex').slice(0, 12)}.json`);
    this.accessToken = null;
    this.refreshToken = refreshToken;
    this.expiresAt = null;
    this.signature = null;
    this._refreshing = null;
    this.expired = false;
    this._load();
  }

  _load() {
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (data.seed === this.seed && data.refreshToken) {
        this.accessToken = data.accessToken || null;
        this.refreshToken = data.refreshToken;
        this.expiresAt = data.expiresAt || null;
        this.userId = this.userId || data.userId || null;
        this.clientId = data.clientId || this.clientId;
      }
    } catch {
      // first start or unreadable cache: start from the config seed
    }
  }

  _save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(
        this.file,
        JSON.stringify(
          {
            seed: this.seed,
            accessToken: this.accessToken,
            refreshToken: this.refreshToken,
            expiresAt: this.expiresAt,
            userId: this.userId,
            clientId: this.clientId,
          },
          null,
          2,
        ),
        { mode: 0o600 },
      );
    } catch (e) {
      this.log.warn(`Could not persist tokens: ${e.message}`);
    }
  }

  get needsRefresh() {
    return !this.accessToken || !this.expiresAt || Date.now() + C.TOKEN_REFRESH_BUFFER_MS > this.expiresAt;
  }

  /** Returns true if the access token changed. Throws AuthExpiredError if login is needed. */
  async ensureToken() {
    if (!this.needsRefresh) return false;
    if (!this._refreshing) {
      this._refreshing = (async () => {
        try {
          const t = await cloud.refreshTokens(this.refreshToken, this.clientId, this.fetch);
          this.accessToken = t.accessToken;
          this.refreshToken = t.refreshToken;
          this.expiresAt = t.expiresAt || Date.now() + 3600 * 1000;
          this.signature = null;
          this._save();
          this.log.debug(`Access token refreshed, valid until ${new Date(this.expiresAt).toISOString()}`);
          return true;
        } catch (e) {
          if (e instanceof cloud.AuthExpiredError) this.expired = true;
          throw e;
        } finally {
          this._refreshing = null;
        }
      })();
    }
    return this._refreshing;
  }

  /** Fresh MQTT custom-authorizer signature — it must match the current access token. */
  async getSignature(force = false) {
    await this.ensureToken();
    if (!this.signature || force) this.signature = await cloud.fetchSignature(this.accessToken, this.fetch);
    return this.signature;
  }

  async getUserId() {
    if (!this.userId) {
      await this.ensureToken();
      this.userId = await cloud.fetchUserId(this.accessToken, this.fetch);
      this._save();
    }
    return this.userId;
  }

  async listDevices() {
    await this.ensureToken();
    const list = await cloud.listDevices(this.accessToken, this.fetch);
    return list.map(cloud.normalizeDevice).filter((d) => d.uuid);
  }
}

module.exports = { Account };
