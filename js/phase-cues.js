const FREQUENCIES = Object.freeze({ inhale: 440, holdIn: 520, exhale: 330, holdOut: 260 });
const MAX_CUE_DELAY_MS = 250;

/** Optional phase cues. Audio is unlocked by a user gesture; repeated frames and resumes stay quiet. */
export class PhaseCues {
  #AudioContext;
  #document;
  #sound = false;
  #context = null;
  #unlocking = null;
  #tone = null;
  #pending = null;
  #snapshot = null;
  #phaseKey = '';

  constructor({ window = globalThis.window, document = globalThis.document } = {}) {
    if (!window || typeof window !== 'object') throw new TypeError('A window object is required.');
    if (!document || typeof document.hidden !== 'boolean') throw new TypeError('The document must provide a hidden boolean.');
    if (window.AudioContext != null && typeof window.AudioContext !== 'function') {
      throw new TypeError('AudioContext must be a constructor when supported.');
    }
    this.#AudioContext = window.AudioContext;
    this.#document = document;
  }

  get soundSupported() { return typeof this.#AudioContext === 'function'; }

  /** @param {{soundCue: boolean}} preferences */
  configure({ soundCue }) {
    if (typeof soundCue !== 'boolean') throw new TypeError('soundCue must be a boolean.');
    this.#sound = soundCue;
    if (!soundCue) this.#closeAudio();
  }

  /** Call synchronously from the start/resume gesture, before updating the session. */
  unlock() {
    if (!this.#sound || !this.soundSupported || this.#document.hidden) return Promise.resolve();
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
    if (!snapshot || !['idle', 'running', 'paused'].includes(snapshot.status)) {
      throw new TypeError('A breathing snapshot must have an idle, running or paused status.');
    }
    if (snapshot.status !== 'idle') {
      if (!Object.hasOwn(FREQUENCIES, snapshot.phase)) throw new TypeError('An active snapshot must name a breathing phase.');
      for (const field of ['phaseStartedAtMs', 'phaseElapsedMs']) {
        if (typeof snapshot[field] !== 'number' || !Number.isFinite(snapshot[field]) || snapshot[field] < 0) {
          throw new TypeError(`${field} must be a non-negative finite number.`);
        }
      }
    }
    if (snapshot.status === 'idle') this.#phaseKey = '';
    if (snapshot.status !== 'running' || this.#document.hidden) {
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
  }

  stop() {
    this.#snapshot = null;
    this.#closeAudio();
  }

  #flushAudio() {
    const snapshot = this.#snapshot;
    const context = this.#context;
    if (!this.#pending || !snapshot || !context || context.state !== 'running') return;
    this.#pending = null;
    if (!this.#sound || this.#document.hidden || snapshot.phaseElapsedMs > MAX_CUE_DELAY_MS) return;
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
}
