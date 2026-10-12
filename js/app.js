import { BreathingEngine, PHASES } from './breathing-engine.js';
import { HOLD_FEEDBACK_VARIANTS, PersistenceError, PresetStore } from './preset-store.js';
import { PresetEditor } from './preset-editor.js';
import { SessionDriver } from './session-driver.js';
import { WakeLockGuard } from './wake-lock-guard.js';
import { ZenNavigator } from './zen-navigator.js';
import { PhaseCues } from './phase-cues.js';

const phaseLabel = (phase) => (phase.startsWith('hold') ? 'hold' : phase);
const TOGGLE_PREFERENCES = {
  'show-breath-text': 'showBreathText',
  'show-breath-guides': 'showBreathGuides',
  'show-breath-numbers': 'showBreathNumbers',
  'fade-buttons': 'fadeButtons',
  'sound-cue': 'soundCue',
  'vibration': 'vibration',
};

export const REQUIRED_IDS = Object.freeze([
  'practice', 'breathing-visual', 'breathing-orb', 'hold-fill', 'phase-caption',
  'phase-count', 'phase-track', 'phase-announcement', 'session-button',
  'session-button-icon', 'session-button-label', 'hold-choices', 'preset-name',
  'preset-tiles', 'preset-selector', 'preset-fields', 'settings-form', 'settings-fields', 'settings-note', 'timing-fields',
  'zen-back', 'install-button', 'notification', ...Object.keys(TOGGLE_PREFERENCES),
  ...PHASES.flatMap((phase) => [`${phase}-value`, `track-${phase}`]),
]);

export function collectElements(document) {
  const elements = Object.fromEntries(REQUIRED_IDS.map((id) => [id, document?.getElementById(id)]));
  const missing = REQUIRED_IDS.filter((id) => !elements[id]);
  if (missing.length) throw new Error(`index.html is missing required ids: ${missing.join(', ')}`);
  return elements;
}

/** DOM adapter: one active session uses a fixed rhythm; navigation owns zen,
 * the driver owns timing, and the editor flushes only changed presets.
 * Storage failures remain usable; validation/programming errors propagate.
 */
export class BreathingApp {
  #document;
  #window;
  #store;
  #editor;
  #session;
  #wakeLock;
  #navigation;
  #cues;
  get #presets() { return this.#editor.presets; }
  get #config() { return this.#editor.selected.config; }
  #presetsChanged = false;
  #elements = {};
  #zenSurroundings;
  #lastVisualKey = '';
  #lastAnnouncementKey = '';
  #notificationTimer;
  #notificationClearTimer;
  #installPrompt = null;
  #storageWarningShown = false;
  #preferences;
  #zenMode = false;

