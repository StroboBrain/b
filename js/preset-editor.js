import { configsEqual, DEFAULT_CONFIG, validateConfig } from './breathing-engine.js';
import { PersistenceError } from './preset-store.js';

/** Pattern drafts stay in memory until save(); selection never commits an edit.
 * Failed storage writes retain dirty edits for retry. Validation errors propagate.
 */
export class PresetEditor {
  #store;
  #onStorageError;
  #presets;
  #selectedId;
  #dirty = new Set();
  #saved;
  #lastSavedId;
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
    this.#saved = new Map(this.#presets.map(preset => [preset.id, structuredClone(preset)]));
    this.#lastSavedId = this.#selectedId;
  }

  get presets() { return this.#presets; }
  get selected() { return this.#presets.find((preset) => preset.id === this.#selectedId); }
  get hasDrafts() { return this.#dirty.size > 0; }

  /** Add a draft without writing it or any other pattern to storage. */
  add() {
    let name = 'New preset';
    for (let suffix = 2; this.#presets.some((preset) => preset.name.toLowerCase() === name.toLowerCase()); suffix++) {
      name = `New preset ${suffix}`;
    }
    const preset = { id: `preset-${this.#createUuid()}`, name, config: { ...DEFAULT_CONFIG } };
    this.#presets.push(preset);
    this.#selectedId = preset.id;
    this.#dirty.add(preset.id);
    this.#selectionDirty = true;
    return preset;
  }

  rename(name) {
    if (typeof name !== 'string') throw new TypeError('A preset name must be a string.');
    name = name.trim();
    if (!name || name.length > 32) throw new RangeError('Use 1–32 characters for a preset name.');
    if (name === this.selected.name) return;
    this.selected.name = name;
    this.#markDirty();
  }

  /** Commit deletion before removing it from the UI; failed saves leave it available. */
  remove() {
    if (this.#presets.length <= 2) throw new RangeError('Keep at least two presets.');
    const index = this.#presets.findIndex((preset) => preset.id === this.#selectedId);
    if (this.#saved.has(this.#selectedId)
      && !this.#persist(() => this.#store.deletePreset(this.#selectedId))) return false;
    this.#saved.delete(this.#selectedId);
    this.#dirty.delete(this.#selectedId);
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
    this.#markDirty();
  }

  select(id) {
    if (!this.#presets.some((preset) => preset.id === id)) throw new RangeError('Choose an available preset.');
    if (this.#selectedId === id) return;
    this.#selectedId = id;
    this.#selectionDirty = true;
    this.#saveSelection();
  }

  /** Save only the selected draft, retaining it after a failed write for retry. */
  save() {
    const preset = this.selected;
    if (this.#dirty.has(preset.id)) {
      if (!this.#persist(() => this.#store.savePreset(preset.id, preset.name, preset.config))) return false;
      this.#saved.set(preset.id, structuredClone(preset));
      this.#dirty.delete(preset.id);
    }
    return this.#saveSelection();
  }

  /** Restore the saved pattern; cancelling an unsaved addition removes its draft. */
  cancel() {
    const id = this.#selectedId;
    const index = this.#presets.findIndex(preset => preset.id === id);
    const saved = this.#saved.get(id);
    this.#dirty.delete(id);
    if (saved) this.#presets[index] = structuredClone(saved);
    else {
      this.#presets.splice(index, 1);
      this.#selectedId = this.#presets.find(preset => preset.id === this.#lastSavedId)?.id
        ?? this.#presets[0].id;
      this.#selectionDirty = true;
    }
  }

  refresh() {
    const next = this.#store.listPresets();
    const saved = new Map(next.map(preset => [preset.id, structuredClone(preset)]));
    const drafts = new Map(this.#presets.filter(preset => this.#dirty.has(preset.id)
      && (!this.#saved.has(preset.id) || saved.has(preset.id))).map(preset => [preset.id, preset]));
    this.#presets = next.map(preset => drafts.get(preset.id) ?? preset);
    this.#presets.push(...[...drafts.values()].filter(preset => !saved.has(preset.id)));
    this.#saved = saved;
    this.#dirty = new Set(drafts.keys());
    if (!this.#saved.has(this.#lastSavedId)) this.#lastSavedId = next[0].id;
    if (!this.selected) this.#selectedId = next[0].id;
    return true;
  }

  #markDirty() {
    const saved = this.#saved.get(this.#selectedId);
    if (saved && saved.name === this.selected.name && configsEqual(saved.config, this.selected.config)) {
      this.#dirty.delete(this.#selectedId);
    } else this.#dirty.add(this.#selectedId);
  }

  #saveSelection() {
    if (!this.#selectionDirty) return true;
    if (!this.#saved.has(this.#selectedId)) return true;
    if (!this.#persist(() => this.#store.saveSelection(this.#selectedId))) return false;
    this.#selectionDirty = false;
    this.#lastSavedId = this.#selectedId;
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
