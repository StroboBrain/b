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

/** The six permanent exercises, with stable IDs and names. */
const BASE_PRESETS = Object.freeze([
  freezePreset({ id: 'box', name: 'box breathing', config: { inhale: 4, holdIn: 4, exhale: 4, holdOut: 4 } }),
  freezePreset({ id: 'slow', name: 'slow breathing', config: { inhale: 4, holdIn: 0, exhale: 6, holdOut: 0 } }),
  freezePreset({ id: '478', name: '4–7–8 breathing', config: { inhale: 4, holdIn: 7, exhale: 8, holdOut: 0 } }),
  freezePreset({ id: 'equal', name: 'equal breathing', config: { inhale: 5, holdIn: 0, exhale: 5, holdOut: 0 } }),
  freezePreset({ id: 'custom-1', name: 'custom 1', config: { inhale: 4, holdIn: 0, exhale: 4, holdOut: 0 } }),
  freezePreset({ id: 'custom-2', name: 'custom 2', config: { inhale: 4, holdIn: 2, exhale: 6, holdOut: 2 } }),
]);

const findBase = (id) => BASE_PRESETS.find((preset) => preset.id === id);

function presetsFromOverrides(overrides) {
  return BASE_PRESETS.map((preset) => {
    for (const entry of overrides) {
      if (entry?.id !== preset.id || entry.deleted === true) continue;
      try {
        return { id: preset.id, name: preset.name, config: validateConfig(entry.config) };
      } catch {
        // A damaged timing must not replace a valid preset or hide later valid edits.
      }
    }
    return copyPreset(preset);
  });
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

  /** @returns {Array<{id: string, name: string, config: object}>} Exactly six presets with saved timings. */
  listPresets() {
    return presetsFromOverrides(this.#readOverrides(false));
  }

  /** Save timings for a permanent preset; names remain fixed.
   * The name argument remains for callers using the previous storage contract.
   * Unrelated legacy records stay in storage, including hidden added presets.
   */
  savePreset(id, name, config) {
    if (typeof id !== 'string') throw new TypeError('A preset ID must be a string.');
    const base = findBase(id);
    if (!base) throw new RangeError('Choose an available preset.');
    const preset = { id, name: base.name, config: validateConfig(config) };
    const previous = this.#readOverrides(true);
    const overrides = previous.filter((entry) => entry?.id !== id);
    if (!configsEqual(base.config, preset.config)) {
      const index = previous.findIndex((entry) => entry?.id === id);
      overrides.splice(index === -1 ? overrides.length : index, 0, preset);
    }
    if (JSON.stringify(previous) !== JSON.stringify(overrides)) this.#write(PRESET_OVERRIDES_KEY, overrides);
    return copyPreset(preset);
  }

  /** @returns {string|null} The last selected preset ID, if it is still available. */
  loadSelection() {
    const id = this.#read(SELECTION_KEY, false);
    return this.listPresets().some((preset) => preset.id === id) ? id : null;
  }

  /** Save the selected preset ID; loadSelection() ignores one that is no longer available. */
  saveSelection(id) {
    if (typeof id !== 'string') throw new TypeError('A preset ID must be a string.');
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

  /** Remove this app's current and legacy local data, leaving other origin data alone.
   * Throws PersistenceError when storage cannot be read or a removal cannot be confirmed.
   * Snapshot before changing anything; a failed removal restores prior values when possible.
   */
  clearLocalData() {
    let storage;
    const snapshot = new Map();
    try {
      storage = this.#requireStorage();
      const count = storage.length;
      if (!Number.isInteger(count) || count < 0) throw new Error('Local storage cannot be enumerated.');
      for (let index = 0; index < count; index += 1) {
        const key = storage.key(index);
        if (typeof key !== 'string') throw new Error('Local storage changed while reading saved data.');
        if (!key.startsWith('breathing.')) continue;
        const value = storage.getItem(key);
        if (value !== null) snapshot.set(key, value);
      }
    } catch (cause) {
      throw new PersistenceError(cause);
    }

    const attempted = [];
    try {
      for (const [key, value] of snapshot) {
        attempted.push([key, value]);
        storage.removeItem(key);
        if (storage.getItem(key) !== null) throw new Error('Local data could not be removed.');
      }
    } catch (cause) {
      const failures = [cause];
      for (const [key, value] of attempted) {
        try { storage.setItem(key, value); } catch (error) { failures.push(error); }
      }
      throw new PersistenceError(failures.length === 1 ? cause : new AggregateError(failures));
    }
  }

  #requireStorage() {
    if (!this.#storage) throw new Error('Local storage is unavailable.');
    return this.#storage;
  }

  #read(key, strict) {
    let raw;
    try {
      raw = this.#requireStorage().getItem(key);
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
    return Array.isArray(stored) ? stored : [];
  }

  #write(key, value) {
    try {
      this.#requireStorage().setItem(key, JSON.stringify(value));
    } catch (cause) {
      throw new PersistenceError(cause);
    }
  }
}
