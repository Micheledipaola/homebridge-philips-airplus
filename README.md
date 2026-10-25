<p align="center">
  <img width="160" height="160" alt="airpluscloud-icon" src="https://github.com/user-attachments/assets/2068eb3b-b277-4de0-b5d9-f61ac2ca7408" border="1" style="border: 1px solid black;" />
</p>
<br />

![verified-by-homebridge](https://img.shields.io/badge/homebridge-verified-blueviolet?color=%23491F59&style=for-the-badge&logoColor=%23FFFFFF&logo=homebridge)

# homebridge-philips-airplus-cloud

Homebridge plugin for **Philips Air+** air purifiers (AC0650, AC0651, AC1715, PureProtect 3200i and others in the same family). It brings them into Apple Home through the Philips/Versuni **cloud**, with the same MQTT protocol used by the official Air+ app and Google Home. No local connection, IP address or port forwarding is needed.

## A Homebridge port of a Home Assistant integration

This repository is a fork of [NikGro/philips-air-plus-homeassistant](https://github.com/NikGro/philips-air-plus-homeassistant), a Home Assistant integration that is itself based on [ShorMeneses/philips-airplus-homeassistant](https://github.com/ShorMeneses/philips-airplus-homeassistant). The fork ports that integration to Homebridge:

- the cloud protocol (email + code login, token refresh, MQTT over WebSocket with the AWS custom authorizer) is re-implemented in Node.js in `src/`;
- device definitions are **not** duplicated: the plugin reads the same `custom_components/philips_airplus/models.yaml` as the Home Assistant integration, so modes and property keys stay in sync with upstream;
- the Home Assistant integration in `custom_components/` is kept unchanged from upstream so the two can be merged easily. If you use Home Assistant, install it from [the upstream repository](https://github.com/NikGro/philips-air-plus-homeassistant) instead.

## What you get in HomeKit

One accessory per purifier with:

- **Air Purifier** — on/off, Auto/Manual, and a speed slider split into one band per manual mode of your model (e.g. 0–33% Sleep, 34–66% Medium, 67–100% Turbo on the AC0651/10); it snaps to the band after each change. Switching back to Manual restores the last manual speed.
- **Sleep switch** — turns Sleep mode on; turning it off returns to Auto.
- **Display light** — the purifier's display/LED as a dimmable light. It appears after the purifier first reports its light setting (property `D03104`, `D03105` or `D0312D`); devices with three light levels are detected automatically.
- **Air Quality Sensor** — PM2.5 (µg/m³) and a HomeKit air-quality level derived from it.
- **Allergens** — on models that report the Philips allergen index (1–12): a second air quality sensor whose level follows the index (1 Excellent, 2–3 Good, 4–6 Fair, 7–9 Inferior, 10–12 Poor). HomeKit has no allergen or pollen reading of its own.
- **Filter Maintenance** — main filter and pre-filter (cleaning), with life level, change alert (below 10% by default) and reset from the Home app. The reset writes the same value the official app does.

State changes arrive in real time over MQTT; a status poll runs every 120 s as a safety net.

## Install

Search for **Philips Air+ cloud** in Homebridge UI → Plugins and install it, or from a terminal:

```bash
# Homebridge Raspberry Pi image / hb-service (Homebridge UI → ⋮ → Terminal)
cd /var/lib/homebridge
npm install homebridge-philips-airplus-cloud

# global npm install of Homebridge
sudo npm install -g homebridge-philips-airplus-cloud
```

Then restart Homebridge. Node 22, 24 or 26 (the versions Homebridge itself supports) and Homebridge 1.6+ or 2.x are required.

To try the latest unreleased code, install from GitHub instead: `npm install git+https://github.com/Micheledipaola/homebridge-philips-airplus.git`.

Homebridge does not need to be on the same network as the purifier: everything goes through the Philips cloud.

> The npm package is called `homebridge-philips-airplus-cloud` because `homebridge-philips-airplus` is an unrelated plugin for Philips Air+ humidifiers.

## Log in

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

## Options

| Key | Default | Meaning |
|---|---|---|
| `devices` | all | `[{ "uuid": "…", "name": "…", "model": "AC0651/10" }]` — pick/rename devices; `model` is only needed if auto-detection fails |
| `airQualitySensor` | `true` | Show the PM2.5 sensor |
| `allergenSensor` | `true` | Show the allergen index as a second air quality sensor (models that report it) |
| `filterSensors` | `true` | Show filter and pre-filter status |
| `sleepSwitch` | `true` | Show the Sleep mode switch |
| `sleepSwitchStyle` | `switch` | `purifier` shows the Sleep control as a second air purifier (purifier icon in Home) that only turns Sleep on/off |
| `linkComponents` | `false` | Link Sleep, air quality and filters to the purifier. Off: each gets its own labelled tile in the purifier's combined view. On: Home shows them as controls inside the purifier, without labels |
| `displayLight` | `true` | Show the display light |
| `displayLightProperty` | — | Property key of the display light, if it is not detected (see the `Status properties reported by the device` log line) |
| `logDeviceData` | `false` | Diagnostics: at startup, log every port and the cloud shadow the purifier publishes |
| `homekitIdentity` | — | Change to any new value to give the purifier a new HomeKit identity (use only if the Home app refuses to move or rename it; reassign the room afterwards) |
| `filterChangeThreshold` | `10` | Filter life (%) at or below which HomeKit shows "replace filter" |
| `pollInterval` | `120` | Seconds between safety-net status polls |

## Running alongside Home Assistant or the app

Each client uses its own MQTT client id (`…_hb` for Homebridge, `…_ha` for Home Assistant), so the Air+ app, Home Assistant and Homebridge can all stay connected at the same time.

## Notes

- Tested on an AC0651/10. The other models in `models.yaml` use the same protocol but have not been tried with Homebridge yet — reports are welcome.
- The AC0651/10 does not expose its display brightness through the cloud (the Philips app has no control for it either; the display turns off by itself in Sleep), so no Display control appears for it.
- Models not in `models.yaml` still get on/off, PM2.5 and filters, and a warning in the log; modes need a `models.yaml` entry.
- The AC3221 (PureProtect 3200i) mapping is unverified (see below), and so is its speed order in HomeKit.
- `npm test` runs the plugin tests (protocol, HomeKit mapping, login flow with a mocked cloud).

## Models

Model support comes from `models.yaml`:

| Model | Modes | Air quality |
|-------|-------|-------------|
| AC0650/10 | Auto, Sleep, Turbo | PM2.5 |
| AC0651/10 | Auto, Medium, Sleep, Turbo | PM2.5 (allergen index not shown in HomeKit) |
| AC1715/11 | Auto, Medium, Sleep, Fast, Turbo | PM2.5 |
| AC1715/70 | Auto, Medium, Sleep, Fast, Turbo | PM2.5 |
| AC3221 (PureProtect 3200i) | Auto, Speed 1–5, Sleep, Medium, Turbo | PM2.5 (mapping unverified upstream) |

New models are added with an entry in `models.yaml`, with no code changes, and then work in both Homebridge and Home Assistant. The cloud property keys (`D03xxx`/`D05xxx`) follow the same scheme as the local CoAP API documented by [kongo09/philips-airpurifier-coap](https://github.com/kongo09/philips-airpurifier-coap).

## Credits

The protocol work comes from the Home Assistant integration this plugin is ported from. Thanks to:
- @ShorMeneses — original cloud/MQTT integration this fork is based on
- @vkostakos
- @markusstephany
- @renaudallard — the email OTP authentication flow is adapted from the [Philips HomeID integration](https://github.com/renaudallard/homeassistant_philips_homeid)
- @rgpublic — AC1715/11 model configuration
- @NikGro — PureProtect 3200i (AC3221) mapping and the email + code onboarding

## License

Released under the MIT License, like the integration it is based on. See LICENSE.