  constructor({ document = globalThis.document, window = globalThis.window,
    store = new PresetStore(), engine = new BreathingEngine() } = {}) {
    this.#document = document;
    this.#window = window;
    this.#elements = collectElements(document);
    this.#store = store;
    this.#zenSurroundings = /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('.site-header, .settings-card, #phase-track, .preset-options, .display-controls, .cue-controls, .hold-options, .skip-link'));
    this.#wakeLock = new WakeLockGuard({ navigator: window.navigator, document });
    this.#cues = new PhaseCues({ window, navigator: window.navigator, document });
    this.#session = new SessionDriver({ engine,
      raf: window.requestAnimationFrame.bind(window), caf: window.cancelAnimationFrame.bind(window),
      onChange: (snapshot) => {
        this.#render(snapshot);
        if (snapshot.status !== 'running') this.#wakeLock.release();
      },
    });
    this.#editor = new PresetEditor({ store, onStorageError: () => this.#reportStorageFailure() });
    this.#preferences = store.loadPreferences();
    this.#navigation = new ZenNavigator({ window, onChange: (enabled) => {
      if (!enabled && this.#session.snapshot.status !== 'idle') this.#stopSession();
      this.#setZenMode(enabled);
    } });
    this.#populatePresets();
    this.#bindEvents();
    this.#syncSettings();
    this.#syncPreferences();
    this.#render(this.#session.snapshot);
    this.#navigation.sync();
    this.#registerOfflineSupport();
  }

  #bindEvents() {
    const ui = this.#elements;
    ui['settings-form'].addEventListener('submit', (event) => event.preventDefault());
    ui['session-button'].addEventListener('click', () => this.#toggleSession());
    this.#document.addEventListener('click', (event) => {
      if (!this.#zenMode || !this.#preferences.fadeButtons) return;
      // Capture the tap before a control can act on the restored menu.
      event.preventDefault();
      event.stopPropagation();
      this.#navigation.leave();
    }, true);
    for (const [id, preference] of Object.entries(TOGGLE_PREFERENCES)) {
      ui[id].addEventListener('change', () => this.#setPreference(preference, ui[id].checked));
    }
    ui['hold-choices'].addEventListener('change', ({ target }) => {
      if (HOLD_FEEDBACK_VARIANTS.includes(target.value)) this.#setPreference('holdFeedback', target.value);
    });
    ui['preset-name'].addEventListener('input', () => {
      if (this.#session.snapshot.status !== 'idle') return;
      const name = ui['preset-name'].value.trim();
      if (name.length === 0 || name.length > 32) {
        ui['preset-name'].setCustomValidity('use 1–32 characters for the preset name.');
        return;
      }
      ui['preset-name'].setCustomValidity('');
      this.#editor.rename(name);
      this.#syncPresetControls();
    });
    ui['preset-name'].addEventListener('change', () => {
      ui['preset-name'].value = this.#editor.selected.name;
      ui['preset-name'].setCustomValidity('');
      this.#editor.flush();
    });
    ui['zen-back'].addEventListener('click', () => this.#navigation.leave());
    this.#document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && this.#zenMode) this.#navigation.leave();
    });
    // Quick choices and number fields share delegated timing handlers.
    ui['timing-fields'].addEventListener('click', ({ target }) => {
      const choice = target.closest('.time-choice');
      if (!choice) return;
      this.#setField(choice.dataset.field, Number(choice.dataset.value));
      this.#editor.flush();
    });
    ui['timing-fields'].addEventListener('input', ({ target }) => {
      if (target.validity.valid) this.#setField(target.dataset.field, target.valueAsNumber);
    });
    ui['timing-fields'].addEventListener('change', ({ target }) => {
      if (target.type === 'number') {
        const value = Number.isFinite(target.valueAsNumber)
          ? Math.min(Number(target.max), Math.max(Number(target.min), Math.round(target.valueAsNumber)))
          : this.#config[target.dataset.field];
        this.#setField(target.dataset.field, value);
      }
      this.#editor.flush();
    });

    // Preset selection is locked for the duration of an exercise.
    for (const control of [ui['preset-tiles'], ui['preset-selector']]) {
      control.addEventListener('change', ({ target }) => {
        this.#editor.select(target.value);
        this.#syncSettings();
        this.#render(this.#session.snapshot);
        ui['phase-announcement'].textContent = `${this.#editor.selected.name.toLowerCase()} selected.`;
      });
    }

    this.#document.addEventListener('visibilitychange', () => {
      if (!this.#document.hidden) return;
      if (this.#session.snapshot.status === 'running') this.#session.pause();
      this.#editor.flush();
    });
    this.#window.addEventListener('pagehide', () => {
      if (this.#session.snapshot.status === 'running') this.#session.pause();
      this.#editor.flush();
    });

    this.#window.addEventListener('beforeinstallprompt', (event) => {
      event.preventDefault();
      this.#installPrompt = event;
      this.#syncInstallButton();
    });
    ui['install-button'].addEventListener('click', async () => {
      if (!this.#installPrompt) return;
      const prompt = this.#installPrompt;
      this.#installPrompt = null;
      this.#syncInstallButton();
      try {
        await prompt.prompt();
        await prompt.userChoice;
      } catch {
        this.#notify('install b from your browser menu.');
      }
    });
    this.#window.addEventListener('appinstalled', () => {
      this.#installPrompt = null;
      this.#syncInstallButton();
    });
    this.#window.addEventListener('storage', (event) => {
      // An active exercise keeps its timing even if another tab edits a preset.
      if (PresetStore.affectsPresets(event.key)) {
        this.#presetsChanged = true;
        if (this.#session.snapshot.status === 'idle') this.#refreshPresets();
      }
      if (PresetStore.affectsPreferences(event.key)) {
        this.#preferences = this.#store.loadPreferences();
        this.#syncPreferences();
      }
    });
  }

  #refreshPresets() {
    if (!this.#editor.refresh()) return;
    this.#presetsChanged = false;
    this.#populatePresets();
    this.#syncSettings();
    this.#render(this.#session.snapshot);
  }

  #setField(field, value) {
    if (this.#session.snapshot.status !== 'idle') return;
    this.#editor.setConfig({ ...this.#config, [field]: value });
    this.#syncSettings();
    this.#render(this.#session.snapshot);
  }

  #syncSettings() {
    const ui = this.#elements;
    ui['preset-name'].value = this.#editor.selected.name;
    ui['preset-name'].setCustomValidity('');
    for (const field of PHASES) {
      const value = this.#config[field];
      ui[`${field}-value`].value = value;
      ui[`track-${field}`].textContent = value === 0 ? 'off' : `${value}s`;
      const phaseStep = ui['phase-track'].querySelector(`[data-phase="${field}"]`);
      phaseStep.classList.toggle('is-skipped', value === 0);
      phaseStep.setAttribute('aria-label', `${field === 'holdIn' ? 'hold after inhale' : field === 'holdOut' ? 'hold after exhale' : field}: ${value === 0 ? 'skipped' : `${value} seconds`}`);
      const choices = /** @type {NodeListOf<HTMLButtonElement>} */ (this.#document.querySelectorAll(`.time-choice[data-field="${field}"]`));
      for (const button of choices) {
        button.setAttribute('aria-pressed', String(Number(button.dataset.value) === value));
      }
    }
    this.#syncPresetControls();
  }

  #populatePresets() {
    const tiles = this.#presets.slice(0, 4).map((preset) => {
      const tile = this.#document.createElement('label');
      tile.className = 'preset-tile';
      tile.dataset.preset = preset.id;
      const input = Object.assign(this.#document.createElement('input'),
        { type: 'radio', name: 'preset', value: preset.id, className: 'sr-only' });
      const name = this.#document.createElement('span');
      name.className = 'preset-name';
      const timing = this.#document.createElement('span');
      timing.className = 'preset-timing';
      timing.setAttribute('aria-hidden', 'true');
      tile.append(input, name, timing);
      return tile;
    });
    this.#elements['preset-tiles'].replaceChildren(...tiles);
    const options = this.#presets.map((preset) => Object.assign(this.#document.createElement('option'),
      { value: preset.id, textContent: preset.name.toLowerCase() }));
    this.#elements['preset-selector'].replaceChildren(...options);
  }

  #syncPresetControls() {
    const presets = this.#presets;
    for (const tile of this.#elements['preset-tiles'].children) {
      const preset = presets.find((item) => item.id === tile.dataset.preset);
      const input = tile.querySelector('input');
      input.checked = preset.id === this.#editor.selected.id;
      tile.querySelector('.preset-name').textContent = preset.name.toLowerCase();
      tile.querySelector('.preset-timing').textContent = `${PHASES.map((phase) => preset.config[phase]).join(' · ')} s`;
      const { inhale, holdIn, exhale, holdOut } = preset.config;
      input.setAttribute('aria-label', `${preset.name.toLowerCase()}: inhale ${inhale} seconds, hold ${holdIn} seconds, exhale ${exhale} seconds, hold ${holdOut} seconds`);
    }
    const selector = this.#elements['preset-selector'];
    for (const option of selector.options) {
      option.textContent = presets.find((preset) => preset.id === option.value).name.toLowerCase();
    }
    selector.value = this.#editor.selected.id;
  }

  #setPreference(key, value) {
    this.#preferences[key] = value;
    this.#syncPreferences();
    try {
      this.#store.savePreferences(this.#preferences);
    } catch (error) {
      if (!(error instanceof PersistenceError)) throw error;
      this.#reportStorageFailure();
    }
  }

  #reportStorageFailure() {
    this.#elements['settings-note'].textContent = 'storage unavailable. changes are for this visit.';
    if (!this.#storageWarningShown) this.#notify('changes could not be saved on this device.');
    this.#storageWarningShown = true;
  }

  /** Restores the controls; CSS derives caption, count and guide visibility from them. */
  #syncPreferences() {
    for (const [id, preference] of Object.entries(TOGGLE_PREFERENCES)) {
      this.#elements[id].checked = this.#preferences[preference];
    }
    this.#cues.configure(this.#preferences);
    for (const [id, supported] of [['sound-cue', this.#cues.soundSupported], ['vibration', this.#cues.vibrationSupported]]) {
      this.#elements[id].disabled = !supported;
      this.#elements[id].parentElement.title = supported ? '' : 'unavailable in this browser';
    }
    const { holdFeedback } = this.#preferences;
    this.#elements['breathing-visual'].dataset.holdFeedback = holdFeedback;
    this.#elements['hold-choices'].querySelector(`input[value="${holdFeedback}"]`).checked = true;
  }

  #syncInstallButton() {
    // Keep the header's current footprint throughout an exercise.
    if (!this.#zenMode) this.#elements['install-button'].hidden = this.#installPrompt === null;
  }

  #setZenMode(enabled) {
    if (this.#zenMode === enabled) return;
    this.#zenMode = enabled;
    this.#document.body.classList.toggle('is-zen', enabled);
    for (const element of this.#zenSurroundings) element.inert = enabled;
    this.#elements['zen-back'].hidden = !enabled;
    this.#syncInstallButton();
    this.#elements['session-button'].focus({ preventScroll: true });
  }

  #stopSession() {
    this.#session.stop();
    if (this.#presetsChanged) this.#refreshPresets();
  }

  #toggleSession() {
    const status = this.#session.snapshot.status;
    if (status === 'running') {
      this.#navigation.leave();
      return;
    }
    if (status === 'idle') {
      if (!this.#elements['settings-form'].reportValidity()) return;
      this.#editor.flush();
    }
    this.#cues.unlock();
    if (status === 'paused') this.#session.resume();
    else this.#session.start(this.#config);
    this.#navigation.enter();
    this.#wakeLock.acquire();
  }

  #render(snapshot) {
    this.#cues.update(snapshot);
    const ui = this.#elements;
    const { status, phase } = snapshot;
    const running = status === 'running';
    const active = running || status === 'paused';
    const visualKey = `${status}:${snapshot.phaseStartedAtMs}:${phase}`;
    const label = active ? phaseLabel(phase) : 'inhale';
    if (visualKey !== this.#lastVisualKey) {
      this.#lastVisualKey = visualKey;
      ui['settings-fields'].disabled = active;
      ui['preset-fields'].disabled = active;
      ui['session-button'].disabled = false;
      ui['session-button-label'].textContent = running ? 'stop' : status === 'paused' ? 'resume' : 'start';
      ui['session-button-icon'].className = running ? 'icon-stop' : 'icon-play';
      ui['phase-caption'].textContent = status === 'paused' ? `${label} · paused` : label;
      ui['settings-note'].textContent = this.#storageWarningShown ? 'storage unavailable. changes are for this visit.' : '';

      const visual = ui['breathing-visual'];
      visual.dataset.state = status;
      ui.practice.dataset.state = status;
      visual.dataset.phase = phase ?? 'inhale';
      visual.style.setProperty('--phase-duration', `${snapshot.phaseDurationMs}ms`);
      visual.style.setProperty('--phase-delay', `${-snapshot.phaseElapsedMs}ms`);
      // Restart CSS animation at the engine's elapsed offset, including after pause.
      const orb = ui['breathing-orb'];
      const holdFill = ui['hold-fill'];
      orb.style.animationName = 'none';
      holdFill.style.animationName = 'none';
      void orb.offsetWidth;
      orb.style.animationName = '';
      holdFill.style.animationName = '';

      for (const step of ui['phase-track'].children) {
        const selected = step.dataset.phase === (phase ?? 'inhale');
        step.classList.toggle('is-active', selected);
        if (selected) step.setAttribute('aria-current', 'step');
        else step.removeAttribute('aria-current');
      }
    }

    const count = active ? String(Math.ceil(snapshot.phaseRemainingMs / 1000)) : String(this.#config.inhale);
    if (ui['phase-count'].textContent !== count) ui['phase-count'].textContent = count;

    const announcementKey = active ? visualKey : 'idle';
    if (announcementKey !== this.#lastAnnouncementKey) {
      this.#lastAnnouncementKey = announcementKey;
      ui['phase-announcement'].textContent = active
        ? `${status === 'paused' ? 'paused. ' : ''}${label} for ${Math.ceil(snapshot.phaseRemainingMs / 1000)} seconds.`
        : '';
    }
  }

  #notify(message) {
    clearTimeout(this.#notificationTimer);
    clearTimeout(this.#notificationClearTimer);
    const notification = this.#elements.notification;
    notification.textContent = message;
    notification.classList.add('is-visible');
    this.#notificationTimer = setTimeout(() => {
      notification.classList.remove('is-visible');
      this.#notificationClearTimer = setTimeout(() => { notification.textContent = ''; }, 200);
    }, 5000);
  }

  #registerOfflineSupport() {
    if (!('serviceWorker' in this.#window.navigator) || !this.#window.isSecureContext) return;
    this.#window.navigator.serviceWorker.register('./sw.js').catch(() => {
      this.#notify('offline mode unavailable. reopen b while online to retry.');
    });
  }
}
