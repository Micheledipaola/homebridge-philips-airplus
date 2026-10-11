'use strict';

// Reads the same models.yaml used by the Home Assistant integration, so a new
// model added there works in Homebridge too.

const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const MODELS_FILE = path.join(__dirname, '..', 'custom_components', 'philips_airplus', 'models.yaml');

// Order manual modes from quietest to strongest for the HomeKit speed slider.
const SPEED_RANK = { sleep: 0, speed1: 1, speed2: 2, speed3: 3, speed4: 4, speed5: 5, medium: 6, fast: 7, turbo: 8 };

let cache = null;

function loadModels(file = MODELS_FILE) {
  if (!cache || file !== MODELS_FILE) {
    const data = yaml.load(fs.readFileSync(file, 'utf8'));
    const models = (data && data.models) || {};
    if (file !== MODELS_FILE) return models;
    cache = models;
  }
  return cache;
}

/**
 * Exact match first, then prefix match either way:
 *  - "AC3221/10" -> "AC3221"     (device reports a longer code than the yaml key)
 *  - "AC0651"    -> "AC0651/10"  (the cloud device list omits the /xx suffix)
 */
function findModel(ctn) {
  if (!ctn) return null;
  const code = String(ctn).trim().toUpperCase();
  const models = loadModels();
  const entries = Object.entries(models);
  const exact = entries.find(([key]) => key.toUpperCase() === code);
  if (exact) return { key: exact[0], ...exact[1] };
  const longer = entries.find(([key]) => code.startsWith(key.toUpperCase()));
  if (longer) return { key: longer[0], ...longer[1] };
  const base = entries.find(([key]) => key.toUpperCase().startsWith(`${code}/`));
  if (base) return { key: base[0], ...base[1] };
  return null;
}

/** Manual (non-auto) modes in slider order. */
function speedModes(model) {
  return Object.keys(model.modes || {})
    .filter((m) => m.toLowerCase() !== 'auto')
    .sort((a, b) => (SPEED_RANK[a.toLowerCase()] ?? 50) - (SPEED_RANK[b.toLowerCase()] ?? 50));
}

function modeName(model, value) {
  for (const [name, v] of Object.entries(model.modes || {})) if (v === value) return name;
  return null;
}

module.exports = { loadModels, findModel, speedModes, modeName, MODELS_FILE };
