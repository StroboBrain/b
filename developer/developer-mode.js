import { POPUP_VARIANTS } from './popup-variants.js';

const STORAGE_KEY = 'breathing.developer.v3';
const PREVIOUS_STORAGE_KEY = 'breathing.developer.v2';
const LEGACY_STORAGE_KEY = 'breathing.developer.v1';
const LAYOUTS = Object.freeze([
  { id: 'auto', name: 'Responsive', description: 'Fit the app to the available screen.' },
  { id: 'compact', name: 'Compact', description: 'Use a smaller circle and closer spacing.' },
  { id: 'split', name: 'Split', description: 'Put the circle beside the controls on wider screens.' },
]);
const EASINGS = Object.freeze({
  gentle: 'cubic-bezier(.65, 0, .35, 1)',
  standard: 'ease-in-out',
  linear: 'linear',
});
const NUMBERS = Object.freeze([
  { key: 'slideDuration', id: 'slide-duration', label: 'Slide duration', unit: 'ms', min: 600, max: 2000, step: 100, value: 1500, property: '--panel-slide-duration' },
  { key: 'travelGap', id: 'travel-gap', label: 'Panel travel gap', unit: 'px', min: 0, max: 48, step: 4, value: 28, property: '--panel-travel-gap' },
  { key: 'swipeDistance', id: 'swipe-distance', label: 'Swipe distance', unit: 'px', min: 32, max: 120, step: 8, value: 48, property: '--panel-swipe-distance' },
  { key: 'previewFadeDuration', id: 'preview-fade-duration', label: 'Timings exit duration', unit: 'ms', min: 400, max: 1800, step: 100, value: 1000, property: '--preview-fade-duration', stage: true },
  { key: 'previewFadeDelay', id: 'preview-fade-delay', label: 'Timings exit delay', unit: 'ms', min: 0, max: 500, step: 50, value: 100, property: '--preview-fade-delay', stage: true },
  { key: 'holdHeight', id: 'hold-height', label: 'Animation choice height', unit: 'px', min: 44, max: 112, step: 4, value: 80, property: '--hold-choice-size' },
  { key: 'speakerOffsetX', id: 'speaker-offset-x', label: 'Horizontal offset', unit: 'px', min: -80, max: 80, step: 1, value: -5, property: '--speaker-offset-x', stage: true },
  { key: 'speakerOffsetY', id: 'speaker-offset-y', label: 'Vertical offset', unit: 'px', min: -80, max: 80, step: 1, value: -5, property: '--speaker-offset-y', stage: true },
]);
const DEFAULTS = Object.freeze({ version: 3, layout: 'auto', popup: 'rise', outlines: false,
  ...Object.fromEntries(NUMBERS.map(option => [option.key, option.value])), easing: 'gentle' });
const bounded = (value, option) => Math.max(option.min, Math.min(option.max,
  option.min + Math.round((value - option.min) / option.step) * option.step));

/** Development-only controls. App presets, preferences and session state stay
 * with the app; this module owns only its own local settings and root attributes.
 */
export class DeveloperMode {
  #document;
  #window;
  #practice;
  #stage;
  #shell;
  #host;
  #shadow;
  #launcher;
  #dialog;
  #tabs = new Map();
  #panels = new Map();
  #layoutInputs = new Map();
  #popupInputs = new Map();
  #numberInputs = new Map();
  #easingInput;
  #outlineInput;
  #layoutNote;
  #status;
  #preferences;
  #storage;
  #storageFailed = false;
  #observer;
  #activeTab = 'layout';
  #restoreFocus = true;
  #disposed = false;
  #listeners = [];

