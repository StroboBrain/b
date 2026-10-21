import { configsEqual, validateConfig } from './breathing-engine.js';

const PRESET_OVERRIDES_KEY = 'breathing.preset-overrides.v1';
const SELECTION_KEY = 'breathing.selection.v1';
const PREFERENCES_KEY = 'breathing.preferences.v1';

export const HOLD_FEEDBACK_VARIANTS = Object.freeze(['rise', 'sweep', 'spread', 'fade']);

export const DEFAULT_PREFERENCES = Object.freeze({
  showBreathText: true,
  showBreathNumbers: true,
  showBreathGuides: true,
  showPhaseTimings: true,
  fadeButtons: false,
  soundCue: false,
  holdFeedback: 'rise',
});

const freezePreset = (preset) => Object.freeze({
  ...preset,
  config: Object.freeze(preset.config),
});

/** Four built-in exercises. Added presets and edits share local storage with stable IDs. */
const BASE_PRESETS = Object.freeze([
  freezePreset({ id: 'box', name: 'Box breathing', config: { inhale: 4, holdIn: 4, exhale: 4, holdOut: 4 } }),
  freezePreset({ id: 'slow', name: 'Slow breathing', config: { inhale: 4, holdIn: 0, exhale: 6, holdOut: 0 } }),
  freezePreset({ id: '478', name: '4–7–8 breathing', config: { inhale: 4, holdIn: 7, exhale: 8, holdOut: 0 } }),
  freezePreset({ id: 'equal', name: 'Equal breathing', config: { inhale: 5, holdIn: 0, exhale: 5, holdOut: 0 } }),
]);

const findBase = (id) => BASE_PRESETS.find((preset) => preset.id === id);
const isAddedId = (id) => typeof id === 'string'
  && /^preset-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id);
const isLegacyId = (id) => id === 'custom-1' || id === 'custom-2';

function presetsFromOverrides(overrides) {
  return [
    ...BASE_PRESETS.map((preset) => overrides.find((entry) => entry.id === preset.id) ?? copyPreset(preset))
      .filter((preset) => !preset.deleted),
    ...overrides.filter((preset) => !findBase(preset.id)),
  ];
}

export class PersistenceError extends Error {
  constructor(cause) {
    super('Your browser could not save this change on this device.', { cause });
    this.name = 'PersistenceError';
  }
}

function defaultStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function validateName(name) {
  if (typeof name !== 'string') {
    throw new TypeError('Give your preset a name.');
  }
  const trimmed = name.trim();
  if (trimmed.length === 0 || trimmed.length > 32) {
    throw new RangeError('Preset names must contain 1–32 characters.');
  }
  return trimmed;
}

function copyPreset(preset) {
  return { id: preset.id, name: preset.name, config: { ...preset.config } };
}

function validatePreference(key, value) {
  if (key === 'holdFeedback') {
    if (typeof value !== 'string') {
      throw new TypeError('The hold feedback preference must be a string.');
    }
    if (!HOLD_FEEDBACK_VARIANTS.includes(value)) {
      throw new RangeError('Choose an available hold feedback style.');
    }
  } else if (typeof value !== 'boolean') {
    throw new TypeError('Toggle preferences must be booleans.');
  }
  return value;
}

function normalizePreferences(preferences, strict) {
  const normalized = { ...DEFAULT_PREFERENCES };
  if (!preferences || typeof preferences !== 'object' || Array.isArray(preferences)) {
    if (strict) throw new TypeError('Display preferences must be an object.');
    return normalized;
  }
  if (strict && !Object.keys(normalized).some((key) => Object.hasOwn(preferences, key))) {
    throw new TypeError('Provide at least one known display preference.');
  }
  for (const key of Object.keys(normalized)) {
    if (!Object.hasOwn(preferences, key)) continue;
    try {
      normalized[key] = validatePreference(key, preferences[key]);
    } catch (error) {
      if (strict) throw error;
    }
  }
  return normalized;
}

/**
 * Local preset and preference storage. Reads tolerate unavailable or corrupt data;
 * writes throw PersistenceError when persistence cannot be confirmed.
 * Configurations follow the breathing engine's validateConfig contract.
 */
export class PresetStore {
  #storage;

  static affectsPresets(key) { return key === null || key === PRESET_OVERRIDES_KEY; }

  static affectsPreferences(key) { return key === null || key === PREFERENCES_KEY; }

  constructor({ storage = defaultStorage() } = {}) {
    this.#storage = storage;
  }

