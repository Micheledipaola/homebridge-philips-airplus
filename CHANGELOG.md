# Changelog — Homebridge plugin

The Home Assistant integration in `custom_components/` is unchanged from upstream and keeps its own history.

## 0.4.0 — 2026-10-25

- Added the Philips Air+ icon to the README.
- Added a PayPal Donate link and npm funding metadata.
- Fixed invalid JSON in `package.json` caused by a missing comma after `devDependencies`.

## 0.3.10 — 2026-10-20

- Requires Node.js 22, 24 or 26, the versions Homebridge supports; Node 18 and 20 are end-of-life. No functional changes.

## 0.3.9 — 2026-10-11

- New **Allergens** sensor on models that report the Philips allergen index (AC0651/10, AC1715/11, AC3221). HomeKit has no allergen reading, so the index (1–12) is shown as a second air quality sensor: 1 Excellent, 2–3 Good, 4–6 Fair, 7–9 Inferior, 10–12 Poor. Option `allergenSensor` (default on).

## 0.3.8 — 2026-10-11

- Homebridge verification: `supports-hap` keyword; config schema uses object-level `required` arrays instead of per-field `required: true`. No functional changes.

## 0.3.7 — 2026-10-11

- Removed the `labelRefresh` option added in 0.3.5: it did not help, the missing labels were caused by linked components (fixed in 0.3.6). A leftover `labelRefresh` value in the config is simply ignored.

## 0.3.6 — 2026-10-11

- Components (Sleep, Air Quality, Filter, Pre-filter, Display) are no longer linked to the purifier by default. The Home app draws linked components as controls of the purifier without their names; unlinked ones get their own labelled tile in the purifier's combined view. Existing links are removed on startup. Set `linkComponents: true` to link them again.

## 0.3.5 — 2026-10-11

- Option `labelRefresh`: if the Home app does not show the labels under the purifier's components in its combined view, set any new value and restart. About 40 s after startup the plugin renames the components in two steps (long name, then short label), replaying the rename that made Home show the labels before. Names set in the Home app are replaced by the defaults.

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
