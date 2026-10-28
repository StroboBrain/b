import { PHASES, validateConfig } from './breathing-engine.js';
import { phaseDescription, spokenDuration } from './phase-labels.js';

const REPEAT_TAP_MS = 700;
const HOLD_MS = 550;
const MOVE_TOLERANCE_PX = 10;

/** Describe the current rhythm without changing its permanent preset identity or slot. */
export function patternName(config, slotNumber) {
  const { inhale, holdIn, exhale, holdOut } = Object.fromEntries(
    PHASES.map(phase => [phase, Math.round(config[phase] * 10)]));
  if (inhale === exhale) return 'equal';
  if (holdOut === 0 && inhale * 7 === holdIn * 4 && inhale * 8 === exhale * 4) return '4–7–8';
  if (holdIn === 0 && holdOut === 0 && exhale > inhale) return 'slow';
  return `custom ${slotNumber}`;
}

/** Renders native radios without replacing focused controls for a name/timing edit. */
export class PresetTiles {
  #document;
  #container;
  #onSelect;
  #onEdit;
  #window;
  #tiles = new Map();
  #slotNumbers = new Map();
  #listeners = [];
  #signature;
  #pressed = null;
  #lastTap = null;
  #holdTimer;
  #heldRelease = null;
  #disposed = false;
  #selectedId;
  #resizeObserver;
  #timings = new Set();

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
    if (typeof window.ResizeObserver === 'function') {
      this.#resizeObserver = new window.ResizeObserver(entries => {
        for (const { target } of entries) this.#syncWrapping(target);
      });
    }
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
      if (!this.#resizeObserver) this.#listen('resize', () => this.#syncAllWrapping(), window);
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
      if (!this.#slotNumbers.has(preset.id)) this.#slotNumbers.set(preset.id, this.#slotNumbers.size + 1);
      const name = patternName(preset.config, this.#slotNumbers.get(preset.id));
      const input = tile.querySelector('input');
      tile.querySelector('.preset-name').textContent = name;
      const timing = tile.querySelector('.preset-timing');
      const values = PHASES.map(phase => String(preset.config[phase]).split('.'));
      for (const [index, number] of timing.querySelectorAll('.preset-timing-number').entries()) {
        const [whole, fraction] = values[index];
        number.querySelector('.preset-timing-whole').textContent = whole;
        number.querySelector('.preset-timing-fraction').textContent = fraction === undefined ? '' : `.${fraction}`;
      }
      // Inhale/exhale share one column, and the two holds share the other.
      const columns = [];
      for (const [index, column] of ['first', 'second'].entries()) {
        const rows = [values[index], values[index + 2]];
        const whole = Math.max(...rows.map(([digits]) => digits.length));
        const fraction = rows.some(([, digits]) => digits !== undefined) ? 1.5 : 0;
        columns.push({ whole, fraction });
        timing.style.setProperty(`--preset-${column}-whole`, `${whole}ch`);
        timing.style.setProperty(`--preset-${column}-fraction`, `${fraction}ch`);
      }
      // Balance the painted dots between visible digits without moving their aligned columns.
      const separatorShift = (left, right) => {
        const unusedFraction = values[left][1] === undefined ? columns[left % 2].fraction : 0;
        const leadingSpace = columns[right % 2].whole - values[right][0].length;
        return `${(leadingSpace - unusedFraction) / 2}ch`;
      };
      for (const [index, pair] of timing.querySelectorAll('.preset-timing-pair').entries()) {
        pair.querySelector('.preset-timing-separator').style.setProperty('--preset-separator-shift', separatorShift(index * 2, index * 2 + 1));
        if (index === 0) pair.querySelector('.preset-timing-join').style.setProperty('--preset-separator-shift', separatorShift(1, 2));
      }
      timing.dataset.long = String(timing.querySelector('.preset-timing-pair').textContent.length > 12);
      const description = PHASES.map((phase) => preset.config[phase] === 0
        ? `no ${phaseDescription(phase)}` : `${phaseDescription(phase)} ${spokenDuration(preset.config[phase])}`).join(', ');
      input.setAttribute('aria-label', `${name}: ${description}`);
      next.set(preset.id, tile);
    }
    for (const [id, tile] of this.#tiles) {
      if (next.has(id)) continue;
      const timing = tile.querySelector('.preset-timing');
      this.#resizeObserver?.unobserve(timing);
      this.#timings.delete(timing);
    }
    this.#tiles = next;
    if (reordered) this.#container.replaceChildren(...next.values());
    this.#checkOnly(selectedId);
    this.#syncAllWrapping();
  }

  dispose() {
    this.#disposed = true;
    this.cancelInteraction();
    this.#resizeObserver?.disconnect();
    this.#timings.clear();
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

  #syncAllWrapping() {
    for (const timing of this.#timings) this.#syncWrapping(timing);
  }

  #syncWrapping(timing) {
    if (this.#disposed || !this.#timings.has(timing) || timing.getBoundingClientRect().width <= 0) return;
    const [first, second] = timing.querySelectorAll('.preset-timing-pair');
    timing.dataset.wrapped = String(Math.abs(second.getBoundingClientRect().top - first.getBoundingClientRect().top) > .5);
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
    for (let index = 0; index < 2; index++) {
      const pair = this.#document.createElement('span');
      pair.className = 'preset-timing-pair';
      for (let column = 0; column < 2; column++) {
        if (column) {
          const separator = this.#document.createElement('span');
          separator.className = 'preset-timing-separator';
          separator.textContent = ' · ';
          pair.append(separator);
        }
        const number = this.#document.createElement('span');
        number.className = 'preset-timing-number';
        number.dataset.phase = PHASES[index * 2 + column];
        for (const part of ['whole', 'fraction']) {
          const span = this.#document.createElement('span');
          span.className = `preset-timing-${part}`;
          number.append(span);
        }
        pair.append(number);
      }
      const join = this.#document.createElement('span');
      join.className = 'preset-timing-join';
      join.textContent = index === 0 ? ' · ' : '';
      pair.append(join);
      timing.append(pair);
    }
    tile.append(input, name, timing);
    this.#timings.add(timing);
    this.#resizeObserver?.observe(timing);
    return tile;
  }
}
