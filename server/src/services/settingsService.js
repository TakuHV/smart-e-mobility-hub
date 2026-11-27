import { db, nowIso } from '../database/db.js';
import { config, updateConfig, resetConfig, editableConfig, fileConfig, ConfigError } from '../config.js';
import { HttpError, requireRole, auditChange } from './commonService.js';

/*
 * Settings changed in the Admin area. data/configuration.json stays the baseline; the changes are stored in the
 * database (table app_settings) and applied on top of it at every start. "Reset" removes them.
 */
const KEY = 'config_overrides';
const isPlainObject = value => value && typeof value === 'object' && !Array.isArray(value);

function deepMerge(base, patch) {
  const result = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    result[key] = isPlainObject(value) && isPlainObject(base[key]) ? deepMerge(base[key], value) : value;
  }
  return result;
}

const storedOverrides = () => {
  const row = db.prepare('SELECT value_json FROM app_settings WHERE key=?').get(KEY);
  return row ? JSON.parse(row.value_json) : null;
};

// Called once at start, after the database is ready.
export function loadSavedSettings() {
  try {
    const stored = storedOverrides();
    if (!stored) return { applied: false };
    updateConfig(stored);
    return { applied: true };
  } catch (error) {
    console.error('Saved settings were ignored:', error.message);
    return { applied: false, error: error.message };
  }
}

export function getSettings() {
  const stored = storedOverrides();
  return { values: editableConfig(), defaults: fileConfig(), customised: Boolean(stored), changedSections: stored ? Object.keys(stored) : [] };
}

export function saveSettings({ user, patch }) {
  requireRole(user, ['Admin']);
  try { updateConfig(patch); }
  catch (error) {
    if (error instanceof ConfigError) throw new HttpError(400, error.message, error.problems);
    throw error;
  }
  const merged = deepMerge(storedOverrides() ?? {}, patch);
  db.prepare(`INSERT INTO app_settings (key, value_json, updated_at, updated_by) VALUES (?, ?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at, updated_by=excluded.updated_by`)
    .run(KEY, JSON.stringify(merged), nowIso(), user.id);
  auditChange('Settings', 'configuration', 'SETTINGS_CHANGED', { patch }, user.id);
  return getSettings();
}

export function resetSettings({ user }) {
  requireRole(user, ['Admin']);
  resetConfig();
  db.prepare('DELETE FROM app_settings WHERE key=?').run(KEY);
  auditChange('Settings', 'configuration', 'SETTINGS_RESET', {}, user.id);
  return getSettings();
}

export const currentConfig = () => config;
