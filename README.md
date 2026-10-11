# Philips Air+ for Home Assistant and Homebridge

This fork works with **both** Home Assistant (`custom_components/philips_airplus`, unchanged) and **Homebridge** (the Node plugin in `src/`). Both talk to the Philips/Versuni cloud with the same MQTT protocol as the official Air+ app and Google Home, and both read device definitions from the same `models.yaml`, so a model added there works in both.

## Homebridge

### What you get in HomeKit

One accessory per purifier with:

- **Air Purifier** — on/off, Auto/Manual, and a speed slider split into one band per manual mode of your model (e.g. 0–33% Sleep, 34–66% Medium, 67–100% Turbo on the AC0651/10); it snaps to the band after each change. Switching back to Manual restores the last manual speed.
- **Sleep switch** — turns Sleep mode on; turning it off returns to Auto.
- **Display light** — the purifier's display/LED as a dimmable light. It appears after the purifier first reports its light setting (property `D03104`, `D03105` or `D0312D`); devices with three light levels are detected automatically.
- **Air Quality Sensor** — PM2.5 (µg/m³) and a HomeKit air-quality level derived from it.
- **Filter Maintenance** — main filter and pre-filter (cleaning), with life level, change alert (below 10% by default) and reset from the Home app. The reset writes the same value the official app does.

State changes arrive in real time over MQTT; a status poll runs every 120 s as a safety net.

### Install

The plugin is not on npm. Install it from this repository (Homebridge UI → Terminal, or a shell on the Homebridge host):

```bash
sudo npm install -g git+https://github.com/<your-account>/philips-air-plus-homeassistant.git
```

Then restart Homebridge. Node 18.17 or newer and Homebridge 1.6+ (including 2.0 betas) are supported.

### Log in

1. Homebridge UI → Plugins → **Philips Air+** → Settings.
2. Enter the email of your Philips account (Air+ or HomeID app) and press **Send code**.
3. Type the code from the email and press **Log in**. The panel lists the purifiers it found and saves the login.
4. Restart Homebridge.

Every purifier in the account is added. To pick only some, or to rename them, fill in **Devices** with the UUIDs shown after login.

Without Homebridge UI, run the login from a shell and paste the printed block into the `platforms` array of `config.json`:

```bash
philips-airplus-login you@example.com
```

```json
{
  "platform": "PhilipsAirPlus",
  "name": "Philips Air+",
  "email": "you@example.com",
  "refreshToken": "…",
  "clientId": "-XsK7O6iEkLml77yDGDUi0ku",
  "userId": "…"
}
```

The refresh token rotates on every use; the plugin keeps the current one in `<homebridge storage>/philips-airplus/`. If the Philips login ever expires, the log says so: log in again from the settings panel and restart.

### Options

| Key | Default | Meaning |
|---|---|---|
| `devices` | all | `[{ "uuid": "…", "name": "…", "model": "AC0651/10" }]` — pick/rename devices; `model` is only needed if auto-detection fails |
| `airQualitySensor` | `true` | Show the PM2.5 sensor |
| `filterSensors` | `true` | Show filter and pre-filter status |
| `sleepSwitch` | `true` | Show the Sleep mode switch |
| `displayLight` | `true` | Show the display light |
| `displayLightProperty` | — | Property key of the display light, if it is not detected (see the `Status properties reported by the device` log line) |
| `filterChangeThreshold` | `10` | Filter life (%) at or below which HomeKit shows "replace filter" |
| `pollInterval` | `120` | Seconds between safety-net status polls |

### Running alongside Home Assistant or the app

Each client uses its own MQTT client id (`…_hb` for Homebridge, `…_ha` for Home Assistant), so the Air+ app, Home Assistant and Homebridge can all stay connected at the same time.

### Notes

- Models not in `models.yaml` still get on/off, PM2.5 and filters, and a warning in the log; modes need a `models.yaml` entry.
- The AC3221 (PureProtect 3200i) mapping is unverified (see below), and so is its speed order in HomeKit.
- `npm test` runs the plugin tests (protocol, HomeKit mapping, login flow with a mocked cloud).

---

# Home Assistant integration

Custom integration for Philips Air+ air purifiers. It communicates with the Philips/Versuni **cloud** service using the same MQTT protocol as the official mobile app and Google Home — no local CoAP connection, so no CoAP-style dropouts.

