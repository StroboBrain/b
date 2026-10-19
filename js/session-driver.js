/** Updates countdowns and phase boundaries; CSS owns continuous visual motion.
 * Paused and stopped sessions schedule no work. Delayed timers catch up to the clock.
 */
export class SessionDriver {
  #engine;
  #setTimeout;
  #clearTimeout;
  #onChange;
  #timer = null;

  constructor({ engine, setTimeout = globalThis.setTimeout, clearTimeout = globalThis.clearTimeout, onChange } = {}) {
    for (const method of ['getSnapshot', 'start', 'resume', 'pause', 'reset', 'tick']) {
      if (typeof engine?.[method] !== 'function') throw new TypeError(`The session engine must provide ${method}().`);
    }
    if (typeof setTimeout !== 'function') throw new TypeError('setTimeout must be a function.');
    if (typeof clearTimeout !== 'function') throw new TypeError('clearTimeout must be a function.');
    if (typeof onChange !== 'function') throw new TypeError('onChange must be a function.');
    this.#engine = engine;
    this.#setTimeout = setTimeout;
    this.#clearTimeout = clearTimeout;
    this.#onChange = onChange;
  }

  get snapshot() { return this.#engine.getSnapshot(); }

  start(config) { this.#update(this.#engine.start(config)); }
  resume() { this.#update(this.#engine.resume()); }
  pause() { this.#update(this.#engine.pause()); }
  stop() { this.#update(this.#engine.reset()); }

  #update(snapshot) {
    if (this.#timer !== null) this.#clearTimeout(this.#timer);
    this.#timer = null;
    this.#onChange(snapshot);
    this.#schedule();
  }

  #schedule() {
    const snapshot = this.snapshot;
    if (snapshot.status !== 'running' || this.#timer !== null) return;
    const nextCountMs = snapshot.phaseRemainingMs % 1000 || 1000;
    // Round up so timer precision cannot produce a tight loop just before a boundary.
    const delay = Math.max(1, Math.ceil(Math.min(nextCountMs, snapshot.phaseRemainingMs)));
    this.#timer = this.#setTimeout(() => {
      this.#timer = null;
      this.#onChange(this.#engine.tick());
      this.#schedule();
    }, delay);
  }
}
