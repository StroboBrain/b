/** Owns one frame loop. Pausing captures time; stopped/paused sessions schedule no frames. */
export class SessionDriver {
  #engine;
  #raf;
  #caf;
  #onChange;
  #frame = null;

  constructor({ engine, raf, caf, onChange }) {
    this.#engine = engine;
    this.#raf = raf;
    this.#caf = caf;
    this.#onChange = onChange;
  }

  get snapshot() { return this.#engine.getSnapshot(); }

  start(config) { this.#update(this.#engine.start(config)); }
  resume() { this.#update(this.#engine.resume()); }
  pause() { this.#update(this.#engine.pause()); }
  stop() { this.#update(this.#engine.reset()); }

  #update(snapshot) {
    if (this.#frame !== null) this.#caf(this.#frame);
    this.#frame = null;
    this.#onChange(snapshot);
    this.#schedule();
  }

  #schedule() {
    if (this.snapshot.status !== 'running' || this.#frame !== null) return;
    this.#frame = this.#raf(() => {
      this.#frame = null;
      this.#onChange(this.#engine.tick());
      this.#schedule();
    });
  }
}
