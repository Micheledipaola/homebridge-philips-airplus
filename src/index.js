'use strict';

const { PLATFORM_NAME, PLUGIN_NAME } = require('./constants');
const { PhilipsAirPlusPlatform } = require('./platform');

module.exports = (api) => {
  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, PhilipsAirPlusPlatform);
};
