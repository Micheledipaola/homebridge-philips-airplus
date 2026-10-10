'use strict';

// Philips / Versuni cloud client: email + OTP login (Gigya CDC), OIDC token
// exchange and refresh, user id, MQTT signature and device discovery.
// Port of email_auth.py, auth.py and api.py from the Home Assistant integration.

const crypto = require('node:crypto');
const C = require('./constants');

class CloudError extends Error {}
class AuthExpiredError extends CloudError {}

/** Minimal cookie jar: the OIDC prompt=none flow spans several requests
 * against the same host, and aiohttp in the Python version keeps cookies. */
class CookieJar {
  constructor() {
    this.cookies = new Map(); // host -> Map(name -> value)
  }

  store(url, response) {
    const host = new URL(url).host;
    const list = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
    if (!list.length) return;
    const jar = this.cookies.get(host) || new Map();
    for (const raw of list) {
      const pair = raw.split(';', 1)[0];
      const eq = pair.indexOf('=');
      if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
    this.cookies.set(host, jar);
  }

  header(url) {
    const jar = this.cookies.get(new URL(url).host);
    if (!jar || !jar.size) return undefined;
    return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }
}

function b64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function pkcePair() {
  const verifier = b64url(crypto.randomBytes(48));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

function normalizeTokens(json) {
  const out = {
    accessToken: json.access_token || json.accessToken,
    refreshToken: json.refresh_token || json.refreshToken,
    expiresAt: null,
  };
  if (json.exp) out.expiresAt = Number(json.exp) * 1000;
  else if (json.expires_in) out.expiresAt = Date.now() + Number(json.expires_in) * 1000;
  return out;
}

class LoginSession {
  /** Interactive email + OTP login. Used by the config UI and the CLI. */
  constructor({ fetchImpl = fetch, log = () => {} } = {}) {
    this.fetch = fetchImpl;
    this.log = log;
    this.jar = new CookieJar();
    this.vToken = null;
    this.email = null;
    this.sessionToken = null;
  }

  async _request(url, init = {}) {
    const headers = { ...(init.headers || {}) };
    const cookie = this.jar.header(url);
    if (cookie) headers.Cookie = cookie;
    const res = await this.fetch(url, { ...init, headers });
    this.jar.store(url, res);
    return res;
  }

  async _postForm(url, form) {
    const res = await this._request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(),
    });
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      throw new CloudError(`${url} returned non-JSON (HTTP ${res.status})`);
    }
  }

  async sendCode(email) {
    this.email = email.trim();
    const data = await this._postForm(C.GIGYA_OTP_SEND_ENDPOINT, {
      email: this.email,
      apiKey: C.GIGYA_API_KEY,
      format: 'json',
    });
    if (data.errorCode !== 0) {
      throw new CloudError(`Sending the code failed: ${data.errorMessage || 'unknown error'} (code ${data.errorCode})`);
    }
    if (!data.vToken) throw new CloudError('No vToken in OTP send response');
    this.vToken = data.vToken;
    return true;
  }

  async verifyCode(code) {
    if (!this.vToken) throw new CloudError('Request a code first');
    const data = await this._postForm(C.GIGYA_OTP_LOGIN_ENDPOINT, {
      email: this.email,
      code: String(code).trim(),
      vToken: this.vToken,
      apiKey: C.GIGYA_API_KEY,
      format: 'json',
    });
    if (data.errorCode === 206001) {
      throw new CloudError(
        'This email is not a fully registered Philips account. Sign in once in the Philips app, then try again.',
      );
    }
    if (data.errorCode !== 0) {
      throw new CloudError(`Code verification failed: ${data.errorMessage || 'unknown error'}`);
    }
    const token = data.sessionInfo && data.sessionInfo.cookieValue;
    if (!token) throw new CloudError('No session token in OTP verify response');
    this.sessionToken = token;
    return true;
  }

  /** OIDC authorize with prompt=none using the Gigya session, then code exchange. */
  async exchange({ clientId, redirectUri, scopes }) {
    if (!this.sessionToken) throw new CloudError('Verify the code first');
    const { verifier, challenge } = pkcePair();

    const authParams = new URLSearchParams({
      client_id: clientId,
      response_type: 'code',
      redirect_uri: redirectUri,
      scope: scopes,
      state: b64url(crypto.randomBytes(12)),
      code_challenge: challenge,
      code_challenge_method: 'S256',
      prompt: 'none',
    });
    let res = await this._request(`${C.OIDC_AUTHORIZE}?${authParams}`, { redirect: 'manual' });
    if (res.status < 300 || res.status >= 400) {
      throw new CloudError(`/authorize: expected redirect, got HTTP ${res.status}`);
    }
    const context = new URL(res.headers.get('location') || '', 'https://x').searchParams.get('context');
    if (!context) throw new CloudError('/authorize: no context in redirect');

    const ids = await this._postForm(C.GIGYA_SOCIALIZE_GET_IDS, {
      APIKey: C.GIGYA_API_KEY,
      includeTicket: 'true',
      format: 'json',
    });
    if (!ids.gmidTicket) throw new CloudError(`socialize.getIDs returned no gmidTicket: ${ids.errorMessage || ids.errorCode}`);

    const contParams = new URLSearchParams({
      context,
      login_token: this.sessionToken,
      gmidTicket: ids.gmidTicket,
      client_id: clientId,
    });
    res = await this._request(`${C.OIDC_AUTHORIZE_CONTINUE}?${contParams}`, { redirect: 'manual' });
    if (res.status < 300 || res.status >= 400) {
      throw new CloudError(`/authorize/continue: expected redirect, got HTTP ${res.status}`);
    }
    const loc = new URL(res.headers.get('location') || '', 'https://x');
    if (loc.searchParams.get('errorMessage')) {
      throw new CloudError(`/authorize/continue: ${loc.searchParams.get('errorMessage')}`);
    }
    const code = loc.searchParams.get('code');
    if (!code) throw new CloudError('/authorize/continue: no code in redirect');

    const tokenJson = await this._postForm(C.OIDC_TOKEN, {
      client_id: clientId,
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    });
    if (!tokenJson.access_token) {
      throw new CloudError(`Token exchange failed: ${tokenJson.error_description || tokenJson.error || 'unknown'}`);
    }
    return { ...normalizeTokens(tokenJson), clientId };
  }

  /**
   * Full login: Air+ client first; if its device list is empty fall back to the
   * HomeID client (and, as a last resort, the HomeID appliance API), exactly as
   * the HA config flow does.
   */
  async completeLogin() {
    const airplus = await this.exchange({
      clientId: C.CLIENT_ID_AIRPLUS,
      redirectUri: C.REDIRECT_URI_AIRPLUS,
      scopes: C.SCOPES_AIRPLUS,
    });
    let devices = await listDevices(airplus.accessToken, this.fetch).catch((e) => {
      this.log(`Device list with Air+ token failed: ${e.message}`);
      return [];
    });
    let tokens = airplus;

    if (!devices.length) {
      this.log('No devices with the Air+ client, trying the HomeID client');
      try {
        const homeid = await this.exchange({
          clientId: C.CLIENT_ID_HOMEID,
          redirectUri: C.REDIRECT_URI_HOMEID,
          scopes: C.SCOPES_HOMEID,
        });
        let hd = await listDevices(homeid.accessToken, this.fetch).catch(() => []);
        if (!hd.length) hd = await listDevicesViaHomeId(homeid.accessToken, this.fetch).catch(() => []);
        if (hd.length) {
          devices = hd;
          tokens = homeid;
        }
      } catch (e) {
        this.log(`HomeID fallback failed: ${e.message}`);
      }
    }

    const userId = await fetchUserId(tokens.accessToken, this.fetch);
    return {
      ...tokens,
      userId,
      devices: devices.map(normalizeDevice).filter((d) => d.uuid),
    };
  }
}

