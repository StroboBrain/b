import { DEFAULT_CONFIG, validateConfig } from './breathing-engine.js';
import { DEFAULT_PREFERENCES } from './preset-store.js';
import { formatDuration, phaseLabel } from './phase-labels.js';

/** A fixed inhale sample with CSS setting demos and sound only from an explicit gesture. */
export class SettingsPreview {
  #document;
  #window;
  #container;
  #visual;
  #track;
  #caption;
  #count;
  #soundButton;
  #preferences = { ...DEFAULT_PREFERENCES };
  #enabled = true;
  #pageHidden = false;
  #disposed = false;
  #audio = null;
  #listeners = [];

  constructor({ document, window, container } = {}) {
    if (!container?.querySelector || !document?.addEventListener
      || typeof document.hidden !== 'boolean' || !window?.addEventListener) {
      throw new TypeError('SettingsPreview requires a document, window and preview container.');
    }
    if (window.AudioContext != null && typeof window.AudioContext !== 'function') {
      throw new TypeError('AudioContext must be a constructor when supported.');
    }
    this.#document = document;
    this.#window = window;
    this.#container = container;
    this.#visual = container.querySelector('.breathing-visual');
    this.#track = container.querySelector('.phase-track');
    this.#caption = container.querySelector('.phase-caption');
    this.#count = container.querySelector('.phase-count');
    this.#soundButton = container.querySelector('#preview-sound-button');
    if ([this.#visual, this.#track, this.#caption, this.#count, this.#soundButton].some(node => !node)) {
      throw new Error('The settings preview is missing its breathing controls.');
    }
    this.#soundButton.setAttribute('aria-label', 'preview sound cue');
    this.#listen(this.#soundButton, 'click', () => this.sampleSound());
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
    this.configure(DEFAULT_CONFIG, this.#preferences);
  }

  configure(config, preferences) {
    const next = validateConfig(config);
    if (!preferences || typeof preferences !== 'object' || typeof preferences.soundCue !== 'boolean') {
      throw new TypeError('Provide display preferences with a soundCue boolean.');
    }
    if (this.#disposed) return;
    this.#preferences = { ...preferences };
    const data = this.#container.dataset;
    data.showText = String(preferences.showBreathText);
    data.showTime = String(preferences.showBreathNumbers);
    data.showTimings = String(preferences.showPhaseTimings);
    data.fadeButtons = String(preferences.fadeButtons);
    data.soundCue = String(preferences.soundCue);
    this.#visual.dataset.state = 'idle';
    this.#visual.dataset.phase = 'inhale';
    this.#visual.dataset.holdFeedback = preferences.holdFeedback;
    this.#caption.textContent = phaseLabel('inhale');
    this.#count.textContent = String(next.inhale);
    for (const guide of this.#container.querySelectorAll('.breath-guide')) guide.hidden = !preferences.showBreathGuides;
    for (const step of this.#track.children) {
      step.querySelector('.phase-time').textContent = formatDuration(next[step.dataset.phase]);
      step.classList.toggle('is-skipped', next[step.dataset.phase] === 0);
      step.removeAttribute('aria-current');
    }
    if (!preferences.soundCue) this.#stopSound();
    this.#syncSoundButton();
  }

  setEnabled(enabled) {
    if (typeof enabled !== 'boolean') throw new TypeError('Preview availability must be a boolean.');
    if (this.#disposed) return;
    this.#enabled = enabled;
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

  #canSample() {
    return !this.#disposed && this.#enabled && !this.#pageHidden && !this.#document.hidden
      && this.#preferences.soundCue && typeof this.#window.AudioContext === 'function';
  }

  #syncSoundButton() {
    this.#soundButton.disabled = !this.#canSample() || this.#audio !== null;
    this.#container.dataset.soundPlaying = String(Boolean(this.#audio?.oscillator));
  }

  /** Play one cue when sound is enabled or the preview speaker is pressed. */
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
