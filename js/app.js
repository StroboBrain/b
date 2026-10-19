import { BreathingEngine, PHASES } from './breathing-engine.js';
import { HOLD_FEEDBACK_VARIANTS, PersistenceError, PresetStore } from './preset-store.js';
import { PresetEditor } from './preset-editor.js';
import { SessionDriver } from './session-driver.js';
import { WakeLockGuard } from './wake-lock-guard.js';
import { ZenNavigator } from './zen-navigator.js';
import { PhaseCues } from './phase-cues.js';
import { OfflineSupport } from './offline-support.js';
import { DurationPicker } from './duration-picker.js';
import { PresetTiles } from './preset-tiles.js';
import { SessionView } from './session-view.js';
import { InstallPrompt } from './install-prompt.js';
import { phaseDescription } from './phase-labels.js';

const TOGGLE_PREFERENCES = {
  'show-breath-text': 'showBreathText',
  'show-breath-guides': 'showBreathGuides',
  'show-breath-numbers': 'showBreathNumbers',
  'show-phase-timings': 'showPhaseTimings',
  'fade-buttons': 'fadeButtons',
  'sound-cue': 'soundCue',
};

export const REQUIRED_IDS = Object.freeze([
  'practice', 'breathing-visual', 'breathing-orb', 'hold-fill', 'phase-caption',
  'phase-count', 'phase-track', 'phase-announcement', 'session-button',
  'session-button-icon', 'session-button-label', 'hold-choices', 'hold-feedback-fields', 'preset-name',
  'preset-tiles', 'preset-selector', 'delete-preset', 'preset-fields', 'settings-form', 'settings-fields', 'settings-note', 'timing-fields',
  'zen-back', 'install-button', 'notification', ...Object.keys(TOGGLE_PREFERENCES),
  ...PHASES.flatMap((phase) => [`${phase}-value`, `${phase}-decrease`, `${phase}-increase`, `${phase}-picker`, `${phase}-picked-value`, `track-${phase}`]),
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
  #durationPicker;
  #presetTiles;
  #sessionView;
  #offlineSupport;
  #notificationTimer;
  #notificationClearTimer;
  #storageWarningShown = false;
  #preferences;
  #zenMode = false;

  constructor({ document = globalThis.document, window = globalThis.window,
    store = new PresetStore(), engine = new BreathingEngine() } = {}) {
    this.#document = document;
    this.#window = window;
    this.#elements = collectElements(document);
    this.#store = store;
    this.#sessionView = new SessionView({ elements: this.#elements });
    this.#zenSurroundings = /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('.install-footer, .settings-card, .preset-options, .display-options, .hold-options, .skip-link'));
    this.#wakeLock = new WakeLockGuard({ navigator: window.navigator, document });
    this.#cues = new PhaseCues({ window, document });
    this.#session = new SessionDriver({ engine,
      setTimeout: window.setTimeout.bind(window), clearTimeout: window.clearTimeout.bind(window),
      onChange: (snapshot) => {
        this.#render(snapshot);
        if (snapshot.status !== 'running') this.#wakeLock.release();
      },
    });
    this.#editor = new PresetEditor({ store, onStorageError: () => this.#reportStorageFailure() });
    this.#preferences = store.loadPreferences();
    this.#durationPicker = new DurationPicker({ document, window, container: this.#elements['timing-fields'],
      onChange: (phase, value) => this.#setField(phase, value), onCommit: () => this.#editor.flush(),
      canChange: () => this.#session.snapshot.status === 'idle',
    });
    this.#presetTiles = new PresetTiles({ document, container: this.#elements['preset-tiles'],
      onSelect: (id) => this.#selectPreset(id),
    });
    new InstallPrompt({ window, button: this.#elements['install-button'],
      onUnavailable: () => this.#notify('install b from your browser menu.'),
    });
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
      if (!this.#zenMode || !this.#preferences.fadeButtons
        || this.#session.snapshot.status === 'paused') return;
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
    ui['preset-selector'].addEventListener('change', ({ target }) => this.#selectPreset(target.value));

    ui['delete-preset'].addEventListener('click', () => {
      if (this.#session.snapshot.status !== 'idle' || this.#presets.length <= 2) return;
      const name = this.#editor.selected.name;
      try {
        if (!this.#editor.remove()) return;
      } catch (error) {
        if (!(error instanceof RangeError)) throw error;
        this.#refreshPresets();
        this.#notify(error.message);
        return;
      }
      this.#populatePresets();
      this.#syncSettings();
      this.#render(this.#session.snapshot);
      ui['preset-selector'].focus();
      this.#notify(`${name} removed.`);
    });

    this.#document.addEventListener('visibilitychange', () => {
      if (!this.#document.hidden) return;
      if (this.#session.snapshot.status === 'running') this.#session.pause();
      this.#editor.flush();
    });
    this.#window.addEventListener('pagehide', () => {
      if (this.#session.snapshot.status === 'running') this.#session.pause();
      this.#editor.flush();
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
    this.#durationPicker.close();
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

  #selectPreset(id) {
    if (this.#session.snapshot.status !== 'idle') return;
    this.#durationPicker.close();
    const adding = id === 'add-preset';
    if (adding) this.#editor.add();
    else this.#editor.select(id);
    this.#populatePresets();
    this.#syncSettings();
    this.#render(this.#session.snapshot);
    this.#elements['phase-announcement'].textContent = `${this.#editor.selected.name} ${adding ? 'added' : 'selected'}.`;
    if (adding) {
      this.#elements['preset-name'].focus();
      this.#elements['preset-name'].select();
    }
  }

  #syncSettings() {
    const ui = this.#elements;
    ui['preset-name'].value = this.#editor.selected.name;
    ui['preset-name'].setCustomValidity('');
    this.#durationPicker.render(this.#config);
    for (const field of PHASES) {
      const value = this.#config[field];
      ui[`track-${field}`].textContent = value === 0 ? 'off' : `${value}s`;
      const step = ui['phase-track'].querySelector(`[data-phase="${field}"]`);
      step.classList.toggle('is-skipped', value === 0);
      step.setAttribute('aria-label', `${phaseDescription(field)}: ${value === 0 ? 'skipped' : `${value} seconds`}`);
    }
    ui['hold-feedback-fields'].disabled = this.#config.holdIn === 0 && this.#config.holdOut === 0;
    this.#syncPresetControls();
  }

  #populatePresets() {
    const options = this.#presets.map((preset) => Object.assign(this.#document.createElement('option'),
      { value: preset.id, textContent: preset.name }));
    options.push(Object.assign(this.#document.createElement('option'),
      { value: 'add-preset', textContent: 'add preset' }));
    this.#elements['preset-selector'].replaceChildren(...options);
  }

  #syncPresetControls() {
    const presets = this.#presets;
    this.#presetTiles.render(presets, this.#editor.selected.id);
    const ui = this.#elements;
    for (const option of ui['preset-selector'].options) {
      if (option.value !== 'add-preset') option.textContent = presets.find((preset) => preset.id === option.value).name;
    }
    ui['preset-selector'].value = this.#editor.selected.id;
    ui['delete-preset'].disabled = presets.length <= 2;
    ui['delete-preset'].title = presets.length <= 2 ? 'keep at least two presets' : 'delete selected preset';
    ui['delete-preset'].setAttribute('aria-label', `delete ${this.#editor.selected.name}`);
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
    this.#elements['phase-track'].setAttribute('aria-hidden', String(!this.#preferences.showPhaseTimings));
    this.#elements['sound-cue'].disabled = !this.#cues.soundSupported;
    this.#elements['sound-cue'].parentElement.title = this.#cues.soundSupported ? '' : 'unavailable in this browser';
    const { holdFeedback } = this.#preferences;
    this.#elements['breathing-visual'].dataset.holdFeedback = holdFeedback;
    this.#elements['hold-choices'].querySelector(`input[value="${holdFeedback}"]`).checked = true;
  }

  #setZenMode(enabled) {
    if (this.#zenMode === enabled) return;
    this.#zenMode = enabled;
    this.#document.body.classList.toggle('is-zen', enabled);
    for (const element of this.#zenSurroundings) element.inert = enabled;
    this.#elements['zen-back'].hidden = !enabled;
    this.#elements['session-button'].focus({ preventScroll: true });
  }

  #stopSession() {
    this.#session.stop();
    if (this.#presetsChanged) this.#refreshPresets();
  }

  #toggleSession() {
    this.#durationPicker.close();
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
    // Starting and resuming share the same viewport behavior on every device.
    this.#window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
    this.#wakeLock.acquire();
  }

  #render(snapshot) {
    this.#cues.update(snapshot);
    this.#sessionView.render(snapshot, { inhale: this.#config.inhale, storageWarning: this.#storageWarningShown });
    if (snapshot.status === 'idle') this.#offlineSupport?.applyPendingUpdate();
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
    this.#offlineSupport = new OfflineSupport({ window: this.#window, document: this.#document,
      onUnavailable: () => this.#notify('offline mode unavailable. reopen b while online to retry.'),
      isIdle: () => this.#session.snapshot.status === 'idle',
    });
    this.#offlineSupport.start();
  }
}
