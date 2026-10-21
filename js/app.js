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
import { ResetConfirmation } from './reset-confirmation.js';
import { PresetDeleteConfirmation } from './preset-delete-confirmation.js';
import { OutsideDismissal } from './outside-dismissal.js';
import { formatDuration, phaseDescription, spokenDuration } from './phase-labels.js';

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
  'preset-editor', 'preset-editor-done', 'preset-editor-cancel',
  'install-button', 'reset-local-data', 'notification', ...Object.keys(TOGGLE_PREFERENCES),
  'reset-confirmation', 'reset-cancel', 'reset-delete',
  'preset-delete-confirmation', 'preset-delete-cancel', 'preset-delete-confirm', 'preset-delete-name',
  'holdIn-enabled', 'holdOut-enabled',
  ...PHASES.flatMap((phase) => [`${phase}-value`, `${phase}-decrease`, `${phase}-increase`, `${phase}-fine-decrease`, `${phase}-fine-increase`, `${phase}-picker`, `${phase}-picked-value`, `${phase}-slider`, `track-${phase}`]),
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
  get #status() { return this.#session.snapshot.status; }
  #presetsChanged = false;
  #elements = {};
  #zenSurroundings;
  #durationPicker;
  #presetTiles;
  #sessionView;
  #offlineSupport;
  #notificationTimer;
  #notificationClearTimer;
  #notificationDismissible = false;
  #storageWarningShown = false;
  #preferences;
  #zenMode = false;
  #resetting = false;
  #resetConfirmation;
  #presetDeleteConfirmation;

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
      onChange: (phase, value) => this.#setField(phase, value), onCommit: () => {},
      canChange: () => this.#status === 'idle',
    });
    this.#presetTiles = new PresetTiles({ document, container: this.#elements['preset-tiles'],
      onSelect: (id) => this.#selectPreset(id),
    });
    new InstallPrompt({ window, button: this.#elements['install-button'],
      onUnavailable: () => this.#notify('install b from your browser menu.'),
    });
    this.#resetConfirmation = new ResetConfirmation({ document, window,
      dialog: this.#elements['reset-confirmation'], cancelButton: this.#elements['reset-cancel'],
      deleteButton: this.#elements['reset-delete'], onConfirm: () => this.#resetLocalData(),
    });
    this.#presetDeleteConfirmation = new PresetDeleteConfirmation({ document, window,
      trigger: this.#elements['delete-preset'], popup: this.#elements['preset-delete-confirmation'],
      cancelButton: this.#elements['preset-delete-cancel'], confirmButton: this.#elements['preset-delete-confirm'],
      nameElement: this.#elements['preset-delete-name'], getPreset: () => this.#editor.selected,
      canDelete: () => !this.#resetting && this.#status === 'idle' && this.#presets.length > 2,
      onConfirm: (id) => this.#deletePreset(id),
    });
    new OutsideDismissal({ document,
      surface: () => this.#notificationDismissible && this.#elements.notification.classList.contains('is-visible')
        ? this.#elements.notification : null,
      onDismiss: () => this.#hideNotification(),
    });
    this.#navigation = new ZenNavigator({ window, onChange: (enabled) => {
      if (!enabled && this.#status !== 'idle') this.#stopSession();
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
    ui['preset-editor-done'].addEventListener('click', () => this.#savePattern());
    ui['preset-editor-cancel'].addEventListener('click', () => this.#cancelPattern());
    ui['session-button'].addEventListener('click', () => this.#toggleSession());
    ui['reset-local-data'].addEventListener('click', () => {
      if (this.#resetting || this.#status !== 'idle') return;
      this.#presetDeleteConfirmation.close();
      this.#durationPicker.close();
      this.#resetConfirmation.open();
    });
    this.#document.addEventListener('click', (event) => {
      if (!this.#zenMode || !this.#preferences.fadeButtons
        || this.#status === 'paused') return;
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
      if (this.#status !== 'idle') return;
      try {
        this.#editor.rename(ui['preset-name'].value);
      } catch (error) {
        if (!(error instanceof RangeError)) throw error;
        ui['preset-name'].setCustomValidity('use 1–32 characters for the preset name.');
        return;
      }
      ui['preset-name'].setCustomValidity('');
      this.#syncPresetControls();
    });
    ui['preset-name'].addEventListener('change', () => {
      if (this.#resetting) return;
      if (ui['preset-name'].validity.valid) ui['preset-name'].value = this.#editor.selected.name;
    });
    ui['preset-name'].addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || event.isComposing || event.keyCode === 229) return;
      event.preventDefault();
      ui['preset-name'].blur();
      ui['preset-name'].value = this.#editor.selected.name;
      ui['preset-name'].setCustomValidity('');
    });
    this.#document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && this.#zenMode) this.#navigation.leave();
    });
    ui['preset-selector'].addEventListener('change', ({ target }) => {
      if (this.#status !== 'idle') return;
      this.#selectPreset(target.value);
      this.#scrollPatternSettings();
    });

    this.#document.addEventListener('visibilitychange', () => {
      if (this.#document.hidden) this.#suspend();
    });
    this.#window.addEventListener('pagehide', () => this.#suspend());

    this.#window.addEventListener('storage', (event) => {
      // An active exercise keeps its timing even if another tab edits a preset.
      if (PresetStore.affectsPresets(event.key)) {
        this.#presetsChanged = true;
        if (this.#status === 'idle') this.#refreshPresets();
      }
      if (PresetStore.affectsPreferences(event.key)) {
        this.#preferences = this.#store.loadPreferences();
        this.#syncPreferences();
      }
    });
  }

  /** Leaving the page pauses a running exercise; pattern drafts remain unsaved. */
  #suspend() {
    if (this.#resetting) return;
    this.#presetDeleteConfirmation.close();
    if (this.#status === 'running') this.#session.pause();
  }

  #savePattern() {
    if (this.#status !== 'idle' || this.#resetting) return;
    if (!this.#elements['settings-form'].reportValidity()) return;
    this.#durationPicker.close();
    this.#presetDeleteConfirmation.close();
    if (!this.#editor.save()) return;
    this.#populatePresets();
    this.#syncSettings();
    this.#render(this.#session.snapshot);
  }

  #cancelPattern() {
    if (this.#status !== 'idle' || this.#resetting) return;
    this.#durationPicker.close();
    this.#presetDeleteConfirmation.close();
    this.#editor.cancel();
    this.#populatePresets();
    this.#syncSettings();
    this.#render(this.#session.snapshot);
  }

  #resetLocalData() {
    if (this.#resetting || this.#status !== 'idle') return;
    this.#durationPicker.close();
    try {
      this.#store.reset();
    } catch (error) {
      if (!(error instanceof PersistenceError)) throw error;
      this.#notify('local data could not be reset. storage is unavailable.');
      return;
    }
    this.#resetting = true;
    this.#document.getElementById('app-shell')?.setAttribute('hidden', '');
    this.#window.history.scrollRestoration = 'manual';
    this.#window.history.replaceState(null, '', this.#window.location.pathname + this.#window.location.search);
    this.#window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
    this.#window.location.reload();
  }

  #refreshPresets() {
    this.#presetDeleteConfirmation.close();
    this.#durationPicker.close();
    if (!this.#editor.refresh()) return;
    this.#presetsChanged = false;
    this.#populatePresets();
    this.#syncSettings();
    this.#render(this.#session.snapshot);
  }

  #setField(field, value) {
    if (this.#status !== 'idle') return;
    this.#editor.setConfig({ ...this.#config, [field]: value });
    this.#syncSettings();
    this.#render(this.#session.snapshot);
  }

  #scrollPatternSettings() {
    if (this.#status !== 'idle' || this.#resetting) return;
    this.#elements['settings-form'].scrollIntoView({ block: 'start',
      behavior: this.#window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
  }

  #selectPreset(id) {
    if (this.#status !== 'idle') return;
    this.#presetDeleteConfirmation.close();
    this.#durationPicker.close();
    const adding = id === 'add-preset';
    if (adding) this.#editor.add();
    else this.#editor.select(id);
    this.#populatePresets();
    this.#syncSettings();
    this.#render(this.#session.snapshot);
    this.#elements['phase-announcement'].textContent = `${this.#editor.selected.name} ${adding ? 'added' : 'selected'}.`;
    if (adding) {
      this.#elements['preset-name'].focus({ preventScroll: true });
      this.#elements['preset-name'].select();
    }
  }

  #deletePreset(id) {
    if (this.#resetting || this.#status !== 'idle' || this.#presets.length <= 2
      || this.#editor.selected.id !== id) return;
    this.#durationPicker.close();
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
    this.#elements['preset-selector'].focus({ preventScroll: true });
    this.#notify(`${name} removed.`, { dismissOnOutside: true });
  }

  #syncSettings() {
    const ui = this.#elements;
    ui['preset-name'].value = this.#editor.selected.name;
    ui['preset-name'].setCustomValidity('');
    this.#durationPicker.render(this.#config, this.#editor.selected.id);
    for (const field of PHASES) {
      const value = this.#config[field];
      ui[`track-${field}`].textContent = formatDuration(value);
      const step = ui['phase-track'].querySelector(`[data-phase="${field}"]`);
      step.classList.toggle('is-skipped', value === 0);
      step.setAttribute('aria-label', `${phaseDescription(field)}: ${value === 0 ? 'skipped' : spokenDuration(value)}`);
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
    this.#presetDeleteConfirmation.render();
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

  /** Restore controls and keep guides hidden until their saved preference is applied. */
  #syncPreferences() {
    for (const [id, preference] of Object.entries(TOGGLE_PREFERENCES)) {
      this.#elements[id].checked = this.#preferences[preference];
    }
    for (const guide of this.#elements['breathing-visual'].querySelectorAll('.breath-guide')) {
      guide.toggleAttribute('hidden', !this.#preferences.showBreathGuides);
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
    this.#elements['session-button'].focus({ preventScroll: true });
  }

  #stopSession() {
    this.#session.stop();
    if (this.#presetsChanged) this.#refreshPresets();
  }

  #toggleSession() {
    this.#presetDeleteConfirmation.close();
    this.#durationPicker.close();
    const status = this.#status;
    if (status === 'running') {
      this.#navigation.leave();
      return;
    }
    if (status === 'idle') {
      if (!this.#elements['settings-form'].reportValidity()) return;
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
    this.#sessionView.render(snapshot, { inhale: this.#config.inhale });
    if (snapshot.status === 'idle') this.#offlineSupport?.applyPendingUpdate();
  }

  #notify(message, { dismissOnOutside = false } = {}) {
    clearTimeout(this.#notificationTimer);
    clearTimeout(this.#notificationClearTimer);
    const notification = this.#elements.notification;
    this.#notificationDismissible = dismissOnOutside;
    notification.textContent = message;
    notification.classList.add('is-visible');
    this.#notificationTimer = setTimeout(() => this.#hideNotification(), 5000);
  }

  #hideNotification() {
    clearTimeout(this.#notificationTimer);
    clearTimeout(this.#notificationClearTimer);
    const notification = this.#elements.notification;
    this.#notificationDismissible = false;
    notification.classList.remove('is-visible');
    this.#notificationClearTimer = setTimeout(() => { notification.textContent = ''; }, 200);
  }

  #registerOfflineSupport() {
    this.#offlineSupport = new OfflineSupport({ window: this.#window, document: this.#document,
      onUnavailable: () => this.#notify('offline mode unavailable. reopen b while online to retry.'),
      isIdle: () => this.#status === 'idle' && !this.#editor.hasDrafts,
    });
    this.#offlineSupport.start();
  }
}
