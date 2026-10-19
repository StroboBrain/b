import { configsEqual, DEFAULT_CONFIG, validateConfig } from './breathing-engine.js';
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
  #crypto;

  constructor({ store, onStorageError, crypto = globalThis.crypto } = {}) {
    for (const method of ['listPresets', 'loadSelection', 'savePreset', 'deletePreset', 'saveSelection']) {
      if (typeof store?.[method] !== 'function') throw new TypeError(`The preset store must provide ${method}().`);
    }
    if (typeof onStorageError !== 'function') throw new TypeError('onStorageError must be a function.');
    if (typeof crypto?.randomUUID !== 'function' && typeof crypto?.getRandomValues !== 'function') {
      throw new TypeError('Crypto must provide randomUUID() or getRandomValues().');
    }
    this.#store = store;
    this.#onStorageError = onStorageError;
    this.#crypto = crypto;
    this.#presets = store.listPresets();
    const selection = store.loadSelection();
    this.#selectedId = this.#presets.find((preset) => preset.id === selection)?.id ?? this.#presets[0].id;
  }

  get presets() { return this.#presets; }
  get selected() { return this.#presets.find((preset) => preset.id === this.#selectedId); }

  /** Add and select an independent preset; failed saves remain available for retry. */
  add() {
    this.flush();
    let name = 'New preset';
    for (let suffix = 2; this.#presets.some((preset) => preset.name.toLowerCase() === name.toLowerCase()); suffix++) {
      name = `New preset ${suffix}`;
    }
    const preset = { id: `preset-${this.#createUuid()}`, name, config: { ...DEFAULT_CONFIG } };
    this.#presets.push(preset);
    this.#selectedId = preset.id;
    this.#dirty.add(preset.id);
    this.#selectionDirty = true;
    this.flush();
    return preset;
  }

  rename(name) {
    if (typeof name !== 'string') throw new TypeError('A preset name must be a string.');
    name = name.trim();
    if (!name || name.length > 32) throw new RangeError('Use 1–32 characters for a preset name.');
    if (name === this.selected.name) return;
    this.selected.name = name;
    this.#dirty.add(this.#selectedId);
  }

  /** Commit deletion before removing it from the UI; failed saves leave it available. */
  remove() {
    if (this.#presets.length <= 2) throw new RangeError('Keep at least two presets.');
    if (!this.flush()) return false;
    const index = this.#presets.findIndex((preset) => preset.id === this.#selectedId);
    if (!this.#persist(() => this.#store.deletePreset(this.#selectedId))) return false;
    this.#presets.splice(index, 1);
    this.#selectedId = this.#presets[Math.min(index, this.#presets.length - 1)].id;
    this.#selectionDirty = true;
    this.#saveSelection();
    return true;
  }

  setConfig(config) {
    const normalized = validateConfig(config);
    if (configsEqual(normalized, this.selected.config)) return;
    this.selected.config = normalized;
    this.#dirty.add(this.#selectedId);
  }

  select(id) {
    if (!this.#presets.some((preset) => preset.id === id)) throw new RangeError('Choose an available preset.');
    const saved = this.flush();
    if (this.#selectedId === id) return;
    this.#selectedId = id;
    this.#selectionDirty = true;
    if (saved) this.#saveSelection();
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
    if (!this.selected) this.#selectedId = this.#presets[0].id;
    return true;
  }

  #saveSelection() {
    if (!this.#selectionDirty) return true;
    if (!this.#persist(() => this.#store.saveSelection(this.#selectedId))) return false;
    this.#selectionDirty = false;
    return true;
  }

  /** getRandomValues remains available when HTTP does not expose randomUUID. */
  #createUuid() {
    if (typeof this.#crypto.randomUUID === 'function') return this.#crypto.randomUUID();
    const bytes = new Uint8Array(16);
    this.#crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
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
