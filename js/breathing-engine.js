/**
 * @typedef {Object} BreathingConfig
 * @property {number} inhale Seconds in tenths, 0.1–99.
 * @property {number} holdIn Seconds in tenths, 0–99.
 * @property {number} exhale Seconds in tenths, 0.1–99.
 * @property {number} holdOut Seconds in tenths, 0–99.
 */

export const DEFAULT_CONFIG = Object.freeze({
  inhale: 4,
  holdIn: 4,
  exhale: 4,
  holdOut: 4,
});

/** Inclusive [minimum, maximum] seconds for each phase. */
export const CONFIG_LIMITS = Object.freeze({
  inhale: Object.freeze([0.1, 99]),
  holdIn: Object.freeze([0, 99]),
  exhale: Object.freeze([0.1, 99]),
  holdOut: Object.freeze([0, 99]),
});

/** The four phases in cycle order; also the configuration's field names. */
export const PHASES = Object.freeze(Object.keys(CONFIG_LIMITS));

/** Compare the four supported timing fields of validated configurations. */
export function configsEqual(left, right) {
  return PHASES.every((field) => left[field] === right[field]);
}

/**
 * Validate one duration in seconds and return it rounded to tenths.
 * @param {number} value
 * @param {number} minimum
 * @param {number} maximum
 * @param {string} label Names the value in error messages.
 * @returns {number}
 * @throws {TypeError} If the value is not a number.
 * @throws {RangeError} If the value is not in tenths within [minimum, maximum].
 */
export function validateTenths(value, minimum, maximum, label) {
  if (typeof value !== 'number') {
    throw new TypeError(`${label} must be a number.`);
  }
  if (!Number.isFinite(value) || Math.abs(value * 10 - Math.round(value * 10)) > 1e-8
    || value < minimum || value > maximum) {
    throw new RangeError(`${label} must be in steps of 0.1 from ${minimum} to ${maximum}.`);
  }
  return Math.round(value * 10) / 10;
}

/**
 * Validate the public configuration contract and return a detached, normalized copy.
 * Extra properties are ignored; numeric strings are deliberately not coerced.
 * @param {BreathingConfig} config
 * @returns {BreathingConfig}
 * @throws {TypeError} If the configuration or one of its fields has the wrong type.
 * @throws {RangeError} If a field is not in tenths within its permitted range.
 */
export function validateConfig(config) {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    throw new TypeError('A breathing configuration must be an object.');
  }

  const normalized = /** @type {BreathingConfig} */ ({});
  for (const [field, [minimum, maximum]] of Object.entries(CONFIG_LIMITS)) {
    normalized[field] = validateTenths(config[field], minimum, maximum, field);
  }
  return normalized;
}

/**
 * @typedef {Object} BreathingSnapshot
 * @property {'idle'|'running'|'paused'} status
 * @property {'inhale'|'holdIn'|'exhale'|'holdOut'|null} phase
 * @property {number} phaseDurationMs
 * @property {number} phaseElapsedMs
 * @property {number} phaseRemainingMs
 * @property {number} phaseStartedAtMs Session elapsed time when this phase began; 0 when idle.
 * @property {number} sessionElapsedMs
 */

/**
 * Clock-driven breathing state machine with no DOM or scheduling dependencies.
 *
 * Contract: callers advance time using tick(); reading a snapshot never advances
 * time. Pause excludes all paused time. Elapsed time cannot decrease, and every
 * active phase has a positive duration. Phases repeat continuously until reset.
 * phaseStartedAtMs distinguishes successive occurrences of the same phase, even
 * when a delayed tick skips one or more complete cycles.
 */
export class BreathingEngine {
  #now;
  #phases = [];
  /** @type {BreathingSnapshot['status']} */
  #status = 'idle';
  #cycleDurationMs = 0;
  #elapsedMs = 0;
  #elapsedBeforeRun = 0;
  #runningSince = 0;

  /** @param {{now?: () => number}} [options] A monotonic clock in milliseconds. */
  constructor({ now = () => performance.now() } = {}) {
    if (typeof now !== 'function') {
      throw new TypeError('The clock must be a function.');
    }
    this.#now = now;
  }

  /**
   * Start or restart a session. Validation must succeed before any state changes.
   * @param {BreathingConfig} config
   * @returns {BreathingSnapshot}
   */
  start(config = DEFAULT_CONFIG) {
    const normalized = validateConfig(config);
    const startedAt = this.#readClock();
    const phases = PHASES
      .map((name) => ({ name, durationMs: Math.round(normalized[name] * 1000) }))
      .filter((phase) => phase.durationMs > 0);

    this.#phases = phases;
    this.#cycleDurationMs = phases.reduce((total, phase) => total + phase.durationMs, 0);
    this.#elapsedMs = 0;
    this.#elapsedBeforeRun = 0;
    this.#runningSince = startedAt;
    this.#status = 'running';
    return this.getSnapshot();
  }

  /** @returns {BreathingSnapshot} Advance directly to the current clock time. */
  tick() {
    if (this.#status === 'running') {
      const elapsed = this.#elapsedBeforeRun + this.#readClock() - this.#runningSince;
      this.#elapsedMs = Math.max(this.#elapsedMs, elapsed);
    }
    return this.getSnapshot();
  }

  /** @returns {BreathingSnapshot} Capture elapsed time and pause an active session. */
  pause() {
    if (this.#status === 'running') {
      this.tick();
      this.#elapsedBeforeRun = this.#elapsedMs;
      this.#status = 'paused';
    }
    return this.getSnapshot();
  }

  /** @returns {BreathingSnapshot} Resume a paused session without counting paused time. */
  resume() {
    if (this.#status === 'paused') {
      this.#runningSince = this.#readClock();
      this.#status = 'running';
    }
    return this.getSnapshot();
  }

  /** @returns {BreathingSnapshot} Return to the initial idle state. */
  reset() {
    this.#phases = [];
    this.#status = 'idle';
    this.#cycleDurationMs = 0;
    this.#elapsedMs = 0;
    this.#elapsedBeforeRun = 0;
    this.#runningSince = 0;
    return this.getSnapshot();
  }

  /** @returns {BreathingSnapshot} A detached value describing the last advanced state. */
  getSnapshot() {
    const snapshot = {
      status: this.#status,
      phase: null,
      phaseDurationMs: 0,
      phaseElapsedMs: 0,
      phaseRemainingMs: 0,
      phaseStartedAtMs: 0,
      sessionElapsedMs: this.#elapsedMs,
    };

    if (this.#status === 'running' || this.#status === 'paused') {
      let phaseElapsedMs = this.#elapsedMs % this.#cycleDurationMs;
      for (const phase of this.#phases) {
        if (phaseElapsedMs < phase.durationMs) {
          snapshot.phase = phase.name;
          snapshot.phaseDurationMs = phase.durationMs;
          snapshot.phaseElapsedMs = phaseElapsedMs;
          snapshot.phaseRemainingMs = phase.durationMs - phaseElapsedMs;
          snapshot.phaseStartedAtMs = this.#elapsedMs - phaseElapsedMs;
          break;
        }
        phaseElapsedMs -= phase.durationMs;
      }
    }
    return snapshot;
  }

  #readClock() {
    const now = this.#now();
    if (typeof now !== 'number' || !Number.isFinite(now)) {
      throw new TypeError('The clock must return a finite number of milliseconds.');
    }
    return now;
  }
}