  constructor({ document = globalThis.document, window = globalThis.window } = {}) {
    if (typeof document?.createElement !== 'function' || typeof document.getElementById !== 'function'
      || typeof document.addEventListener !== 'function' || typeof document.removeEventListener !== 'function'
      || !document.documentElement?.dataset || typeof window?.addEventListener !== 'function'
      || typeof window.removeEventListener !== 'function' || !Number.isFinite(window.innerWidth)
      || !Number.isFinite(window.innerHeight)) {
      throw new TypeError('DeveloperMode requires an app document and responsive browser window.');
    }
    this.#document = document;
    this.#window = window;
    this.#practice = document.getElementById('practice');
    this.#shell = document.getElementById('app-shell');
    this.#stage = document.getElementById('exercise-stage');
    if (!this.#practice?.dataset || !this.#shell || !this.#stage
      || typeof this.#practice.style?.setProperty !== 'function' || typeof this.#practice.style.removeProperty !== 'function'
      || typeof this.#stage.style?.setProperty !== 'function' || typeof this.#stage.style.removeProperty !== 'function'
      || typeof document.body?.append !== 'function' || document.getElementById('developer-tools')) {
      throw new Error('DeveloperMode requires one initialized app and no existing developer tools.');
    }
    try { this.#storage = window.localStorage; } catch { this.#storageFailed = true; }
    this.#preferences = this.#load();
    // Apply saved choices synchronously before creating the visible controls.
    this.#apply();
    this.#build();
    this.#syncInputs();
    this.#syncAvailability();
    this.#listen(window, 'resize', () => { this.#apply(); this.#syncInputs(); this.#positionLauncher(); });
    this.#listen(document, 'visibilitychange', () => this.#syncAvailability());
    this.#listen(window, 'pagehide', () => this.#close(false));
    if (typeof window.MutationObserver === 'function') {
      this.#observer = new window.MutationObserver(() => this.#syncAvailability());
      this.#observer.observe(this.#practice, { attributes: true, attributeFilter: ['data-state', 'data-starting', 'style'] });
      this.#observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });
      this.#observer.observe(this.#shell, { attributes: true, attributeFilter: ['hidden'] });
    }
  }

  dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#close(false);
    this.#observer?.disconnect();
    for (const remove of this.#listeners) remove();
    this.#listeners = [];
    this.#host.remove();
    for (const key of ['devLayout', 'devPopup', 'devOutlines']) delete this.#document.documentElement.dataset[key];
    this.#clearOverrides();
  }

  #load() {
    try {
      let saved = JSON.parse(this.#storage?.getItem(STORAGE_KEY) ?? 'null');
      if (saved === null) {
        const previous = JSON.parse(this.#storage?.getItem(PREVIOUS_STORAGE_KEY) ?? 'null');
        if (previous?.version === 2) saved = { ...previous, version: 3,
          slideDuration: previous.slideDuration === 1200 ? DEFAULTS.slideDuration : previous.slideDuration,
          travelGap: previous.travelGap === 16 ? DEFAULTS.travelGap : previous.travelGap };
      }
      if (saved === null) {
        const legacy = JSON.parse(this.#storage?.getItem(LEGACY_STORAGE_KEY) ?? 'null');
        return { ...DEFAULTS, outlines: legacy?.version === 1 && legacy.outlines === true };
      }
      if (!saved || typeof saved !== 'object' || Array.isArray(saved) || saved.version !== 3) return { ...DEFAULTS };
      return {
        ...DEFAULTS,
        layout: LAYOUTS.some(option => option.id === saved.layout) ? saved.layout : DEFAULTS.layout,
        popup: POPUP_VARIANTS.some(option => option.id === saved.popup) ? saved.popup : DEFAULTS.popup,
        outlines: saved.outlines === true,
        ...Object.fromEntries(NUMBERS.map(option => [option.key,
          typeof saved[option.key] === 'number' && Number.isFinite(saved[option.key])
            ? bounded(saved[option.key], option) : option.value])),
        easing: Object.hasOwn(EASINGS, saved.easing) ? saved.easing : DEFAULTS.easing,
      };
    } catch { return { ...DEFAULTS }; }
  }

  #save() {
    try {
      if (!this.#storage) throw new Error('Storage unavailable.');
      this.#storage.setItem(STORAGE_KEY, JSON.stringify(this.#preferences));
      this.#storageFailed = false;
      this.#status.textContent = 'Developer choices saved on this device.';
    } catch {
      this.#storageFailed = true;
      this.#status.textContent = 'Developer choices are for this visit.';
    }
  }

  #splitAvailable() { return this.#window.innerWidth >= 600 && this.#window.innerHeight >= 340; }

  #apply() {
    const data = this.#document.documentElement.dataset;
    data.devLayout = this.#preferences.layout === 'split' && !this.#splitAvailable() ? 'auto' : this.#preferences.layout;
    data.devPopup = this.#preferences.popup;
    data.devOutlines = String(this.#preferences.outlines);
    for (const option of NUMBERS) {
      const style = option.stage ? this.#stage.style : this.#practice.style;
      if (this.#preferences[option.key] === option.value) style.removeProperty(option.property);
      else style.setProperty(option.property, `${this.#preferences[option.key]}${option.unit}`);
    }
    if (this.#preferences.easing === DEFAULTS.easing) this.#practice.style.removeProperty('--panel-slide-easing');
    else this.#practice.style.setProperty('--panel-slide-easing', EASINGS[this.#preferences.easing]);
    this.#positionLauncher();
  }

  #clearOverrides() {
    for (const option of NUMBERS) (option.stage ? this.#stage.style : this.#practice.style).removeProperty(option.property);
    this.#practice.style.removeProperty('--panel-slide-easing');
  }

  #build() {
    this.#host = this.#node('div', { id: 'developer-tools', popover: 'manual' });
    if (typeof this.#host.attachShadow !== 'function') throw new TypeError('DeveloperMode requires Shadow DOM.');
    this.#shadow = this.#host.attachShadow({ mode: 'open' });
    this.#shadow.append(this.#node('link', { rel: 'stylesheet', href: new URL('./developer-mode.css', import.meta.url).href }));
    this.#launcher = this.#node('button', { id: 'developer-launcher', class: 'developer-launcher', type: 'button',
      'data-panel-gesture-source': 'practice',
      'aria-label': 'Open developer controls', 'aria-haspopup': 'dialog', 'aria-controls': 'developer-dialog', 'aria-expanded': 'false' }, 'D');
    this.#launcher.title = 'Developer controls';
    this.#shadow.append(this.#launcher);
    this.#listen(this.#launcher, 'click', () => this.#open());
    // Clear app popovers before their document capture policy sees this overlay gesture.
    // The original pointer/click still reaches the native launcher normally.
    for (const type of ['pointerdown', 'click']) this.#listen(this.#window, type, event => {
      const path = typeof event.composedPath === 'function' ? event.composedPath() : [event.target];
      if ((path.includes(this.#launcher) || path.includes(this.#dialog)) && this.#available()) this.#closePopovers();
    }, true);

    this.#dialog = this.#node('dialog', { id: 'developer-dialog', class: 'developer-dialog',
      'aria-labelledby': 'developer-heading', 'aria-describedby': 'developer-description' });
    const header = this.#node('div', { class: 'developer-header' });
    header.append(this.#node('h2', { id: 'developer-heading' }, 'Developer'));
    const close = this.#node('button', { id: 'developer-close', class: 'developer-button developer-close', type: 'button' }, 'Close');
    this.#listen(close, 'click', () => this.#close());
    header.append(close);
    this.#dialog.append(header, this.#node('p', { id: 'developer-description', class: 'developer-description' },
      'Changes appear live. Keep this inspector open while trying the app.'));
    const tabs = this.#node('div', { class: 'developer-tabs', role: 'tablist', 'aria-label': 'Developer controls' });
    const tabNames = ['layout', 'slider', 'animation'];
    for (const [id, label] of [['layout', 'Layout'], ['slider', 'Slider'], ['animation', 'Animation']]) {
      const tab = this.#node('button', { id: `developer-${id}-tab`, class: 'developer-tab', type: 'button', role: 'tab',
        'aria-controls': `developer-${id}-panel`, 'aria-selected': String(id === 'layout'), tabindex: id === 'layout' ? '0' : '-1' }, label);
      const panel = this.#node('section', { id: `developer-${id}-panel`, class: 'developer-panel', role: 'tabpanel',
        'aria-labelledby': `developer-${id}-tab`, tabindex: '0' });
      panel.hidden = id !== 'layout';
      this.#tabs.set(id, tab);
      this.#panels.set(id, panel);
      this.#listen(tab, 'click', () => this.#selectTab(id));
      this.#listen(tab, 'keydown', event => {
        const index = tabNames.indexOf(this.#activeTab);
        const target = event.key === 'Home' ? tabNames[0] : event.key === 'End' ? tabNames.at(-1)
          : event.key === 'ArrowLeft' ? tabNames[(index + tabNames.length - 1) % tabNames.length]
            : event.key === 'ArrowRight' ? tabNames[(index + 1) % tabNames.length] : null;
        if (!target) return;
        event.preventDefault();
        this.#selectTab(target);
        this.#tabs.get(target).focus({ preventScroll: true });
      });
      tabs.append(tab);
    }
    this.#dialog.append(tabs);
    this.#buildLayouts();
    this.#buildSlider();
    this.#buildAnimations();
    this.#dialog.append(...this.#panels.values());
    const footer = this.#node('div', { class: 'developer-footer' });
    const reset = this.#node('button', { id: 'developer-reset', class: 'developer-button', type: 'button' }, 'Reset developer choices');
    this.#listen(reset, 'click', () => this.#reset());
    this.#status = this.#node('p', { class: 'developer-status', role: 'status' },
      this.#storageFailed ? 'Developer choices are for this visit.' : 'Developer choices are separate from your breathing patterns.');
    footer.append(reset, this.#status);
    this.#dialog.append(footer);
    this.#shadow.append(this.#dialog);
    this.#document.body.append(this.#host);
    this.#host.showPopover();
    this.#listen(this.#dialog, 'cancel', event => { event.preventDefault(); this.#close(); });
    this.#listen(this.#dialog, 'keydown', event => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      this.#close();
    });
    this.#listen(this.#dialog, 'close', () => {
      this.#launcher.setAttribute('aria-expanded', 'false');
      if (this.#restoreFocus && this.#available()) this.#launcher.focus({ preventScroll: true });
    });
    this.#listen(this.#dialog, 'click', event => {
      if (event.target !== this.#dialog || event.detail === 0) return;
      const box = this.#dialog.getBoundingClientRect();
      if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) this.#close();
    });
  }

  #buildLayouts() {
    const panel = this.#panels.get('layout');
    const fieldset = this.#node('fieldset', { class: 'developer-options' });
    fieldset.append(this.#node('legend', {}, 'Layout'));
    for (const option of LAYOUTS) {
      const { label, input } = this.#option('layout', option);
      this.#layoutInputs.set(option.id, input);
      this.#listen(input, 'change', () => {
        if (!input.checked || input.disabled) return;
        this.#preferences.layout = option.id;
        this.#apply(); this.#syncInputs(); this.#save();
      });
      fieldset.append(label);
    }
    this.#layoutNote = this.#node('p', { class: 'developer-note' });
    const outlines = this.#node('label', { class: 'developer-outline-option' });
    this.#outlineInput = this.#node('input', { id: 'developer-outlines', type: 'checkbox' });
    outlines.append(this.#outlineInput, this.#node('span', {}, 'Show layout outlines'));
    this.#listen(this.#outlineInput, 'change', () => {
      this.#preferences.outlines = this.#outlineInput.checked;
      this.#apply(); this.#save();
    });
    panel.append(fieldset, this.#layoutNote, outlines,
      this.#numberControl(NUMBERS.find(option => option.key === 'holdHeight')));
    const speaker = this.#node('fieldset', { id: 'developer-speaker-position', class: 'developer-options developer-speaker-position' });
    speaker.append(this.#node('legend', {}, 'Speaker position'),
      this.#node('p', { id: 'developer-speaker-position-note', class: 'developer-note' },
        'Relative to the circle. Negative moves left or up.'));
    for (const option of NUMBERS.filter(option => ['speakerOffsetX', 'speakerOffsetY'].includes(option.key))) {
      speaker.append(this.#numberControl(option));
      this.#numberInputs.get(option.key).setAttribute('aria-describedby', 'developer-speaker-position-note');
    }
    panel.append(speaker);
  }

  #buildSlider() {
    const panel = this.#panels.get('slider');
    const slides = this.#node('fieldset', { class: 'developer-options developer-numbers' });
    slides.append(this.#node('legend', {}, 'Panel swipe and slide'));
    for (const option of NUMBERS.filter(option => ['slideDuration', 'travelGap', 'swipeDistance'].includes(option.key))) {
      slides.append(this.#numberControl(option));
    }
    const easing = this.#node('label', { class: 'developer-select', for: 'developer-slide-easing' }, 'Slide easing');
    this.#easingInput = this.#node('select', { id: 'developer-slide-easing' });
    for (const [value, name] of [['gentle', 'Gentle'], ['standard', 'Standard'], ['linear', 'Linear']]) {
      this.#easingInput.append(this.#node('option', { value }, name));
    }
    this.#listen(this.#easingInput, 'change', () => {
      if (!Object.hasOwn(EASINGS, this.#easingInput.value)) return;
      this.#preferences.easing = this.#easingInput.value;
      this.#apply(); this.#save();
    });
    easing.append(this.#easingInput);
    slides.append(easing);
    const preview = this.#node('fieldset', { class: 'developer-options developer-numbers' });
    preview.append(this.#node('legend', {}, 'Hidden timings exit'));
    for (const option of NUMBERS.filter(option => ['previewFadeDuration', 'previewFadeDelay'].includes(option.key))) {
      preview.append(this.#numberControl(option));
    }
    panel.append(slides, preview);
  }

  #numberControl(option) {
    const id = `developer-${option.id}`;
    const field = this.#node('div', { class: 'developer-number-field' });
    const label = this.#node('label', { for: id }, `${option.label} (${option.unit})`);
    const row = this.#node('div', { class: 'developer-stepper' });
    const input = this.#node('input', { id, type: 'number', inputmode: 'numeric', min: String(option.min),
      max: String(option.max), step: String(option.step), value: String(option.value) });
    this.#numberInputs.set(option.key, input);
    const update = (value, sync = true) => {
      if (!Number.isFinite(value)) return;
      this.#preferences[option.key] = bounded(value, option);
      this.#apply();
      if (sync) this.#syncInputs();
      this.#save();
    };
    for (const [direction, amount, text] of [['decrease', -1, '−'], ['increase', 1, '+']]) {
      const button = this.#node('button', { id: `${id}-${direction}`, class: 'developer-button', type: 'button',
        'aria-label': `${direction === 'increase' ? 'Increase' : 'Decrease'} ${option.label.toLowerCase()} by ${option.step} ${option.unit}` }, text);
      this.#listen(button, 'click', () => update(this.#preferences[option.key] + amount * option.step));
      if (amount < 0) row.append(button, input); else row.append(button);
    }
    this.#listen(input, 'input', () => {
      if (input.value.trim() !== '') update(Number(input.value), false);
    });
    this.#listen(input, 'change', () => {
      if (input.value.trim() !== '' && Number.isFinite(Number(input.value))) update(Number(input.value));
      else this.#syncInputs();
    });
    field.append(label, row);
    return field;
  }

  #buildAnimations() {
    const panel = this.#panels.get('animation');
    const fieldset = this.#node('fieldset', { class: 'developer-options' });
    fieldset.append(this.#node('legend', {}, 'Timing popup animation'));
    for (const option of POPUP_VARIANTS) {
      const { label, input } = this.#option('popup', option);
      this.#popupInputs.set(option.id, input);
      this.#listen(input, 'change', () => {
        if (!input.checked) return;
        this.#preferences.popup = option.id;
        this.#apply(); this.#syncInputs(); this.#save();
        this.#replay();
      });
      fieldset.append(label);
    }
    const replay = this.#node('button', { id: 'developer-replay', class: 'developer-button developer-primary', type: 'button' }, 'Replay timing popup');
    this.#listen(replay, 'click', () => this.#replay());
    panel.append(fieldset, replay);
  }

  #option(kind, option) {
    const label = this.#node('label', { class: 'developer-option' });
    const input = this.#node('input', { id: `developer-${kind}-${option.id}`, type: 'radio', name: `developer-${kind}`, value: option.id });
    const copy = this.#node('span', { class: 'developer-option-copy' });
    copy.append(this.#node('span', { class: 'developer-option-name' }, option.name),
      this.#node('span', { class: 'developer-option-description' }, option.description));
    label.append(input, copy);
    return { label, input };
  }

  #syncInputs() {
    for (const [id, input] of this.#layoutInputs) input.checked = this.#preferences.layout === id;
    for (const [id, input] of this.#popupInputs) input.checked = this.#preferences.popup === id;
    this.#outlineInput.checked = this.#preferences.outlines;
    for (const [key, input] of this.#numberInputs) input.value = String(this.#preferences[key]);
    this.#easingInput.value = this.#preferences.easing;
    const available = this.#splitAvailable();
    this.#layoutInputs.get('split').disabled = !available;
    this.#layoutNote.textContent = !available && this.#preferences.layout === 'split'
      ? 'Automatic layout is active here. Split returns on a wider screen.'
      : available ? 'Layout changes apply to the app behind this dialog.' : 'Split needs a screen at least 600 × 340 px.';
  }

  #selectTab(id) {
    this.#activeTab = id;
    for (const [name, tab] of this.#tabs) {
      const selected = name === id;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
      this.#panels.get(name).hidden = !selected;
    }
  }

  #available() {
    return !this.#disposed && !this.#document.hidden && !this.#shell.hidden
      && this.#practice.dataset.state === 'idle' && this.#practice.dataset.starting !== 'true'
      && !this.#document.body.classList.contains('is-zen');
  }

  #syncAvailability() {
    const available = this.#available();
    this.#launcher.hidden = !available;
    this.#launcher.disabled = !available;
    this.#launcher.inert = !available;
    if (!available) this.#close(false);
    else this.#positionLauncher();
  }

  #positionLauncher() {
    if (!this.#launcher) return;
    const circle = this.#document.getElementById('breathing-orb') ?? this.#stage;
    let box = circle.getBoundingClientRect();
    const visual = this.#document.getElementById('breathing-visual');
    if (visual && typeof this.#window.getComputedStyle === 'function') {
      const style = this.#window.getComputedStyle(visual), bounds = visual.getBoundingClientRect();
      const size = bounds.width * parseFloat(style.getPropertyValue('--orb-ratio'))
        * parseFloat(style.getPropertyValue('--breath-small'));
      if (Number.isFinite(size) && size > 0) box = { width: size, height: size,
        left: bounds.left + (bounds.width - size) / 2, top: bounds.top + (bounds.height - size) / 2 };
    }
    const fontSize = Math.max(9, Math.min(14, box.width * .1));
    // Keep the overlay independent of app markup while anchoring its glyph inside the circle.
    // Extend the touch target away from the center so swipes still begin on tiny circles.
    this.#launcher.style.setProperty('left', `${box.left + box.width * .3 - 44 + fontSize * .35}px`);
    this.#launcher.style.setProperty('top', `${box.top + box.height * .7 - 44 + fontSize * .5}px`);
    this.#launcher.style.setProperty('--developer-mark-size', `${fontSize}px`);
  }

  #open() {
    if (!this.#available() || this.#dialog.open) return;
    this.#closePopovers();
    this.#restoreFocus = true;
    this.#dialog.show();
    this.#launcher.setAttribute('aria-expanded', 'true');
    this.#tabs.get(this.#activeTab).focus({ preventScroll: true });
  }

  #close(restoreFocus = true) {
    this.#restoreFocus = restoreFocus;
    if (this.#dialog?.open) this.#dialog.close();
    this.#launcher?.setAttribute('aria-expanded', 'false');
  }

  #closePopovers() {
    for (const popup of this.#document.querySelectorAll('.duration-picker')) {
      if (popup.matches(':popover-open')) popup.hidePopover();
      for (const animation of popup.getAnimations?.({ subtree: true }) ?? []) animation.finish?.();
    }
  }

  #replay() {
    if (!this.#available()) return;
    this.#closePopovers();
    this.#document.getElementById('timing-tab').click();
    if (this.#available()) this.#document.getElementById('inhale-value').click();
  }

  #reset() {
    this.#preferences = { ...DEFAULTS };
    this.#apply(); this.#syncInputs();
    try {
      if (!this.#storage) throw new Error('Storage unavailable.');
      this.#storage.removeItem(STORAGE_KEY);
      this.#storage.removeItem(PREVIOUS_STORAGE_KEY);
      this.#storage.removeItem(LEGACY_STORAGE_KEY);
      this.#storageFailed = false;
      this.#status.textContent = 'Developer choices reset.';
    } catch {
      this.#storageFailed = true;
      this.#status.textContent = 'Defaults restored for this visit.';
    }
  }

  #node(tag, attributes = {}, content) {
    const element = this.#document.createElement(tag);
    for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value);
    if (content !== undefined) element.textContent = content;
    return element;
  }

  #listen(target, type, listener, options) {
    target.addEventListener(type, listener, options);
    this.#listeners.push(() => target.removeEventListener(type, listener, options));
  }
}
