import { PHASES, validateConfig } from './breathing-engine.js';
import { phaseDescription, spokenDuration } from './phase-labels.js';

const REPEAT_TAP_MS = 700;
const HOLD_MS = 550;
const MOVE_TOLERANCE_PX = 10;

/** Renders native radios without replacing focused controls for a name/timing edit. */
export class PresetTiles {
  #document;
  #container;
  #onSelect;
  #onEdit;
  #window;
  #tiles = new Map();
  #listeners = [];
  #signature;
  #pressed = null;
  #lastTap = null;
  #holdTimer;
  #heldRelease = null;
  #disposed = false;
  #selectedId;

  constructor({ document, container, onSelect, onEdit = () => {}, window = globalThis } = {}) {
    if (typeof document?.createElement !== 'function' || typeof container?.replaceChildren !== 'function'
      || typeof container.addEventListener !== 'function' || typeof container.removeEventListener !== 'function'
      || typeof onSelect !== 'function' || typeof onEdit !== 'function' || typeof window?.setTimeout !== 'function'
      || typeof window.clearTimeout !== 'function') {
      throw new TypeError('Pattern tiles require a document, container, callbacks and timer clock.');
    }
    this.#document = document;
    this.#container = container;
    this.#onSelect = onSelect;
    this.#onEdit = onEdit;
    this.#window = window;
    this.#listen('change', ({ target }) => {
      if (target.matches('input[type="radio"]') && target.checked && !target.matches(':disabled')
        && this.#tiles.has(target.value)) {
        this.#select(target.value);
      }
    });
    this.#listen('pointerdown', event => this.#press(event));
    this.#listen('pointerup', event => this.#release(event));
    this.#listen('pointermove', event => {
      const pressed = this.#pressed;
      if (pressed && Math.hypot(event.clientX - pressed.x, event.clientY - pressed.y) > MOVE_TOLERANCE_PX) {
        this.cancelInteraction();
      }
    });
    this.#listen('pointercancel', () => this.cancelInteraction());
    // Touch browsers emit pointerleave after an ordinary lift. Preserve the
    // completed tap so a second touch can use the repeated-tap shortcut.
    this.#listen('pointerleave', () => this.#cancelPress());
    this.#listen('contextmenu', event => {
      if (this.#tileFor(event.target)) event.preventDefault();
    });
    this.#listen('keydown', event => {
      if (event.key !== ' ' || event.repeat) return;
      const tile = this.#tileFor(event.target);
      if (tile?.querySelector('input').checked && this.#tap(tile.dataset.preset)) event.preventDefault();
    });
    if (typeof document.addEventListener === 'function' && typeof document.removeEventListener === 'function') {
      this.#listen('visibilitychange', () => { if (document.hidden) this.cancelInteraction(); }, document);
    }
    if (typeof window.addEventListener === 'function' && typeof window.removeEventListener === 'function') {
      for (const type of ['blur', 'pagehide']) this.#listen(type, () => this.cancelInteraction(), window);
    }
  }

  render(presets, selectedId) {
    if (!Array.isArray(presets) || presets.length === 0) throw new TypeError('Provide a nonempty pattern list.');
    const ids = new Set();
    for (const preset of presets) {
      if (typeof preset?.id !== 'string' || !preset.id || typeof preset.name !== 'string' || !preset.name.trim()) {
        throw new TypeError('Each pattern requires an ID, name and configuration.');
      }
      if (ids.has(preset.id)) throw new RangeError('Pattern IDs must be unique.');
      ids.add(preset.id);
      validateConfig(preset.config);
    }
    if (!ids.has(selectedId)) throw new RangeError('The selected pattern must be in the list.');

    const signature = JSON.stringify([selectedId, presets]);
    if (this.#signature !== undefined && this.#signature !== signature) this.cancelInteraction();
    this.#signature = signature;
    const reordered = presets.length !== this.#tiles.size
      || presets.some((preset, index) => this.#container.children[index]?.dataset.preset !== preset.id);
    const next = new Map();
    for (const preset of presets) {
      const tile = this.#tiles.get(preset.id) ?? this.#createTile(preset.id);
      const input = tile.querySelector('input');
      tile.querySelector('.preset-name').textContent = preset.name;
      tile.querySelector('.preset-timing').textContent = `${PHASES.map((phase) => preset.config[phase]).join(' · ')} s`;
      const description = PHASES.map((phase) => preset.config[phase] === 0
        ? `no ${phaseDescription(phase)}` : `${phaseDescription(phase)} ${spokenDuration(preset.config[phase])}`).join(', ');
      input.setAttribute('aria-label', `${preset.name}: ${description}`);
      next.set(preset.id, tile);
    }
    this.#tiles = next;
    if (reordered) this.#container.replaceChildren(...next.values());
    this.#checkOnly(selectedId);
  }

  dispose() {
    this.#disposed = true;
    this.cancelInteraction();
    for (const remove of this.#listeners) remove();
    this.#listeners = [];
  }

  /** Cancel a pending hold or repeated tap when editing, navigating or leaving. */
  cancelInteraction() {
    this.#cancelPress();
    this.#lastTap = null;
    this.#heldRelease = null;
  }

  #listen(type, listener, target = this.#container) {
    target.addEventListener(type, listener);
    this.#listeners.push(() => target.removeEventListener(type, listener));
  }

  #tileFor(target) {
    const tile = target?.closest?.('.preset-tile');
    return !this.#disposed && tile && this.#tiles.get(tile.dataset.preset) === tile && !tile.querySelector('input').matches(':disabled')
      ? tile : null;
  }

  #press(event) {
    this.#cancelPress();
    this.#heldRelease = null;
    if (event.defaultPrevented || event.isPrimary === false || (event.button !== undefined && event.button !== 0)) {
      this.cancelInteraction();
      return;
    }
    const tile = this.#tileFor(event.target);
    if (!tile) return;
    const pressed = { id: tile.dataset.preset, pointerId: event.pointerId,
      x: event.clientX, y: event.clientY, selected: tile.querySelector('input').checked, held: false };
    // Selection is immediate. Its callback can render and cancel old gesture
    // state, so arm this hold only after the selected pattern is synchronized.
    if (!pressed.selected) this.#select(pressed.id);
    if (!this.#tileFor(tile) || !tile.querySelector('input').checked) return;
    this.#pressed = pressed;
    this.#holdTimer = this.#window.setTimeout(() => {
      if (this.#pressed !== pressed || !this.#tileFor(tile)) return;
      this.#holdTimer = undefined;
      pressed.held = true;
      // The hold only requests editing; this pattern was selected on press.
      if (!this.#tileFor(tile) || !tile.querySelector('input').checked) return;
      this.cancelInteraction();
      this.#heldRelease = pressed.pointerId;
      this.#onEdit(pressed.id);
    }, HOLD_MS);
  }

  #release(event) {
    if (this.#heldRelease !== null && event.pointerId === this.#heldRelease) {
      this.#heldRelease = null;
      this.#cancelPress();
      event.preventDefault?.();
      return;
    }
    const pressed = this.#pressed;
    if (!pressed || event.pointerId !== pressed.pointerId) return;
    const tile = this.#tileFor(event.target);
    this.#cancelPress();
    if (tile?.dataset.preset !== pressed.id) return;
    if (!pressed.held && pressed.selected && tile.querySelector('input').checked) this.#tap(pressed.id);
  }

  #select(id) {
    if (this.#selectedId === id) return;
    this.cancelInteraction();
    this.#checkOnly(id);
    this.#onSelect(id);
  }

  #checkOnly(id) {
    this.#selectedId = id;
    const selected = this.#tiles.get(id).querySelector('input');
    for (const tile of this.#tiles.values()) {
      const input = tile.querySelector('input');
      if (input !== selected) input.checked = false;
    }
    selected.checked = true;
  }

  #cancelPress() {
    this.#window.clearTimeout(this.#holdTimer);
    this.#holdTimer = undefined;
    this.#pressed = null;
  }

  #tap(id) {
    const time = this.#window.performance?.now?.() ?? Date.now();
    if (this.#lastTap?.id === id && time >= this.#lastTap.time && time - this.#lastTap.time <= REPEAT_TAP_MS) {
      this.cancelInteraction();
      this.#onEdit(id);
      return true;
    } else this.#lastTap = { id, time };
    return false;
  }

  #createTile(id) {
    const tile = this.#document.createElement('label');
    tile.className = 'preset-tile';
    tile.dataset.preset = id;
    const input = Object.assign(this.#document.createElement('input'),
      { type: 'radio', name: 'preset', value: id, className: 'sr-only' });
    const name = this.#document.createElement('span');
    name.className = 'preset-name';
    const timing = this.#document.createElement('span');
    timing.className = 'preset-timing';
    timing.setAttribute('aria-hidden', 'true');
    tile.append(input, name, timing);
    return tile;
  }
}
