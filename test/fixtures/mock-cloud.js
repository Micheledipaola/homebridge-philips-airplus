'use strict';
// Preloaded into the settings-panel server in tests: fakes the Philips cloud.
// MOCK_USER_SELF=403 makes /user/self fail like it did for some accounts.
global.fetch = async (url, init = {}) => {
  const res = (status, body, headers = {}) =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers });
  const u = new URL(url);
  if (u.pathname.endsWith('otp.email.sendCode')) return res(200, { errorCode: 0, vToken: 'VT-123' });
  if (u.pathname.endsWith('otp.email.login')) {
    const body = new URLSearchParams(init.body);
    if (body.get('vToken') !== 'VT-123' || body.get('code') !== '111222') return res(200, { errorCode: 403042, errorMessage: 'Invalid code' });
    return res(200, { errorCode: 0, sessionInfo: { cookieValue: 'SESSION' } });
  }
  if (u.pathname.endsWith('/authorize')) return res(302, '', { location: 'https://x/proxy?context=CTX' });
  if (u.pathname.endsWith('socialize.getIDs')) return res(200, { gmidTicket: 'GMID' });
  if (u.pathname.endsWith('/authorize/continue')) return res(302, '', { location: 'com.philips.air://loginredirect?code=C' });
  if (u.pathname.endsWith('/token')) return res(200, { access_token: 'AT', refresh_token: 'RT', expires_in: 3600 });
  if (u.pathname.endsWith('/user/self/device')) return res(200, [{ uuid: 'da-abc', name: 'Bedroom', ctn: 'AC0651/10' }]);
  if (u.pathname.endsWith('/user/self')) {
    if (process.env.MOCK_USER_SELF === '403') return res(403, '{"Message":"User is not authorized"}');
    return res(200, { id: 'USER' });
  }
  return res(404, 'nope');
};
