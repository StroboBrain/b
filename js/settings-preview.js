import { BreathingEngine, DEFAULT_CONFIG, PHASES, configsEqual, validateConfig } from './breathing-engine.js';
import { SessionDriver } from './session-driver.js';
import { DEFAULT_PREFERENCES } from './preset-store.js';
import { formatDuration, phaseLabel } from './phase-labels.js';
import { setPhaseCaption } from './phase-caption.js';
import { applyPhaseMotion } from './phase-motion.js';
import { readCssMilliseconds } from './css-time.js';

const FLASH_DURATION_MS = 1500;
const PLAY_EXIT_MS = 800;
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
  #playButton;
  #onToggleSound;
  #preferences = { ...DEFAULT_PREFERENCES };
  #enabled = false;
  #config = { ...DEFAULT_CONFIG };
  #pageHidden = false;
  #disposed = false;
  #audio = null;
  #pulse = null;
  #framePulse = null;
  #pendingPulse = null;
  #listeners = [];
  #driver;
  #visualKey = '';
  #cycleTimer = null;
  #observer;
  #practice;
  #animationDemo = null;
  #timingDemo = null;
  #controlsExitTimer = null;

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
    this.#playButton = container.querySelector('#session-button');
    if ([this.#visual, this.#heading, this.#track, this.#caption, this.#count, this.#soundButton].some(node => !node)) {
      throw new Error('The settings preview is missing its breathing controls.');
    }
    this.#driver = new SessionDriver({ engine: new BreathingEngine({ now }),
      setTimeout: window.setTimeout.bind(window), clearTimeout: window.clearTimeout.bind(window),
      onChange: snapshot => {
        if (!this.#enabled) return;
        const cycleDuration = PHASES.reduce((total, phase) => total + Math.round(this.#config[phase] * 1000), 0);
        const demoPhase = this.#timingDemo ?? (this.#animationDemo ? 'inhale' : null);
        const duration = demoPhase ? Math.round(this.#config[demoPhase] * 1000) : cycleDuration;
        if (snapshot.status === 'running' && snapshot.sessionElapsedMs >= duration) this.#showReady();
        else this.#renderPreview(snapshot);
        this.#syncPlayButton();
      } });
    if (this.#practice && typeof window.MutationObserver === 'function') {
      this.#observer = new window.MutationObserver(() => this.#syncAvailability());
      this.#observer.observe(this.#practice, { attributes: true, attributeFilter: ['data-panel-motion'] });
    }
    this.#listen(this.#soundButton, 'click', () => { if (this.#canToggleSound()) this.#onToggleSound(); });
    this.#listen(this.#track, 'click', event => {
      const button = event.target.closest?.('.duration-button');
      if (button?.closest('.phase-track') === this.#track && PHASES.includes(button.dataset.field)
        && !button.matches(':disabled')) this.previewTiming(button.dataset.field);
    });
    this.#listen(document, 'visibilitychange', () => {
      if (document.hidden) {
        this.#stopSound();
        this.#stopPulse();
        this.#cancelPreview();
      }
      else this.#syncAvailability();
      this.#syncSoundButton();
    });
    this.#listen(window, 'pagehide', () => {
      this.#pageHidden = true;
      this.#stopSound();
      this.#stopPulse();
      this.#cancelPreview();
    });
    this.#listen(window, 'pageshow', () => {
      this.#pageHidden = false;
      this.#syncAvailability();
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
    data.showGuides = String(preferences.showBreathGuides);
    data.showTimings = String(preferences.showPhaseTimings);
    data.soundCue = String(preferences.soundCue);
    for (const guide of this.#container.querySelectorAll('.breath-guide')) guide.removeAttribute('hidden');
    if (this.#enabled) {
      if (changed) {
        this.#showReady();
      }
      else this.#renderPreview(this.#driver.snapshot);
      this.#syncPlayButton();
    }
    if (!preferences.soundCue) this.#stopSound();
    this.#syncSoundButton();
  }

  #renderPreview(snapshot) {
    // The engine's first inhale supplies the clock for an isolated timing demo.
    if (this.#timingDemo && snapshot.status !== 'idle') snapshot = { ...snapshot, phase: this.#timingDemo };
    const { holdFeedback } = this.#preferences;
    this.#visual.dataset.holdFeedback = holdFeedback;
    const phase = snapshot.phase ?? 'inhale';
    const key = `${snapshot.status}:${snapshot.phaseStartedAtMs}:${phase}`;
    if (key !== this.#visualKey) {
      this.#visualKey = key;
      applyPhaseMotion({ visual: this.#visual, stage: this.#container, track: this.#track,
        orb: this.#visual.querySelector('.breathing-orb'), fill: this.#visual.querySelector('.hold-fill') }, snapshot);
      setPhaseCaption(this.#caption, phaseLabel(phase), Math.min(420, snapshot.phaseDurationMs * .6 || 420));
    }
    this.#count.textContent = snapshot.status === 'idle' ? String(this.#config.inhale)
      : String(Math.min(snapshot.phaseDurationMs / 1000, Math.ceil(snapshot.phaseRemainingMs / 1000)));
    for (const step of this.#track.children) {
      step.querySelector('.phase-time').textContent = formatDuration(this.#config[step.dataset.phase]);
      step.classList.toggle('is-skipped', this.#config[step.dataset.phase] === 0);
      if (snapshot.status !== 'idle' && this.#container.dataset.previewStep !== 'animation'
        && step.dataset.phase === phase) step.setAttribute('aria-current', 'step');
      else step.removeAttribute('aria-current');
    }
  }

  setEnabled(enabled) {
    if (typeof enabled !== 'boolean') throw new TypeError('Preview availability must be a boolean.');
    if (this.#disposed) return;
    this.#container.dataset.preview = String(enabled);
    if (this.#enabled === enabled) return;
    this.#enabled = enabled;
    this.#showControls(enabled);
    if (enabled) { this.#showReady(); this.#syncPlayButton(); }
    if (!enabled) {
      this.#clearCycleTimer();
      this.#animationDemo = null;
      this.#timingDemo = null;
      this.#stopSound();
      this.#stopPulse();
      this.#driver.stop();
      this.#visualKey = '';
      delete this.#container.dataset.previewStep;
      delete this.#container.dataset.previewPaused;
      if (this.#playButton) {
        this.#playButton.inert = false;
        this.#playButton.removeAttribute('aria-hidden');
      }
      this.#syncPlayButton();
    }
    this.#syncSoundButton();
  }

  #showControls(visible) {
    if (this.#controlsExitTimer !== null) this.#window.clearTimeout(this.#controlsExitTimer);
    this.#controlsExitTimer = null;
    const frame = this.#container.querySelector('#preview-frame');
    const controls = [frame, this.#heading, this.#soundButton].filter(Boolean);
    if (visible) {
      delete this.#container.dataset.previewLeaving;
      for (const control of controls) { control.hidden = false; control.inert = false; }
      return;
    }
    const hide = () => {
      this.#controlsExitTimer = null;
      for (const control of controls) control.hidden = true;
      delete this.#container.dataset.previewLeaving;
    };
    for (const control of controls) control.inert = true;
    if (this.#document.hidden || this.#pageHidden
      || this.#window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) { hide(); return; }
    for (const control of [frame, this.#soundButton].filter(Boolean)) {
      const style = this.#window.getComputedStyle?.(control);
      control.style.setProperty('--preview-exit-transform', style?.transform ?? 'none');
      control.style.setProperty('--preview-exit-opacity', style?.opacity ?? '1');
    }
    this.#container.dataset.previewLeaving = 'true';
    const style = this.#window.getComputedStyle?.(this.#container);
    const legacyDuration = readCssMilliseconds(style, '--preview-motion-duration', 1000);
    const duration = Math.max(readCssMilliseconds(style, '--preview-exit-duration', legacyDuration),
      readCssMilliseconds(style, '--speaker-exit-duration', legacyDuration));
    this.#controlsExitTimer = this.#window.setTimeout(hide, duration);
  }

  #syncAvailability() {
    if (!this.#available()) return;
    delete this.#container.dataset.previewPaused;
    this.#syncPlayButton();
  }

  #available() {
    return this.#enabled && !this.#disposed && !this.#pageHidden && !this.#document.hidden
      && !this.#practice?.dataset.panelMotion;
  }

  #syncPlayButton() {
    if (this.#enabled && this.#playButton) {
      this.#playButton.disabled = true;
      this.#playButton.inert = true;
      this.#playButton.setAttribute('aria-hidden', 'true');
    }
    const timings = this.#container.querySelector('#timing-fields');
    if (timings) {
      const hidden = this.#enabled && !this.#preferences.showPhaseTimings;
      timings.inert = hidden;
      if (hidden) timings.setAttribute('aria-hidden', 'true');
      else timings.removeAttribute('aria-hidden');
    }
  }

  #clearCycleTimer() {
    if (this.#cycleTimer !== null) this.#window.clearTimeout(this.#cycleTimer);
    this.#cycleTimer = null;
  }

  #cancelPreview() {
    this.#clearCycleTimer();
    if (!this.#enabled) return;
    this.#showReady();
    this.#container.dataset.previewPaused = 'true';
    this.#syncPlayButton();
  }

  #showReady() {
    this.#clearCycleTimer();
    this.#animationDemo = null;
    this.#timingDemo = null;
    this.#container.dataset.previewStep = 'ready';
    this.#driver.stop();
    this.#syncPlayButton();
  }

  /** Explicitly demonstrate one selected cycle without starting a real session. */
  play() {
    if (!this.#available() || !['ready', 'animation'].includes(this.#container.dataset.previewStep)) return false;
    this.#clearCycleTimer();
    this.#animationDemo = null;
    this.#timingDemo = null;
    this.#stopPulse();
    this.#container.dataset.previewStep = 'starting';
    this.#driver.stop();
    this.#syncPlayButton();
    this.#cycleTimer = this.#window.setTimeout(() => {
      this.#cycleTimer = null;
      if (!this.#available()) { this.#showReady(); return; }
      this.#container.dataset.previewStep = 'breathing';
      this.#driver.start(this.#config);
    }, readCssMilliseconds(this.#window.getComputedStyle?.(this.#container), '--start-fold-duration', PLAY_EXIT_MS));
    return true;
  }

  /** Demonstrate the selected timing once; zero holds acknowledge without running. */
  previewTiming(phase) {
    if (!PHASES.includes(phase)) throw new RangeError('Preview timing must name a breathing phase.');
    const acknowledged = this.pulse();
    if (!this.#available()) return acknowledged;
    if (this.#config[phase] === 0) return true;
    this.#clearCycleTimer();
    this.#animationDemo = null;
    this.#timingDemo = phase;
    this.#container.dataset.previewStep = 'breathing';
    this.#visualKey = '';
    this.#driver.start({ ...this.#config, inhale: this.#config[phase] });
    this.#syncPlayButton();
    return true;
  }

  /** Replay the selected Animation without starting the breathing rhythm. */
  previewAnimation() {
    if (!this.#available() || !['ready', 'animation'].includes(this.#container.dataset.previewStep)) return false;
    this.#demoAnimation();
    return true;
  }

  #demoAnimation() {
    this.#clearCycleTimer();
    this.#stopPulse();
    this.#animationDemo = true;
    this.#timingDemo = null;
    this.#container.dataset.previewStep = 'animation';
    this.#visualKey = '';
    this.#driver.start(this.#config);
    this.#syncPlayButton();
  }

  /** Two complete pulses per timing-card press; subsequent presses wait for completion. */
  pulse() {
    if (this.#disposed || !this.#enabled || this.#pageHidden || this.#document.hidden
      || this.#pulse || this.#framePulse || this.#pendingPulse || typeof this.#heading.animate !== 'function') return false;
    const frame = this.#container.querySelector('#preview-frame');
    const arrival = frame?.getAnimations?.().find(animation => animation.animationName === 'preview-heading-arrive'
      && animation.playState !== 'finished');
    if (arrival) {
      const pending = this.#pendingPulse = {};
      Promise.resolve(arrival.finished).then(() => {
        if (this.#pendingPulse !== pending) return;
        this.#pendingPulse = null;
        this.pulse();
      }, () => { if (this.#pendingPulse === pending) this.#pendingPulse = null; });
      return true;
    }
    // Keep the transparent legend stationary while it flashes over the animation.
    const rest = { opacity: 1 };
    const peak = { opacity: .45 };
    const duration = readCssMilliseconds(this.#window.getComputedStyle?.(this.#container),
      '--preview-flash-duration', FLASH_DURATION_MS);
    const frames = [rest, peak, rest, rest, peak, rest]
      .map((frame, index) => ({ ...frame, offset: FLASH_OFFSETS[index], easing: 'ease-in-out' }));
    const pulse = this.#pulse = this.#heading.animate(frames, { duration, easing: 'linear' });
    pulse.onfinish = () => { if (this.#pulse === pulse) this.#pulse = null; };
    if (typeof frame?.animate === 'function') {
      const normal = { borderColor: this.#window.getComputedStyle?.(frame)?.borderTopColor || '#333' };
      const bright = { borderColor: '#eee' };
      const outline = this.#framePulse = frame.animate([normal, bright, normal, normal, bright, normal]
        .map((keyframe, index) => ({ ...keyframe, offset: FLASH_OFFSETS[index], easing: 'ease-in-out' })),
      { duration, easing: 'linear' });
      outline.onfinish = () => { if (this.#framePulse === outline) this.#framePulse = null; };
    }
    return true;
  }

  #stopPulse() {
    this.#pendingPulse = null;
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
    if (this.#controlsExitTimer !== null) this.#window.clearTimeout(this.#controlsExitTimer);
    this.#controlsExitTimer = null;
    this.#animationDemo = null;
    this.#timingDemo = null;
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
