const FREQUENCIES = Object.freeze({ inhale: 440, holdIn: 520, exhale: 330, holdOut: 260 });
const MAX_CUE_DELAY_MS = 250;
const VIBRATION_DURATION_MS = 120;

/** Optional phase cues. Audio is unlocked by a user gesture; repeated frames and resumes stay quiet. */
export class PhaseCues {
  #AudioContext;
  #navigator;
  #document;
  #sound = false;
  #vibration = false;
  #vibrating = false;
  #onVibrationBlocked;
  #vibrationWarningShown = false;
  #context = null;
  #unlocking = null;
  #tone = null;
  #pending = null;
  #snapshot = null;
  #phaseKey = '';

  constructor({ window = globalThis.window, navigator = globalThis.navigator,
    document = globalThis.document, onVibrationBlocked = () => {} } = {}) {
    if (typeof onVibrationBlocked !== 'function') throw new TypeError('vibration callback must be a function');
    this.#AudioContext = window?.AudioContext;
    this.#navigator = navigator;
    this.#document = document;
    this.#onVibrationBlocked = onVibrationBlocked;
  }

  get soundSupported() { return typeof this.#AudioContext === 'function'; }
  get vibrationSupported() { return typeof this.#navigator?.vibrate === 'function'; }

  /** @param {{soundCue: boolean, vibration: boolean}} preferences */
  configure({ soundCue, vibration }) {
    this.#sound = soundCue;
    if (this.#vibration !== vibration) this.#vibrationWarningShown = false;
    this.#vibration = vibration;
    if (!soundCue) this.#closeAudio();
    if (!vibration) this.#cancelVibration();
  }

  /** Call synchronously from the start/resume gesture, before updating the session. */
  unlock() {
    if (!this.#sound || !this.soundSupported || this.#document?.hidden) return Promise.resolve();
    if (this.#unlocking) return this.#unlocking;
    try {
      const context = this.#context ??= new this.#AudioContext();
      if (context.state === 'running') return Promise.resolve();
      const unlocking = Promise.resolve(context.resume()).then(() => {
        if (this.#context === context) this.#flushAudio();
      }).catch(() => {
        if (this.#context === context) this.#closeAudio();
      }).finally(() => {
        if (this.#unlocking === unlocking) this.#unlocking = null;
      });
      this.#unlocking = unlocking;
      return unlocking;
    } catch {
      this.#closeAudio();
      return Promise.resolve();
    }
  }

  /** @param {import('./breathing-engine.js').BreathingSnapshot} snapshot */
  update(snapshot) {
    if (snapshot.status === 'idle') this.#phaseKey = '';
    if (snapshot.status !== 'running' || this.#document?.hidden) {
      this.stop();
      return;
    }
    this.#snapshot = snapshot;
    const key = `${snapshot.phase}:${snapshot.phaseStartedAtMs}`;
    if (this.#phaseKey === key) return;
    this.#phaseKey = key;
    this.#cancelTone();
    this.#pending = this.#sound && this.#context ? key : null;
    this.#flushAudio();
    this.#pulseVibration();
  }

  /** Call from the vibration toggle's user gesture. Acceptance cannot confirm physical vibration. */
  previewVibration() { return this.#pulseVibration(); }

  #pulseVibration() {
    if (!this.#vibration || !this.vibrationSupported || this.#document?.hidden) return false;
    try { this.#vibrating = this.#navigator.vibrate(VIBRATION_DURATION_MS) === true; }
    catch { this.#vibrating = false; }
    if (!this.#vibrating && !this.#vibrationWarningShown) {
      this.#vibrationWarningShown = true;
      this.#onVibrationBlocked();
    }
    return this.#vibrating;
  }

  stop() {
    this.#snapshot = null;
    this.#closeAudio();
    this.#cancelVibration();
  }

  #flushAudio() {
    const snapshot = this.#snapshot;
    const context = this.#context;
    if (!this.#pending || !snapshot || !context || context.state !== 'running') return;
    this.#pending = null;
    if (!this.#sound || this.#document?.hidden || snapshot.phaseElapsedMs > MAX_CUE_DELAY_MS) return;
    try {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      this.#tone = { oscillator, gain };
      const start = context.currentTime;
      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(FREQUENCIES[snapshot.phase], start);
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(0.035, start + 0.015);
      gain.gain.linearRampToValueAtTime(0, start + 0.18);
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.onended = () => {
        if (this.#tone?.oscillator === oscillator) this.#cancelTone();
      };
      oscillator.start(start);
      oscillator.stop(start + 0.18);
    } catch {
      this.#cancelTone();
    }
  }

  #cancelTone() {
    const tone = this.#tone;
    this.#tone = null;
    if (!tone) return;
    tone.oscillator.onended = null;
    try { tone.oscillator.stop(); } catch {}
    try { tone.oscillator.disconnect(); } catch {}
    try { tone.gain.disconnect(); } catch {}
  }

  #closeAudio() {
    this.#cancelTone();
    this.#pending = null;
    this.#unlocking = null;
    const context = this.#context;
    this.#context = null;
    if (!context) return;
    try { Promise.resolve(context.close()).catch(() => {}); } catch {}
  }

  #cancelVibration() {
    if (!this.#vibrating) return;
    this.#vibrating = false;
    try { this.#navigator.vibrate(0); } catch {}
  }
}
