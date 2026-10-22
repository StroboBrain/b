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
import { SettingsPreview } from './settings-preview.js';
import { InstallPrompt } from './install-prompt.js';
import { SectionScroller } from './section-scroller.js';
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
  'session-button-icon', 'session-button-label', 'hold-choices', 'hold-feedback-fields',
  'preset-tiles', 'preset-fields', 'settings-note', 'timing-fields', 'settings-preview',
  'install-button', 'display-settings', 'display-settings-button', 'back-to-breathing-button', 'notification', ...Object.keys(TOGGLE_PREFERENCES),
  ...PHASES.flatMap((phase) => [`${phase}-value`, `${phase}-decrease`, `${phase}-increase`, `${phase}-fine-decrease`, `${phase}-fine-increase`, `${phase}-picker`, `${phase}-picked-value`, `track-${phase}`]),
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
  #preview;
  #offlineSupport;
  #notificationTimer;
  #notificationClearTimer;
  #notificationDismissible = false;
  #storageWarningShown = false;
  #preferences;
  #zenMode = false;
  #sections;

  constructor({ document = globalThis.document, window = globalThis.window,
    store = new PresetStore(), engine = new BreathingEngine() } = {}) {
    this.#document = document;
    this.#window = window;
    this.#elements = collectElements(document);
    this.#store = store;
    this.#sessionView = new SessionView({ elements: this.#elements });
    this.#zenSurroundings = /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('.install-footer, .preset-options, .display-options, .hold-options, .skip-link, .settings-link, .settings-preview'));
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
      onChange: (phase, value) => this.#setField(phase, value),
      canChange: () => this.#status === 'idle',
    });
    this.#presetTiles = new PresetTiles({ document, container: this.#elements['preset-tiles'],
      onSelect: (id) => this.#selectPreset(id),
    });
    new InstallPrompt({ window, button: this.#elements['install-button'],
      onUnavailable: () => this.#notify('install b from your browser menu.'),
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
    this.#preview = new SettingsPreview({ document, window, container: this.#elements['settings-preview'] });
    this.#sections = new SectionScroller({ document, window });
    this.#bindEvents();
    this.#syncSettings();
    this.#syncPreferences();
    this.#render(this.#session.snapshot);
    this.#navigation.sync();
    this.#registerOfflineSupport();
  }

  #bindEvents() {
    const ui = this.#elements;
    ui['session-button'].addEventListener('click', () => this.#toggleSession());
    for (const [button, page] of [
      ['display-settings-button', 'display-settings'], ['back-to-breathing-button', 'practice'],
    ]) {
      ui[button].addEventListener('click', () => {
        if (this.#status !== 'idle') return;
        this.#durationPicker.close();
        this.#sections.goTo(ui[page]);
        ui[page].focus({ preventScroll: true });
      });
    }
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
    this.#document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && this.#zenMode) this.#navigation.leave();
    });
    this.#document.addEventListener('visibilitychange', () => {
      if (this.#document.hidden) this.#suspend();
    });
    this.#window.addEventListener('pagehide', () => this.#suspend());

    this.#window.addEventListener('storage', (event) => {
      if (PresetStore.affectsPresets(event.key)) {
        this.#presetsChanged = true;
        this.#refreshPresets();
      }
      if (PresetStore.affectsPreferences(event.key)) {
        this.#preferences = this.#store.loadPreferences();
        this.#syncPreferences();
      }
    });
  }

  /** Leaving pauses a running exercise and retries any pending local changes. */
  #suspend() {
    if (this.#status === 'running') this.#session.pause();
    this.#editor.flush();
    this.#refreshPresets();
  }

  /** Pending failed writes protect local edits until storage recovers. */
  #refreshPresets({ keepPicker = false } = {}) {
    if (!this.#presetsChanged || this.#status !== 'idle' || !this.#editor.refresh()) return false;
    this.#presetsChanged = false;
    if (!keepPicker) this.#durationPicker.close();
    this.#syncSettings();
    this.#render(this.#session.snapshot);
    return true;
  }

  #setField(field, value) {
    if (this.#status !== 'idle') return;
    this.#editor.setConfig({ ...this.#config, [field]: value });
    if (!this.#refreshPresets({ keepPicker: true })) {
      this.#syncSettings();
      this.#render(this.#session.snapshot);
    }
  }

  #selectPreset(id) {
    if (this.#status !== 'idle') return;
    this.#durationPicker.close();
    this.#editor.select(id);
    if (!this.#refreshPresets()) {
      this.#syncSettings();
      this.#render(this.#session.snapshot);
    }
    this.#elements['phase-announcement'].textContent = `${this.#editor.selected.name} selected.`;
  }

  #syncSettings() {
    const ui = this.#elements;
    this.#durationPicker.render(this.#config, this.#editor.selected.id);
    this.#preview.configure(this.#config, this.#preferences);
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

  #syncPresetControls() {
    const presets = this.#presets;
    this.#presetTiles.render(presets, this.#editor.selected.id);
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
    this.#syncTimingVisibility();
    this.#elements['sound-cue'].disabled = !this.#cues.soundSupported;
    this.#elements['sound-cue'].parentElement.title = this.#cues.soundSupported ? '' : 'unavailable in this browser';
    const { holdFeedback } = this.#preferences;
    this.#elements['breathing-visual'].dataset.holdFeedback = holdFeedback;
    this.#elements['hold-choices'].querySelector(`input[value="${holdFeedback}"]`).checked = true;
    this.#preview.configure(this.#config, this.#preferences);
  }

  #syncTimingVisibility() {
    this.#elements['phase-track'].setAttribute('aria-hidden',
      String(this.#status !== 'idle' && !this.#preferences.showPhaseTimings));
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
    this.#editor.flush();
    this.#refreshPresets();
  }

  #toggleSession() {
    this.#durationPicker.close();
    const status = this.#status;
    if (status === 'running') {
      this.#navigation.leave();
      return;
    }
    if (status === 'idle') {
      this.#editor.flush();
      this.#refreshPresets();
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
    this.#syncTimingVisibility();
    this.#preview.setEnabled(snapshot.status === 'idle');
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
      isIdle: () => this.#status === 'idle' && !this.#editor.hasPendingChanges,
    });
    this.#offlineSupport.start();
  }
}
