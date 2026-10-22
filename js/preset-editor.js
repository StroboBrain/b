import { configsEqual, validateConfig } from './breathing-engine.js';
import { PersistenceError } from './preset-store.js';

/** Timing changes save immediately; failed writes stay in memory for retry.
 * Selection, the next adjustment, or flush() retries pending writes.
 * Other tabs' saves load only when there are no pending timing changes.
 */
export class PresetEditor {
  #store;
  #onStorageError;
  #presets;
  #selectedId;
  #dirty = new Set();
  #saved;
  #selectionDirty = false;

  constructor({ store, onStorageError } = {}) {
    for (const method of ['listPresets', 'loadSelection', 'savePreset', 'saveSelection']) {
      if (typeof store?.[method] !== 'function') throw new TypeError(`The preset store must provide ${method}().`);
    }
    if (typeof onStorageError !== 'function') throw new TypeError('onStorageError must be a function.');
    this.#store = store;
    this.#onStorageError = onStorageError;
    this.#load();
    const selection = store.loadSelection();
    this.#selectedId = this.#presets.find((preset) => preset.id === selection)?.id ?? this.#presets[0].id;
  }

  get presets() { return this.#presets; }
  get selected() { return this.#presets.find((preset) => preset.id === this.#selectedId); }
  get hasDrafts() { return this.#dirty.size > 0; }
  get hasPendingChanges() { return this.hasDrafts || this.#selectionDirty; }

  setConfig(config) {
    const normalized = validateConfig(config);
    if (!configsEqual(normalized, this.selected.config)) {
      this.selected.config = normalized;
      this.#markDirty();
    }
    return this.flush();
  }

  select(id) {
    if (!this.#presets.some((preset) => preset.id === id)) throw new RangeError('Choose an available pattern.');
    if (this.#selectedId !== id) {
      this.#selectedId = id;
      this.#selectionDirty = true;
    }
    return this.flush();
  }

  /** Retry pending changes; a failed timing write never discards its local value. */
  flush() {
    let saved = true;
    for (const id of this.#dirty) {
      const preset = this.#presets.find((entry) => entry.id === id);
      if (!this.#persist(() => this.#store.savePreset(preset.id, preset.name, preset.config))) {
        saved = false;
        continue;
      }
      this.#saved.set(preset.id, structuredClone(preset));
      this.#dirty.delete(preset.id);
    }
    return this.#saveSelection() && saved;
  }

  /** Reload saved patterns unless pending timings would be replaced. @returns {boolean} Whether it reloaded. */
  refresh() {
    if (this.hasDrafts) return false;
    this.#load();
    if (!this.selected) this.#selectedId = this.#presets[0].id;
    return true;
  }

  #load() {
    this.#presets = this.#store.listPresets();
    this.#saved = new Map(this.#presets.map((preset) => [preset.id, structuredClone(preset)]));
  }

  #markDirty() {
    const saved = this.#saved.get(this.#selectedId);
    if (configsEqual(saved.config, this.selected.config)) {
      this.#dirty.delete(this.#selectedId);
    } else this.#dirty.add(this.#selectedId);
  }

  #saveSelection() {
    if (!this.#selectionDirty) return true;
    if (!this.#persist(() => this.#store.saveSelection(this.#selectedId))) return false;
    this.#selectionDirty = false;
    return true;
  }

  #persist(operation) {
    try {
      operation();
      return true;
    } catch (error) {
      if (!(error instanceof PersistenceError)) throw error;
      this.#onStorageError(error);
      return false;
    }
  }
}