  /** @returns {Array<{id: string, name: string, config: object}>} All presets with saved edits. */
  listPresets() {
    return presetsFromOverrides(this.#readOverrides(false));
  }

  /** Delete any preset, including built-ins, while keeping at least two available. */
  deletePreset(id) {
    if (typeof id !== 'string') throw new TypeError('A preset ID must be a string.');
    const previous = this.#readOverrides(true);
    const presets = presetsFromOverrides(previous);
    if (!presets.some((preset) => preset.id === id)) throw new RangeError('Choose an available preset.');
    if (presets.length <= 2) throw new RangeError('Keep at least two presets.');
    const overrides = previous.filter((preset) => preset.id !== id);
    if (findBase(id)) overrides.push({ id, deleted: true });
    this.#write(PRESET_OVERRIDES_KEY, overrides);
  }

  /** Save an added preset or edit a built-in; unchanged built-ins store no override. */
  savePreset(id, name, config) {
    if (typeof id !== 'string') throw new TypeError('A preset ID must be a string.');
    const normalizedName = validateName(name);
    const normalizedConfig = validateConfig(config);
    const base = findBase(id);
    const preset = { id, name: normalizedName, config: normalizedConfig };
    const previous = this.#readOverrides(true);
    if (!base && !isAddedId(id) && !previous.some((entry) => entry.id === id)) {
      throw new RangeError('Choose an available preset.');
    }
    const overrides = [...previous];
    const index = overrides.findIndex((entry) => entry.id === id);
    if (base && base.name === preset.name && configsEqual(base.config, preset.config)) {
      if (index !== -1) overrides.splice(index, 1);
    } else if (index === -1) overrides.push(preset);
    else overrides[index] = preset;
    if (JSON.stringify(previous) !== JSON.stringify(overrides)) this.#write(PRESET_OVERRIDES_KEY, overrides);
    return copyPreset(preset);
  }

  /** @returns {string|null} The last selected preset ID, if it is still available. */
  loadSelection() {
    const id = this.#read(SELECTION_KEY, false);
    return this.listPresets().some((preset) => preset.id === id) ? id : null;
  }

  /** Save the selected preset ID. */
  saveSelection(id) {
    if (typeof id !== 'string') throw new TypeError('A preset ID must be a string.');
    if (!presetsFromOverrides(this.#readOverrides(true)).some((preset) => preset.id === id)) {
      throw new RangeError('Choose an available preset.');
    }
    this.#write(SELECTION_KEY, id);
    return id;
  }

  /** Recover each saved preference independently; invalid fields use their defaults. */
  loadPreferences() {
    return normalizePreferences(this.#read(PREFERENCES_KEY, false), false);
  }

  /** Save display preferences, returning an independent copy. */
  savePreferences(preferences) {
    const normalizedPreferences = normalizePreferences(preferences, true);
    this.#write(PREFERENCES_KEY, normalizedPreferences);
    return { ...normalizedPreferences };
  }

  /** Remove this app's saved presets, selection and preferences only. */
  reset() {
    try {
      if (!this.#storage) throw new Error('Local storage is unavailable.');
      for (const key of [PRESET_OVERRIDES_KEY, SELECTION_KEY, PREFERENCES_KEY]) {
        this.#storage.removeItem(key);
      }
    } catch (cause) {
      throw new PersistenceError(cause);
    }
  }

  #read(key, strict) {
    let raw;
    try {
      if (!this.#storage) throw new Error('Local storage is unavailable.');
      raw = this.#storage.getItem(key);
    } catch (cause) {
      if (strict) throw new PersistenceError(cause);
      return null;
    }
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  #readOverrides(strict) {
    const stored = this.#read(PRESET_OVERRIDES_KEY, strict);
    if (!Array.isArray(stored)) return [];
    const ids = new Set();
    const overrides = [];
    for (const entry of stored) {
      if ((!findBase(entry?.id) && !isAddedId(entry?.id) && !isLegacyId(entry?.id)) || ids.has(entry.id)) continue;
      try {
        overrides.push(findBase(entry.id) && entry.deleted === true ? { id: entry.id, deleted: true }
          : { id: entry.id, name: validateName(entry.name), config: validateConfig(entry.config) });
        ids.add(entry.id);
      } catch {
        // A damaged edit must not replace a valid preset or hide other edits.
      }
    }
    // Corrupt deletion records must never leave the app without two usable presets.
    let count = presetsFromOverrides(overrides).length;
    for (let index = overrides.length - 1; count < 2 && index >= 0; index--) {
      if (!overrides[index].deleted) continue;
      overrides.splice(index, 1);
      count++;
    }
    return overrides;
  }

  #write(key, value) {
    try {
      if (!this.#storage) throw new Error('Local storage is unavailable.');
      this.#storage.setItem(key, JSON.stringify(value));
    } catch (cause) {
      throw new PersistenceError(cause);
    }
  }
}
