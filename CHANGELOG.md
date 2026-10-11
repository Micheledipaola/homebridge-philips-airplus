# Changelog — Homebridge plugin

The Home Assistant integration in `custom_components/` is unchanged from upstream and keeps its own history.

## 0.3.4 — 2026-10-11

- Fix (0.3.3 regression): on Homebridge 2.x a newly created accessory could be left out of HomeKit ("has the same UUID as existing accessory … Skipping duplicate"), because its settings were saved before it was registered. Accessories are now only updated after registration.

## 0.3.3 — 2026-10-11

- Fix: the plugin could stop updating when the cloud connection stayed open but stopped delivering data. If the purifier sends nothing for three status polls (at least 6 minutes), the connection is now rebuilt.
- Fix: a new accessory is announced to HomeKit only once all its services exist, so the Home app sees the labelled, linked components from the start.

## 0.3.2 — 2026-10-11

- Option `homekitIdentity`: gives the purifier a new HomeKit identity when the Home app keeps a stuck record of it (rooms and names cannot be changed). The previous accessory is removed automatically.

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
