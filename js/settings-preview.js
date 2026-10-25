import { DEFAULT_CONFIG, validateConfig } from './breathing-engine.js';
import { DEFAULT_PREFERENCES } from './preset-store.js';
import { formatDuration, phaseLabel } from './phase-labels.js';

/** CSS setting demos on the persistent breathing stage; sound requires an explicit gesture. */
export class SettingsPreview {
  #document;
  #window;
  #container;
  #visual;
  #heading;
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
  #pulse = null;
  #flashes = new Set();
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
    this.#heading = container.querySelector('#preview-heading');
    this.#track = container.querySelector('.phase-track');
    this.#caption = container.querySelector('.phase-caption');
    this.#count = container.querySelector('.phase-count');
    this.#soundButton = container.querySelector('#preview-sound-button');
    if ([this.#visual, this.#heading, this.#track, this.#caption, this.#count, this.#soundButton].some(node => !node)) {
      throw new Error('The settings preview is missing its breathing controls.');
    }
    this.#listen(this.#soundButton, 'click', () => { if (this.#canToggleSound()) this.#onToggleSound(); });
    this.#listen(document, 'visibilitychange', () => {
      if (document.hidden) {
        this.#stopSound();
        this.#stopPulse();
        this.#stopFlashes();
      }
      this.#syncSoundButton();
    });
    this.#listen(window, 'pagehide', () => {
      this.#pageHidden = true;
      this.#stopSound();
      this.#stopPulse();
      this.#stopFlashes();
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
    if (!enabled) {
      this.#stopSound();
      this.#stopPulse();
      this.#stopFlashes();
    }
    this.#syncSoundButton();
  }

  /** Acknowledge a timings switch change without changing the breathing visual. */
  pulse() {
    if (this.#disposed || !this.#enabled || this.#pageHidden || this.#document.hidden
      || typeof this.#heading.animate !== 'function') return false;
    this.#stopPulse();
    const reducedMotion = this.#window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const frames = reducedMotion
      ? [{ opacity: 1 }, { opacity: 0.45 }, { opacity: 1 }]
      : [{ transform: 'scale(1)', opacity: 1 }, { transform: 'scale(0.94)', opacity: 0.45 },
        { transform: 'scale(1)', opacity: 1 }];
    const pulse = this.#pulse = this.#heading.animate(frames, { duration: 600, easing: 'ease-in-out' });
    pulse.onfinish = () => { if (this.#pulse === pulse) this.#pulse = null; };
    return true;
  }

  #stopPulse() {
    if (!this.#pulse) return;
    this.#pulse.onfinish = null;
    this.#pulse.cancel();
    this.#pulse = null;
  }

  /** Briefly highlight the actual preview feature changed by the user. */
  flash(preference, enabled = true) {
    if (!this.#enabled || this.#disposed || this.#document.hidden || this.#pageHidden) return false;
    if (preference === 'showPhaseTimings') this.pulse();
    const frame = this.#container.querySelector('#preview-frame');
    const nodes = preference === 'showPhaseTimings' || !enabled ? [frame ?? this.#heading]
      : preference === 'showBreathText' ? [this.#caption]
        : preference === 'showBreathNumbers' ? [this.#count]
          : preference === 'showBreathGuides' ? [...this.#container.querySelectorAll('.breath-guide')]
            : preference === 'holdFeedback' ? [this.#container.querySelector('.hold-feedback')]
              : preference === 'soundCue' ? [this.#soundButton] : [];
    let played = false;
    for (const node of nodes) {
      if (typeof node?.animate !== 'function') continue;
      const outline = node === frame || node === this.#heading;
      const animation = node.animate(outline
        ? [{ borderColor: '#333', boxShadow: '0 0 0 0 transparent' },
          { borderColor: '#eee', boxShadow: '0 0 0 1px #aaa' },
          { borderColor: '#333', boxShadow: '0 0 0 0 transparent' }]
        : preference === 'holdFeedback'
          ? [{ opacity: .12, filter: 'brightness(1)' }, { opacity: .6, filter: 'brightness(1.9)' }, { opacity: .12, filter: 'brightness(1)' }]
          : [{ filter: 'brightness(1)' }, { filter: 'brightness(1.9)' }, { filter: 'brightness(1)' }],
      { duration: 650, easing: 'ease-in-out' });
      this.#flashes.add(animation);
      animation.onfinish = () => this.#flashes.delete(animation);
      played = true;
    }
    return played;
  }

  #stopFlashes() {
    for (const animation of this.#flashes) {
      animation.onfinish = null;
      animation.cancel();
    }
    this.#flashes.clear();
  }

  dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#stopSound();
    this.#stopPulse();
    this.#stopFlashes();
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
