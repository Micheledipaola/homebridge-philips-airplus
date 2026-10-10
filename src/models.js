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

/** Exact match first, then prefix match (e.g. "AC3221/10" -> "AC3221"). */
function findModel(ctn) {
  if (!ctn) return null;
  const models = loadModels();
  if (models[ctn]) return { key: ctn, ...models[ctn] };
  for (const [key, cfg] of Object.entries(models)) {
    if (String(ctn).startsWith(key)) return { key, ...cfg };
  }
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
