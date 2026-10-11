# Changelog — Homebridge plugin

The Home Assistant integration in `custom_components/` is unchanged from upstream and keeps its own history.

## 0.3.1 — 2026-10-11

- Fix: on a fresh install the purifier started with the reduced profile ("Model AC0651 is not in models.yaml") because the cloud device list gives the model without its `/10` suffix. The short code now matches its `models.yaml` entry, and an unknown code waits for the exact one reported by the device.

## 0.3.0 — 2026-10-11

- Published on npm as `homebridge-philips-airplus-cloud` (the name `homebridge-philips-airplus` belongs to an unrelated humidifier plugin). Installs from the earlier `.tgz` or git builds were named `homebridge-philips-airplus`: uninstall that first.
- Option `sleepSwitchStyle: "purifier"`: Sleep shown as a second air purifier (purifier icon in Home), linked to the main one.
- Diagnostics option `logDeviceData`: logs every port and the cloud shadow the purifier publishes.
- Display light also detected on `D03104` (0/115/123); manual override with `displayLightProperty`.
- Sleep, Display, Air Quality and filter services are linked to the purifier with short labels, so Home shows them as labelled controls inside the purifier.

## 0.2.0 — 2026-10-11

- Sleep mode switch.
- Display light as a dimmable light when the purifier reports it.
- Speed slider back to 0–100 %, one band per manual mode (the Home app always shows it as a percentage).

## 0.1.0 — 2026-10-10

- First version: email + code login (Homebridge UI panel or `philips-airplus-login`), automatic token refresh, MQTT over the Philips/Versuni cloud.
- HomeKit Air Purifier (power, Auto/Manual, speed), Air Quality Sensor (PM2.5), Filter Maintenance for filter and pre-filter with reset.
- Device definitions read from the shared `models.yaml`.
