import { DEFAULT_CONFIG, validateConfig } from './breathing-engine.js';
import { DEFAULT_PREFERENCES } from './preset-store.js';
import { formatDuration, phaseLabel } from './phase-labels.js';

/** CSS setting demos on the persistent breathing stage; sound requires an explicit gesture. */
export class SettingsPreview {
  #document;
  #window;
  #container;
  #visual;
  #track;
  #caption;
  #count;
  #soundButton;
  #onToggleSound;
  #preferences = { ...DEFAULT_PREFERENCES };
  #enabled = false;
  #config = { ...DEFAULT_CONFIG };
  #pageHidden = false;
  #disposed = false;
  #audio = null;
  #listeners = [];

  constructor({ document, window, container, onToggleSound = () => {} } = {}) {
    if (!container?.querySelector || !document?.addEventListener
      || typeof document.hidden !== 'boolean' || !window?.addEventListener || typeof onToggleSound !== 'function') {
      throw new TypeError('SettingsPreview requires a document, window, preview container and sound toggle callback.');
    }
    if (window.AudioContext != null && typeof window.AudioContext !== 'function') {
      throw new TypeError('AudioContext must be a constructor when supported.');
    }
    this.#document = document;
    this.#window = window;
    this.#container = container;
    this.#onToggleSound = onToggleSound;
    this.#visual = container.querySelector('.breathing-visual');
    this.#track = container.querySelector('.phase-track');
    this.#caption = container.querySelector('.phase-caption');
    this.#count = container.querySelector('.phase-count');
    this.#soundButton = container.querySelector('#preview-sound-button');
    if ([this.#visual, this.#track, this.#caption, this.#count, this.#soundButton].some(node => !node)) {
      throw new Error('The settings preview is missing its breathing controls.');
    }
    this.#listen(this.#soundButton, 'click', () => { if (this.#canToggleSound()) this.#onToggleSound(); });
    this.#listen(document, 'visibilitychange', () => {
      if (document.hidden) this.#stopSound();
      this.#syncSoundButton();
    });
    this.#listen(window, 'pagehide', () => {
      this.#pageHidden = true;
      this.#stopSound();
    });
    this.#listen(window, 'pageshow', () => {
      this.#pageHidden = false;
      this.#syncSoundButton();
    });
    this.#container.dataset.preview = 'false';
    this.configure(DEFAULT_CONFIG, this.#preferences);
  }

  configure(config, preferences) {
    const next = validateConfig(config);
    if (!preferences || typeof preferences !== 'object' || typeof preferences.soundCue !== 'boolean') {
      throw new TypeError('Provide display preferences with a soundCue boolean.');
    }
    if (this.#disposed) return;
    this.#config = next;
    this.#preferences = { ...preferences };
    const data = this.#container.dataset;
    data.showText = String(preferences.showBreathText);
    data.showTime = String(preferences.showBreathNumbers);
    data.showTimings = String(preferences.showPhaseTimings);
    data.fadeButtons = 'true';
    data.soundCue = String(preferences.soundCue);
    if (this.#enabled) this.#renderPreview();
    if (!preferences.soundCue) this.#stopSound();
    this.#syncSoundButton();
  }

  #renderPreview() {
    const { holdFeedback, showBreathGuides } = this.#preferences;
    this.#visual.dataset.holdFeedback = holdFeedback;
    this.#caption.textContent = phaseLabel('inhale');
    this.#count.textContent = String(this.#config.inhale);
    for (const guide of this.#container.querySelectorAll('.breath-guide')) guide.hidden = !showBreathGuides;
    for (const step of this.#track.children) {
      step.querySelector('.phase-time').textContent = formatDuration(this.#config[step.dataset.phase]);
      step.classList.toggle('is-skipped', this.#config[step.dataset.phase] === 0);
      step.removeAttribute('aria-current');
    }
  }

  setEnabled(enabled) {
    if (typeof enabled !== 'boolean') throw new TypeError('Preview availability must be a boolean.');
    if (this.#disposed) return;
    this.#container.dataset.preview = String(enabled);
    if (this.#enabled === enabled) return;
    this.#enabled = enabled;
    if (enabled) this.#renderPreview();
    if (!enabled) this.#stopSound();
    this.#syncSoundButton();
  }

  dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#stopSound();
    for (const remove of this.#listeners) remove();
    this.#listeners = [];
  }

  #listen(target, type, callback) {
    target.addEventListener(type, callback);
    this.#listeners.push(() => target.removeEventListener(type, callback));
  }

  #canToggleSound() {
    return !this.#disposed && this.#enabled && !this.#pageHidden && !this.#document.hidden
      && typeof this.#window.AudioContext === 'function';
  }

  #canSample() {
    return this.#canToggleSound() && this.#preferences.soundCue;
  }

  #syncSoundButton() {
    this.#soundButton.disabled = !this.#canToggleSound();
    const label = this.#preferences.soundCue ? 'mute sound' : 'unmute sound';
    this.#soundButton.setAttribute('aria-label', label);
    this.#soundButton.setAttribute('aria-pressed', String(this.#preferences.soundCue));
    this.#soundButton.title = label;
    this.#container.dataset.soundPlaying = String(Boolean(this.#audio?.oscillator));
  }

  /** Play one sample only when the caller explicitly requests it while unmuted. */
  sampleSound() {
    if (!this.#canSample() || this.#audio) return;
    try {
      const audio = { context: new this.#window.AudioContext(), oscillator: null, gain: null };
      this.#audio = audio;
      this.#syncSoundButton();
      if (audio.context.state === 'running') this.#playSound(audio);
      else Promise.resolve(audio.context.resume()).then(() => this.#playSound(audio)).catch(() => {
        if (this.#audio === audio) this.#stopSound();
      });
    } catch {
      this.#stopSound();
    }
  }

  #playSound(audio) {
    if (this.#audio !== audio || !this.#canSample()) return;
    try {
      const { context } = audio;
      const oscillator = audio.oscillator = context.createOscillator();
      const gain = audio.gain = context.createGain();
      const start = context.currentTime;
      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(440, start);
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(0.035, start + 0.015);
      gain.gain.linearRampToValueAtTime(0, start + 0.18);
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.onended = () => { if (this.#audio === audio) this.#stopSound(); };
      oscillator.start(start);
      oscillator.stop(start + 0.18);
      this.#syncSoundButton();
    } catch {
      this.#stopSound();
    }
  }

  #stopSound() {
    const audio = this.#audio;
    this.#audio = null;
    if (audio) {
      if (audio.oscillator) {
        audio.oscillator.onended = null;
        try { audio.oscillator.stop(); } catch {}
        try { audio.oscillator.disconnect(); } catch {}
      }
      try { audio.gain?.disconnect(); } catch {}
      try { Promise.resolve(audio.context.close()).catch(() => {}); } catch {}
    }
    this.#syncSoundButton();
  }
}
