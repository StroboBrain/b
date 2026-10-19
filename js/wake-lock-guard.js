/** Optional screen wake lock: at most one request in flight and at most one lock held. */
export class WakeLockGuard {
  #navigator;
  #document;
  #lock = null;
  #request = null;
  #wanted = false;

  constructor({ navigator, document } = {}) {
    if (!navigator || typeof navigator !== 'object') throw new TypeError('A navigator object is required.');
    if (!document || typeof document.hidden !== 'boolean') throw new TypeError('The document must provide a hidden boolean.');
    if (navigator.wakeLock != null && typeof navigator.wakeLock.request !== 'function') {
      throw new TypeError('Wake lock support must provide request().');
    }
    this.#navigator = navigator;
    this.#document = document;
  }

  acquire() {
    this.#wanted = true;
    if (this.#lock || !this.#navigator.wakeLock || this.#document.hidden) return Promise.resolve();
    return this.#request ??= this.#requestLock().finally(() => { this.#request = null; });
  }

  release() {
    this.#wanted = false;
    const lock = this.#lock;
    this.#lock = null;
    return lock ? lock.release().catch(() => {}) : Promise.resolve();
  }

  async #requestLock() {
    try {
      const lock = await this.#navigator.wakeLock.request('screen');
      if (!this.#wanted || this.#document.hidden) return void lock.release().catch(() => {});
      this.#lock = lock;
      lock.addEventListener('release', () => { if (this.#lock === lock) this.#lock = null; }, { once: true });
    } catch {
      // Denied or unsupported wake locks must not interrupt the exercise.
    }
  }
}
