'use strict';

// Server side of the custom settings UI: performs the email + code login so
// users never have to copy tokens around by hand.

const { LoginSession } = require('../src/cloud');

(async () => {
  const { HomebridgePluginUiServer, RequestError } = await import('@homebridge/plugin-ui-utils');

  class UiServer extends HomebridgePluginUiServer {
    constructor() {
      super();
      this.session = null;

      this.onRequest('/send-code', async ({ email } = {}) => {
        if (!email || !/.+@.+\..+/.test(email)) throw new RequestError('Enter a valid email address', {});
        this.session = new LoginSession({ log: (m) => console.log(`[philips-airplus-ui] ${m}`) });
        try {
          await this.session.sendCode(email);
        } catch (e) {
          throw new RequestError(e.message, {});
        }
        return { sent: true };
      });

      this.onRequest('/verify-code', async ({ code } = {}) => {
        if (!this.session) throw new RequestError('Request a new code first', {});
        try {
          await this.session.verifyCode(code);
          const result = await this.session.completeLogin();
          return {
            refreshToken: result.refreshToken,
            clientId: result.clientId,
            userId: result.userId,
            devices: result.devices,
          };
        } catch (e) {
          throw new RequestError(e.message, {});
        }
      });

      this.ready();
    }
  }

  return new UiServer();
})();
