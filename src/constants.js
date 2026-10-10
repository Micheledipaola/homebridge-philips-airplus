'use strict';

// Values mirror custom_components/philips_airplus/const.py so both the Home
// Assistant integration and the Homebridge plugin speak the same protocol.

const PLUGIN_NAME = 'homebridge-philips-airplus';
const PLATFORM_NAME = 'PhilipsAirPlus';

const API_HOST = 'prod.eu-da.iot.versuni.com';
const API_BASE_URL = `https://${API_HOST}/api`;
const DEVICE_ENDPOINT = `${API_BASE_URL}/da/user/self/device`;
const SIGNATURE_ENDPOINT = `${API_BASE_URL}/da/user/self/signature`;
const USER_SELF_ENDPOINT = `${API_BASE_URL}/da/user/self`;

const HTTP_USER_AGENT = 'okhttp/4.12.0 (Android 14; Pixel 7)';

const GIGYA_API_KEY = '4_JGZWlP8eQHpEqkvQElolbA';
const GIGYA_API_URL = 'https://cdc.accounts.home.id';
const GIGYA_OTP_SEND_ENDPOINT = `${GIGYA_API_URL}/accounts.auth.otp.email.sendCode`;
const GIGYA_OTP_LOGIN_ENDPOINT = `${GIGYA_API_URL}/accounts.auth.otp.email.login`;
const GIGYA_SOCIALIZE_GET_IDS = `${GIGYA_API_URL}/socialize.getIDs`;

const OIDC_ISSUER = `https://cdc.accounts.home.id/oidc/op/v1.0/${GIGYA_API_KEY}`;
const OIDC_AUTHORIZE = `${OIDC_ISSUER}/authorize`;
const OIDC_AUTHORIZE_CONTINUE = `${OIDC_ISSUER}/authorize/continue`;
const OIDC_TOKEN = `${OIDC_ISSUER}/token`;

// Philips Air+ app client (default)
const CLIENT_ID_AIRPLUS = '-XsK7O6iEkLml77yDGDUi0ku';
const REDIRECT_URI_AIRPLUS = 'com.philips.air://loginredirect';
const SCOPES_AIRPLUS =
  'openid email profile address DI.Account.read DI.Account.write DI.AccountProfile.read ' +
  'DI.AccountProfile.write DI.AccountGeneralConsent.read DI.AccountGeneralConsent.write ' +
  'DI.GeneralConsent.read subscriptions profile_extended consents DI.AccountSubscription.read ' +
  'DI.AccountSubscription.write';

// Philips HomeID app client (fallback for HomeID-only accounts)
const CLIENT_ID_HOMEID = '-u6aTznrxp9_9e_0a57CpvEG';
const REDIRECT_URI_HOMEID = 'com.philips.ka.oneka.app.prod://oauthredirect';
const SCOPES_HOMEID =
  'openid profile email offline_access ' +
  'DI.Account.read DI.AccountProfile.read DI.AccountProfile.write ' +
  'DI.AccountGeneralConsent.read DI.AccountGeneralConsent.write ' +
  'DI.GeneralConsent.read DI.GeneralConsent.write ' +
  'VoiceProvider.read VoiceProvider.write ' +
  'subscriptions consent profile_extended ' +
  'DI.AccountSubscription.write DI.AccountSubscription.read';

const HOMEID_BACKEND_BASE = 'https://www.backend.vbs.versuni.com';
const HOMEID_BACKEND_API = `${HOMEID_BACKEND_BASE}/api`;
const HOMEID_ACCEPT = 'application/vnd.oneka.v2.0+json';
const HOMEID_USER_AGENT = 'HomeID/8.16.0 (com.philips.ka.oneka.app; build:8160001; Android 14)';
const HOMEID_X_USER_AGENT = 'Android 14;8.16.0';

const MQTT_URL = 'wss://ats.prod.eu-da.iot.versuni.com:443/mqtt';
const MQTT_KEEPALIVE = 60;
const MQTT_CUSTOM_AUTHORIZER = 'CustomAuthorizer';

const TOPIC_CONTROL = (deviceId) => `da_ctrl/${deviceId}/to_ncp`;
const TOPIC_STATUS = (deviceId) => `da_ctrl/${deviceId}/from_ncp`;
const TOPIC_SHADOW_UPDATE = (deviceId) => `$aws/things/${deviceId}/shadow/update`;
const TOPIC_SHADOW_GET = (deviceId) => `$aws/things/${deviceId}/shadow/get`;

const DEFAULT_PORTS = {
  status: 'Status',
  control: 'Control',
  config: 'Config',
  filter_read: 'filtRd',
  filter_write: 'filtWr',
};

const TOKEN_REFRESH_BUFFER_MS = 15 * 60 * 1000;
const STATUS_POLL_INTERVAL_S = 120;
const FILTER_POLL_INTERVAL_MS = 30 * 60 * 1000;

module.exports = {
  PLUGIN_NAME,
  PLATFORM_NAME,
  API_BASE_URL,
  DEVICE_ENDPOINT,
  SIGNATURE_ENDPOINT,
  USER_SELF_ENDPOINT,
  HTTP_USER_AGENT,
  GIGYA_API_KEY,
  GIGYA_OTP_SEND_ENDPOINT,
  GIGYA_OTP_LOGIN_ENDPOINT,
  GIGYA_SOCIALIZE_GET_IDS,
  OIDC_AUTHORIZE,
  OIDC_AUTHORIZE_CONTINUE,
  OIDC_TOKEN,
  CLIENT_ID_AIRPLUS,
  REDIRECT_URI_AIRPLUS,
  SCOPES_AIRPLUS,
  CLIENT_ID_HOMEID,
  REDIRECT_URI_HOMEID,
  SCOPES_HOMEID,
  HOMEID_BACKEND_BASE,
  HOMEID_BACKEND_API,
  HOMEID_ACCEPT,
  HOMEID_USER_AGENT,
  HOMEID_X_USER_AGENT,
  MQTT_URL,
  MQTT_KEEPALIVE,
  MQTT_CUSTOM_AUTHORIZER,
  TOPIC_CONTROL,
  TOPIC_STATUS,
  TOPIC_SHADOW_UPDATE,
  TOPIC_SHADOW_GET,
  DEFAULT_PORTS,
  TOKEN_REFRESH_BUFFER_MS,
  STATUS_POLL_INTERVAL_S,
  FILTER_POLL_INTERVAL_MS,
};
