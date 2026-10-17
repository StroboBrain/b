/** Checks for a complete offline version when the app is opened.
 * The worker reloads its clients after a new version has activated.
 * Failed update checks leave the last downloaded version usable offline.
 */
export class OfflineSupport {
  #window;
  #document;
  #onUnavailable;
  #registration;
  #checking = false;

  constructor({ window, document, onUnavailable }) {
    if (typeof onUnavailable !== 'function') {
      throw new TypeError('offline support requires a failure callback');
    }
    this.#window = window;
    this.#document = document;
    this.#onUnavailable = onUnavailable;
  }

  async start() {
    const worker = this.#window.navigator.serviceWorker;
    if (!worker || !this.#window.isSecureContext) return;
    this.#document.addEventListener('visibilitychange', () => {
      if (!this.#document.hidden) this.#refresh();
    });
    this.#window.addEventListener('pageshow', () => this.#refresh());
    this.#window.addEventListener('online', () => this.#refresh());
    try {
      this.#registration = await worker.register('./sw.js', { updateViaCache: 'none' });
      await this.#refresh();
    } catch {
      this.#onUnavailable();
    }
  }

  async #refresh() {
    if (!this.#registration || this.#checking || this.#document.hidden) return;
    this.#checking = true;
    try {
      await this.#registration.update();
    } catch {
      // Offline or a failed deployment: keep the working, fully cached version.
    } finally {
      this.#checking = false;
    }
  }
}
