#!/usr/bin/env node
'use strict';

// Command-line login for setups without Homebridge UI: asks for the email and
// the verification code, then prints the platform block for config.json.

const readline = require('node:readline/promises');
const { LoginSession } = require('../src/cloud');

(async () => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    const email = (process.argv[2] || (await rl.question('Philips account email: '))).trim();
    const s = new LoginSession({ log: (m) => console.error(`  ${m}`) });
    await s.sendCode(email);
    const code = await rl.question(`Code sent to ${email}. Enter it: `);
    await s.verifyCode(code);
    const r = await s.completeLogin();

    console.error(`\nLogged in. Purifiers in the account:`);
    for (const d of r.devices) console.error(`  - ${d.name} [${d.model || '?'}] ${d.uuid}`);
    if (!r.devices.length) console.error('  (none found — add "devices": [{ "uuid": "..." }] by hand)');

    console.error('\nAdd this to the "platforms" array of your Homebridge config.json:\n');
    console.log(
      JSON.stringify(
        { platform: 'PhilipsAirPlus', name: 'Philips Air+', email, refreshToken: r.refreshToken, clientId: r.clientId, userId: r.userId },
        null,
        2,
      ),
    );
  } catch (e) {
    console.error(`\nLogin failed: ${e.message}`);
    process.exitCode = 1;
  } finally {
    rl.close();
  }
})();