This is a fork of [ShorMeneses/philips-airplus-homeassistant](https://github.com/ShorMeneses/philips-airplus-homeassistant) with two changes:

- **PureProtect 3200i (AC3221) support** added to `models.yaml`. The CoAP-based [ruaan-deysel/ha-philips-airpurifier](https://github.com/ruaan-deysel/ha-philips-airpurifier) already supports this device, but it talks to it locally via CoAP, which on some networks causes frequent connection drops. This fork keeps the original's cloud/MQTT transport (the same backend Google Home uses) and adds the model mapping so the 3200i works through it too. The property keys were mapped from the confirmed CoAP addressing scheme for the AC32xx family (see [Architecture](#architecture)) rather than from a captured cloud payload — please open an issue with debug logs if any entity reports an incorrect value.
- **Smoother onboarding.** Email + verification code is now the default, recommended setup path — no browser DevTools needed. The original OAuth PKCE flow (which required pulling a redirect URL out of the browser Network tab) is kept only as an advanced fallback for accounts where the email flow doesn't apply.

## Features

- Fan control with preset modes and on/off
- Fan level sensor with history, useful in Auto mode to see current intensity
- Filter replacement and cleaning life sensors
- Maintenance resets via buttons or HA services
- Real-time updates via MQTT subscription
- Air quality sensors: PM2.5 concentration and allergen index
- Standby monitor support for AC0651/10

## Supported Devices

| Model | Modes | Fan Level | Filter Monitoring | Air Quality | Standby Monitor |
|-------|-------|-----------|-------------------|-------------|-----------------|
| AC0650/10 | Auto, Sleep, Turbo | Yes | Yes | PM2.5 | No |
| AC0651/10 | Auto, Medium, Sleep, Turbo | Yes | Yes | PM2.5, Allergen Index | Yes |
| AC1715/11 | Auto, Medium, Sleep, Fast, Turbo | Yes | Yes | PM2.5, Allergen Index | No |
| AC1715/70 | Auto, Medium, Sleep, Fast, Turbo | Yes | Yes | PM2.5 | No |
| AC3221 (PureProtect 3200i) | Auto, Speed1-5, Sleep, Medium, Turbo | Yes | Yes | PM2.5, Allergen Index | No (unverified, see note above) |

Other Air+ models sharing the same MQTT protocol may work but are untested. New models can be added via `models.yaml` without code changes.

## Installation

### via HACS (Recommended)

1. Go to HACS > Integrations
2. Click the three dots menu and select "Custom repositories"
3. Add repository: `https://github.com/NikGro/philips-air-plus-homeassistant`
4. Select "Integration" as category
5. Click "Add"
6. Go to HACS > Integrations and search for "Philips Air+"
7. Click "Install" and restart Home Assistant

### Manual Installation

1. Copy the `custom_components/philips_airplus` directory to your Home Assistant `config/custom_components` directory
2. Restart Home Assistant

## Configuration

### Prerequisites

A Philips account (Philips Air+ or Philips HomeID) with your device already set up in the official mobile app.

### Authentication: Email + Verification Code (Recommended, default)

This is the cloud account flow — the same one used by Google Home — and needs no browser or DevTools.

1. Add the integration in Home Assistant. **Email + verification code** is preselected.
2. Enter the email address associated with your Philips account.
3. Check your inbox for the verification code.
4. Enter the code in Home Assistant.
5. Select your device.

Works with both Philips Air+ and Philips HomeID accounts.

### Authentication: OAuth PKCE Flow (Advanced fallback)

Only needed if the email flow doesn't work for your account. For accounts registered via **Philips Air+** only.

1. Add the integration in Home Assistant and choose **OAuth PKCE (advanced)**. A login URL will be shown.
2. Open that URL in your browser.
3. Before logging in, open browser DevTools and switch to the Network tab.
4. Complete the login and authorization on the Philips website.
5. In the Network tab, find the redirect to `com.philips.air://loginredirect?code=...` and copy the full URL.
6. Paste it into Home Assistant as the Authorization Code.

Notes:

- On desktop browsers, the `com.philips.air://...` request will fail to open. This is expected.
- You can paste the full redirect URL or just the code value; the integration extracts the code automatically.
- If the token expires, go to Integration > Configure and re-authenticate. No need to remove and re-add the integration.

## Services

Two HA services are registered:

- `philips_airplus.reset_filter_clean` replicates the official app's "Filter cleaned" reset
- `philips_airplus.reset_filter_replace` replicates the official app's "New filter" reset

Both accept an optional `device_uuid` parameter to target a specific device when multiple are configured.

## Architecture

All device-specific behavior is driven by `models.yaml`. Each model entry declares its MQTT properties, preset modes, and which sensors, switches, and buttons to create. Adding support for a new model requires only a new entry in `models.yaml`.

Entities are registered lazily: the integration waits for the device to report its model identifier over MQTT before creating entities, so `device_info` can contain the correct model name from the start.

The cloud MQTT property keys (`D03xxx`/`D05xxx`) use the same addressing scheme as the device's local CoAP API (see [kongo09/philips-airpurifier-coap](https://github.com/kongo09/philips-airpurifier-coap)), which is how the AC3221 entry in this fork was derived without a real cloud capture for that model.

## Contributions

Thanks to:
- @ShorMeneses — original cloud/MQTT integration this fork is based on
- @vkostakos
- @markusstephany
- @renaudallard — the email OTP authentication flow is adapted from the [Philips HomeID integration](https://github.com/renaudallard/homeassistant_philips_homeid)
- @rgpublic — AC1715/11 model configuration

## License

This integration is released under the MIT License. See LICENSE file for details.
