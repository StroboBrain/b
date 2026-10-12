import { configsEqual, validateConfig } from './breathing-engine.js';
import { PersistenceError } from './preset-store.js';

/** Edits stay in memory until flush; selection alone never writes a preset override.
 * Failed storage writes retain dirty edits for retry. Validation errors propagate.
 */
export class PresetEditor {
  #store;
  #onStorageError;
  #presets;
  #selectedId;
  #dirty = new Set();
  #selectionDirty = false;

  constructor({ store, onStorageError }) {
    this.#store = store;
    this.#onStorageError = onStorageError;
    this.#presets = store.listPresets();
    const selection = store.loadSelection();
    this.#selectedId = this.#presets.find((preset) => preset.id === selection)?.id ?? this.#presets[0].id;
  }

  get presets() { return this.#presets; }
  get selected() { return this.#presets.find((preset) => preset.id === this.#selectedId); }

  rename(name) {
    if (typeof name !== 'string') throw new TypeError('A preset name must be a string.');
    name = name.trim();
    if (!name || name.length > 32) throw new RangeError('Use 1–32 characters for a preset name.');
    if (name === this.selected.name) return;
    this.selected.name = name;
    this.#dirty.add(this.#selectedId);
  }

  setConfig(config) {
    const normalized = validateConfig(config);
    if (configsEqual(normalized, this.selected.config)) return;
    this.selected.config = normalized;
    this.#dirty.add(this.#selectedId);
  }

  select(id) {
    if (!this.#presets.some((preset) => preset.id === id)) throw new RangeError('Choose an available preset.');
    this.flush();
    if (this.#selectedId === id) return;
    this.#selectedId = id;
    this.#selectionDirty = true;
    this.#saveSelection();
  }

  flush() {
    for (const id of this.#dirty) {
      const preset = this.#presets.find((entry) => entry.id === id);
      if (!this.#persist(() => this.#store.savePreset(id, preset.name, preset.config))) return false;
      this.#dirty.delete(id);
    }
    return this.#saveSelection();
  }

  refresh() {
    if (!this.flush()) return false;
    this.#presets = this.#store.listPresets();
    return true;
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
