import { BreathingEngine, DEFAULT_CONFIG, PHASES, configsEqual, validateConfig } from './breathing-engine.js';
import { SessionDriver } from './session-driver.js';
import { DEFAULT_PREFERENCES } from './preset-store.js';
import { formatDuration, phaseLabel } from './phase-labels.js';
import { setPhaseCaption } from './phase-caption.js';

const FLASH_DURATION_MS = 1500;
// First pulse: 550ms. Rest: 150ms. Second, slower pulse: 800ms.
const FLASH_OFFSETS = [0, 275 / 1500, 550 / 1500, 700 / 1500, 1100 / 1500, 1];

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
  #framePulse = null;
  #listeners = [];
  #driver;
  #visualKey = '';
  #cycleTimer = null;
  #observer;
  #practice;

  constructor({ document, window, container, onToggleSound = () => {},
    now = () => (window.performance ?? globalThis.performance).now() } = {}) {
    if (!container?.querySelector || !document?.addEventListener
      || typeof document.hidden !== 'boolean' || !window?.addEventListener || typeof onToggleSound !== 'function'
      || typeof window.setTimeout !== 'function' || typeof window.clearTimeout !== 'function') {
      throw new TypeError('SettingsPreview requires a document, window, preview container and sound toggle callback.');
    }
    if (window.AudioContext != null && typeof window.AudioContext !== 'function') {
      throw new TypeError('AudioContext must be a constructor when supported.');
    }
    this.#document = document;
    this.#window = window;
    this.#container = container;
    this.#practice = container.closest?.('#practice');
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
    this.#driver = new SessionDriver({ engine: new BreathingEngine({ now }),
      setTimeout: window.setTimeout.bind(window), clearTimeout: window.clearTimeout.bind(window),
      onChange: snapshot => {
        if (!this.#enabled) return;
        const cycleDuration = PHASES.reduce((total, phase) => total + this.#config[phase], 0) * 1000;
        if (snapshot.status === 'running' && snapshot.sessionElapsedMs >= cycleDuration) this.#beginCycle();
        else this.#renderPreview(snapshot);
      } });
    if (this.#practice && typeof window.MutationObserver === 'function') {
      this.#observer = new window.MutationObserver(() => this.#resumePreview());
      this.#observer.observe(this.#practice, { attributes: true, attributeFilter: ['data-panel-motion'] });
    }
    this.#listen(this.#soundButton, 'click', () => { if (this.#canToggleSound()) this.#onToggleSound(); });
    this.#listen(this.#track, 'click', event => {
      const button = event.target.closest?.('.duration-button');
      if (button?.closest('.phase-track') === this.#track && PHASES.includes(button.dataset.field)
        && !button.matches(':disabled')) this.pulse();
    });
    this.#listen(document, 'visibilitychange', () => {
      if (document.hidden) {
        this.#stopSound();
        this.#stopPulse();
        this.#pausePreview();
      }
      else this.#resumePreview();
      this.#syncSoundButton();
    });
    this.#listen(window, 'pagehide', () => {
      this.#pageHidden = true;
      this.#stopSound();
      this.#stopPulse();
      this.#pausePreview();
    });
    this.#listen(window, 'pageshow', () => {
      this.#pageHidden = false;
      this.#resumePreview();
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
    const changed = !configsEqual(next, this.#config);
    this.#config = next;
    this.#preferences = { ...preferences };
    const data = this.#container.dataset;
    data.showText = String(preferences.showBreathText);
    data.showTime = String(preferences.showBreathNumbers);
    data.showTimings = String(preferences.showPhaseTimings);
    data.fadeButtons = 'true';
    data.soundCue = String(preferences.soundCue);
    if (this.#enabled) {
      if (changed) {
        this.#clearCycleTimer();
        this.#driver.stop();
        this.#resumePreview();
      }
      else this.#renderPreview(this.#driver.snapshot);
    }
    if (!preferences.soundCue) this.#stopSound();
    this.#syncSoundButton();
  }

  #renderPreview(snapshot) {
    const { holdFeedback, showBreathGuides } = this.#preferences;
    this.#visual.dataset.holdFeedback = holdFeedback;
    const phase = snapshot.phase ?? 'inhale';
    const key = `${snapshot.status}:${snapshot.phaseStartedAtMs}:${phase}`;
    if (key !== this.#visualKey) {
      this.#visualKey = key;
      this.#visual.dataset.state = snapshot.status;
      this.#visual.dataset.phase = phase;
      for (const node of [this.#visual, this.#container]) {
        node.style.setProperty('--phase-duration', `${snapshot.phaseDurationMs}ms`);
        node.style.setProperty('--phase-delay', `${-snapshot.phaseElapsedMs}ms`);
      }
      const orb = this.#visual.querySelector('.breathing-orb');
      const fill = this.#visual.querySelector('.hold-fill');
      for (const node of [orb, fill, fill.parentElement]) node.style.animationName = 'none';
      this.#track.style.setProperty('--timing-animation-name', 'none');
      void this.#visual.offsetWidth;
      for (const node of [orb, fill, fill.parentElement]) node.style.animationName = '';
      this.#track.style.setProperty('--timing-animation-name', 'hold-fill');
      setPhaseCaption(this.#caption, phaseLabel(phase), Math.min(420, snapshot.phaseDurationMs * .6 || 420));
    }
    this.#count.textContent = snapshot.status === 'idle' ? String(this.#config.inhale)
      : String(Math.min(snapshot.phaseDurationMs / 1000, Math.ceil(snapshot.phaseRemainingMs / 1000)));
    for (const guide of this.#container.querySelectorAll('.breath-guide')) guide.hidden = !showBreathGuides;
    for (const step of this.#track.children) {
      step.querySelector('.phase-time').textContent = formatDuration(this.#config[step.dataset.phase]);
      step.classList.toggle('is-skipped', this.#config[step.dataset.phase] === 0);
      if (snapshot.status !== 'idle' && step.dataset.phase === phase) step.setAttribute('aria-current', 'step');
      else step.removeAttribute('aria-current');
    }
  }

  setEnabled(enabled) {
    if (typeof enabled !== 'boolean') throw new TypeError('Preview availability must be a boolean.');
    if (this.#disposed) return;
    this.#container.dataset.preview = String(enabled);
    if (this.#enabled === enabled) return;
    this.#enabled = enabled;
    if (enabled) this.#resumePreview();
    if (!enabled) {
      this.#clearCycleTimer();
      this.#stopSound();
      this.#stopPulse();
      this.#driver.stop();
      this.#visualKey = '';
      delete this.#container.dataset.previewStep;
      delete this.#container.dataset.previewPaused;
    }
    this.#syncSoundButton();
  }

  #resumePreview() {
    if (!this.#enabled || this.#disposed || this.#pageHidden || this.#document.hidden || this.#practice?.dataset.panelMotion) return;
    delete this.#container.dataset.previewPaused;
    if (this.#driver.snapshot.status === 'paused') this.#driver.resume();
    else if (this.#driver.snapshot.status === 'idle' && this.#cycleTimer === null) this.#beginCycle();
  }

  #clearCycleTimer() {
    if (this.#cycleTimer !== null) this.#window.clearTimeout(this.#cycleTimer);
    this.#cycleTimer = null;
  }

  #pausePreview() {
    this.#clearCycleTimer();
    if (!this.#enabled) return;
    this.#container.dataset.previewPaused = 'true';
    if (this.#driver.snapshot.status === 'running') this.#driver.pause();
  }

  #beginCycle() {
    this.#clearCycleTimer();
    this.#container.dataset.previewStep = 'ready';
    this.#driver.stop();
    if (!this.#enabled || this.#pageHidden || this.#document.hidden || this.#practice?.dataset.panelMotion) return;
    this.#cycleTimer = this.#window.setTimeout(() => {
      this.#cycleTimer = null;
      if (!this.#enabled || this.#pageHidden || this.#document.hidden) return;
      this.#container.dataset.previewStep = 'starting';
      this.#cycleTimer = this.#window.setTimeout(() => {
        this.#cycleTimer = null;
        if (!this.#enabled || this.#pageHidden || this.#document.hidden) return;
        this.#container.dataset.previewStep = 'breathing';
        this.#driver.start(this.#config);
      }, 500);
    }, 500);
  }

  /** Two complete pulses per timing-card press; subsequent presses wait for completion. */
  pulse() {
    if (this.#disposed || !this.#enabled || this.#pageHidden || this.#document.hidden
      || this.#pulse || this.#framePulse || typeof this.#heading.animate !== 'function') return false;
    const reducedMotion = this.#window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const rest = reducedMotion ? { opacity: 1 } : { transform: 'scale(1)', opacity: 1 };
    const peak = reducedMotion ? { opacity: .45 } : { transform: 'scale(.94)', opacity: .45 };
    const frames = [rest, peak, rest, rest, peak, rest]
      .map((frame, index) => ({ ...frame, offset: FLASH_OFFSETS[index], easing: 'ease-in-out' }));
    const pulse = this.#pulse = this.#heading.animate(frames, { duration: FLASH_DURATION_MS, easing: 'linear' });
    pulse.onfinish = () => { if (this.#pulse === pulse) this.#pulse = null; };
    const frame = this.#container.querySelector('#preview-frame');
    if (typeof frame?.animate === 'function') {
      const normal = { borderColor: '#333', boxShadow: '0 0 0 0 transparent' };
      const bright = { borderColor: '#eee', boxShadow: '0 0 0 1px #aaa' };
      const outline = this.#framePulse = frame.animate([normal, bright, normal, normal, bright, normal]
        .map((keyframe, index) => ({ ...keyframe, offset: FLASH_OFFSETS[index], easing: 'ease-in-out' })),
      { duration: FLASH_DURATION_MS, easing: 'linear' });
      outline.onfinish = () => { if (this.#framePulse === outline) this.#framePulse = null; };
    }
    return true;
  }

  #stopPulse() {
    for (const animation of [this.#pulse, this.#framePulse]) {
      if (!animation) continue;
      animation.onfinish = null;
      animation.cancel();
    }
    this.#pulse = null;
    this.#framePulse = null;
  }

  dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#enabled = false;
    this.#clearCycleTimer();
    this.#observer?.disconnect();
    this.#driver.stop();
    this.#stopSound();
    this.#stopPulse();
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