function authHeaders(accessToken) {
  return {
    Authorization: `Bearer ${accessToken}`,
    'User-Agent': C.HTTP_USER_AGENT,
    Accept: 'application/json',
  };
}

async function getJson(url, accessToken, fetchImpl = fetch) {
  const res = await fetchImpl(url, { headers: authHeaders(accessToken), signal: AbortSignal.timeout(20000) });
  const text = await res.text();
  if (res.status !== 200) throw new CloudError(`GET ${url} -> HTTP ${res.status}: ${text.slice(0, 200)}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new CloudError(`GET ${url} returned invalid JSON`);
  }
}

async function fetchUserId(accessToken, fetchImpl = fetch) {
  const data = await getJson(C.USER_SELF_ENDPOINT, accessToken, fetchImpl);
  return data.id;
}

async function fetchSignature(accessToken, fetchImpl = fetch) {
  const data = await getJson(C.SIGNATURE_ENDPOINT, accessToken, fetchImpl);
  if (!data.signature) throw new CloudError('Signature missing in response');
  return data.signature;
}

async function listDevices(accessToken, fetchImpl = fetch) {
  const data = await getJson(C.DEVICE_ENDPOINT, accessToken, fetchImpl);
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.devices)) return data.devices;
  if (data && typeof data === 'object') {
    for (const v of Object.values(data)) {
      if (Array.isArray(v) && v.some((i) => i && typeof i === 'object' && i.uuid)) return v;
    }
  }
  return [];
}

async function listDevicesViaHomeId(accessToken, fetchImpl = fetch) {
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    Accept: C.HOMEID_ACCEPT,
    'Accept-Language': 'en-GB',
    'User-Agent': C.HOMEID_USER_AGENT,
    'X-USER-AGENT': C.HOMEID_X_USER_AGENT,
  };
  const disco = await (await fetchImpl(`${C.HOMEID_BACKEND_BASE}/.well-known/tenant/oneka`)).json();
  let profileUrl = disco.profileUrl;
  if (!profileUrl) return [];
  if (profileUrl.startsWith('/')) profileUrl = C.HOMEID_BACKEND_API + profileUrl;
  const ts = Date.now();
  const profile = await (await fetchImpl(`${profileUrl}?ts=${ts}`, { headers })).json();
  const embedded = profile._embedded && profile._embedded.userAppliances;
  const embeddedItems = embedded && embedded._embedded && embedded._embedded.item;
  if (Array.isArray(embeddedItems) && embeddedItems.length) return embeddedItems.map(fromHomeId);

  const links = profile._links || {};
  let href = '';
  for (const k of ['userAppliances', 'customerAppliances', 'appliances', 'devices']) {
    if (links[k] && links[k].href) {
      href = links[k].href;
      break;
    }
  }
  if (!href) return [];
  if (href.startsWith('/')) href = C.HOMEID_BACKEND_API + href;
  href = href.replace(/\{[^}]*\}/g, '');
  const data = await (await fetchImpl(`${href}?ts=${ts}`, { headers })).json();
  const items = Array.isArray(data) ? data : (data._embedded && data._embedded.item) || [];
  return items.map(fromHomeId);
}

function fromHomeId(item) {
  const name = item.name || item.friendlyName || 'Unknown';
  const ctn = item.ctn || item.modelNumber || item.deviceType || '';
  const id = item.externalDeviceId || item.id || item.macAddress;
  return { uuid: item.uuid || id, name, ctn, type: ctn || 'unknown' };
}

function normalizeDevice(d) {
  const uuid = d.uuid || d.id;
  return {
    uuid,
    name: d.name || d.deviceName || d.friendlyName || `Air+ ${String(uuid || '').slice(0, 8)}`,
    model: d.ctn || d.type || d.deviceType || undefined,
  };
}

async function refreshTokens(refreshToken, clientId, fetchImpl = fetch) {
  const res = await fetchImpl(C.OIDC_TOKEN, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': C.HTTP_USER_AGENT,
      Accept: 'application/json',
    },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId }).toString(),
  });
  const text = await res.text();
  if (res.status !== 200) {
    if (res.status === 401 || (res.status === 400 && text.includes('invalid_grant'))) {
      throw new AuthExpiredError('Refresh token expired or revoked — log in again from the plugin settings');
    }
    throw new CloudError(`Token refresh failed: HTTP ${res.status} ${text.slice(0, 200)}`);
  }
  const tokens = normalizeTokens(JSON.parse(text));
  if (!tokens.accessToken) throw new CloudError('Token refresh response has no access_token');
  if (!tokens.refreshToken) tokens.refreshToken = refreshToken;
  return tokens;
}

/** Build the MQTT client id. A suffix keeps it distinct from the app and from HA. */
function buildClientId(userId, deviceUuid, suffix = 'hb') {
  let uuid = String(deviceUuid);
  if (uuid.startsWith('da-')) uuid = uuid.slice(3);
  let uid = String(userId || '').trim();
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (/^[0-9a-f]{32}$/i.test(uid)) {
    uid = `${uid.slice(0, 8)}-${uid.slice(8, 12)}-${uid.slice(12, 16)}-${uid.slice(16, 20)}-${uid.slice(20)}`;
  }
  if (uuidRe.test(uid) && uuidRe.test(uuid)) return `${uid}_${uuid}_${suffix}`;
  return `client-${uuid}_${suffix}`;
}

module.exports = {
  CloudError,
  AuthExpiredError,
  LoginSession,
  fetchUserId,
  fetchSignature,
  listDevices,
  refreshTokens,
  normalizeDevice,
  buildClientId,
};
