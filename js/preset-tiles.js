import { PHASES, validateConfig } from './breathing-engine.js';
import { phaseDescription, spokenDuration } from './phase-labels.js';

const REPEAT_TAP_MS = 700;
const HOLD_MS = 550;
const HINT_MS = 4000;
const MOVE_TOLERANCE_PX = 10;

/** Renders native radios without replacing focused controls for a name/timing edit. */
export class PresetTiles {
  #document;
  #container;
  #onSelect;
  #onHint;
  #window;
  #tiles = new Map();
  #listeners = [];
  #signature;
  #pressed = null;
  #heldSelection = null;
  #lastTap = null;
  #holdTimer;
  #hintTimer;
  #hintVisible = false;
  #hintVersion = 0;

  constructor({ document, container, onSelect, onHint = () => {}, window = globalThis } = {}) {
    if (typeof document?.createElement !== 'function' || typeof container?.replaceChildren !== 'function'
      || typeof container.addEventListener !== 'function' || typeof onSelect !== 'function'
      || typeof onHint !== 'function' || typeof window?.setTimeout !== 'function'
      || typeof window.clearTimeout !== 'function') {
      throw new TypeError('Pattern tiles require a document, container, callbacks and timer clock.');
    }
    this.#document = document;
    this.#container = container;
    this.#onSelect = onSelect;
    this.#onHint = onHint;
    this.#window = window;
    this.#listen('change', ({ target }) => {
      if (target.matches('input[type="radio"]') && target.checked && !target.matches(':disabled')
        && this.#tiles.has(target.value)) {
        const held = this.#heldSelection === target.value;
        this.dismissHint();
        this.#onSelect(target.value);
        // A held, newly selected radio changes after pointerup. Keep its hint
        // visible after the selection callback has rendered the new pattern.
        if (held) this.#showHint();
      }
    });
    this.#listen('pointerdown', event => this.#press(event));
    this.#listen('pointerup', event => this.#release(event));
    this.#listen('pointermove', event => {
      const pressed = this.#pressed;
      if (pressed && Math.hypot(event.clientX - pressed.x, event.clientY - pressed.y) > MOVE_TOLERANCE_PX) {
        this.#cancelPress();
      }
    });
    for (const type of ['pointercancel', 'pointerleave']) this.#listen(type, () => this.#cancelPress());
    this.#listen('contextmenu', event => {
      if (this.#tileFor(event.target)) event.preventDefault();
    });
    this.#listen('keydown', event => {
      if (event.key !== ' ' || event.repeat) return;
      const tile = this.#tileFor(event.target);
      if (tile?.querySelector('input').checked) this.#tap(tile.dataset.preset);
    });
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
    if (this.#signature !== undefined && this.#signature !== signature) this.dismissHint();
    this.#signature = signature;
    const reordered = presets.length !== this.#tiles.size
      || presets.some((preset, index) => this.#container.children[index]?.dataset.preset !== preset.id);
    const next = new Map();
    for (const preset of presets) {
      const tile = this.#tiles.get(preset.id) ?? this.#createTile(preset.id);
      const input = tile.querySelector('input');
      input.checked = preset.id === selectedId;
      tile.querySelector('.preset-name').textContent = preset.name;
      tile.querySelector('.preset-timing').textContent = `${PHASES.map((phase) => preset.config[phase]).join(' · ')} s`;
      const description = PHASES.map((phase) => preset.config[phase] === 0
        ? `no ${phaseDescription(phase)}` : `${phaseDescription(phase)} ${spokenDuration(preset.config[phase])}`).join(', ');
      input.setAttribute('aria-label', `${preset.name}: ${description}`);
      next.set(preset.id, tile);
    }
    this.#tiles = next;
    if (reordered) this.#container.replaceChildren(...next.values());
  }

  dispose() {
    this.dismissHint();
    for (const [type, listener] of this.#listeners) this.#container.removeEventListener(type, listener);
    this.#listeners = [];
  }

  /** Clear the guidance when timings are opened, edited, or left behind. */
  dismissHint() {
    this.#cancelPress();
    this.#heldSelection = null;
    this.#lastTap = null;
    this.#window.clearTimeout(this.#hintTimer);
    this.#hintTimer = undefined;
    this.#hintVersion++;
    if (this.#hintVisible) {
      this.#hintVisible = false;
      this.#onHint(false);
    }
  }

  #listen(type, listener) {
    this.#container.addEventListener(type, listener);
    this.#listeners.push([type, listener]);
  }

  #tileFor(target) {
    const tile = target?.closest?.('.preset-tile');
    return tile && this.#tiles.get(tile.dataset.preset) === tile && !tile.querySelector('input').matches(':disabled')
      ? tile : null;
  }

  #press(event) {
    this.#cancelPress();
    this.#heldSelection = null;
    if (event.isPrimary === false || (event.button !== undefined && event.button !== 0)) return;
    const tile = this.#tileFor(event.target);
    if (!tile) return;
    const pressed = { id: tile.dataset.preset, pointerId: event.pointerId,
      x: event.clientX, y: event.clientY, selected: tile.querySelector('input').checked, held: false };
    this.#pressed = pressed;
    this.#holdTimer = this.#window.setTimeout(() => {
      if (this.#pressed !== pressed || !this.#tileFor(tile)) return;
      this.#holdTimer = undefined;
      pressed.held = true;
      this.#showHint();
    }, HOLD_MS);
  }

  #release(event) {
    const pressed = this.#pressed;
    if (!pressed || event.pointerId !== pressed.pointerId) return;
    const tile = this.#tileFor(event.target);
    this.#cancelPress();
    if (tile?.dataset.preset !== pressed.id) return;
    if (pressed.held) this.#heldSelection = pressed.id;
    else if (pressed.selected && tile.querySelector('input').checked) this.#tap(pressed.id);
  }

  #cancelPress() {
    this.#window.clearTimeout(this.#holdTimer);
    this.#holdTimer = undefined;
    this.#pressed = null;
  }

  #tap(id) {
    const time = this.#window.performance?.now?.() ?? Date.now();
    if (this.#lastTap?.id === id && time >= this.#lastTap.time && time - this.#lastTap.time <= REPEAT_TAP_MS) {
      this.#showHint();
    } else this.#lastTap = { id, time };
  }

  #showHint() {
    this.#lastTap = null;
    if (!this.#hintVisible) {
      this.#hintVisible = true;
      this.#onHint(true);
    }
    this.#window.clearTimeout(this.#hintTimer);
    const version = ++this.#hintVersion;
    this.#hintTimer = this.#window.setTimeout(() => {
      if (version === this.#hintVersion) this.dismissHint();
    }, HINT_MS);
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
