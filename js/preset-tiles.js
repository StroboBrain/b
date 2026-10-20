import { PHASES, validateConfig } from './breathing-engine.js';
import { phaseDescription, spokenDuration } from './phase-labels.js';

/** Renders native radios without replacing focused controls for a name/timing edit. */
export class PresetTiles {
  #document;
  #container;
  #onSelect;
  #tiles = new Map();
  #listener;

  constructor({ document, container, onSelect } = {}) {
    if (typeof document?.createElement !== 'function' || typeof container?.replaceChildren !== 'function'
      || typeof container.addEventListener !== 'function' || typeof onSelect !== 'function') {
      throw new TypeError('PresetTiles requires a document, container and selection callback.');
    }
    this.#document = document;
    this.#container = container;
    this.#onSelect = onSelect;
    this.#listener = ({ target }) => {
      if (target.matches('input[type="radio"]') && target.checked && !target.matches(':disabled')
        && this.#tiles.has(target.value)) this.#onSelect(target.value);
    };
    container.addEventListener('change', this.#listener);
  }

  render(presets, selectedId) {
    if (!Array.isArray(presets) || presets.length === 0) throw new TypeError('Provide a nonempty preset list.');
    const ids = new Set();
    for (const preset of presets) {
      if (typeof preset?.id !== 'string' || !preset.id || typeof preset.name !== 'string' || !preset.name.trim()) {
        throw new TypeError('Each preset requires an ID, name and configuration.');
      }
      if (ids.has(preset.id)) throw new RangeError('Preset IDs must be unique.');
      ids.add(preset.id);
      validateConfig(preset.config);
    }
    if (!ids.has(selectedId)) throw new RangeError('The selected preset must be in the list.');

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
    this.#container.removeEventListener('change', this.#listener);
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
