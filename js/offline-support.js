/** Checks for a complete offline version when the app is opened.
 * A complete update reloads only after the active session has stopped.
 * Failed update checks leave the last downloaded version usable offline.
 */
export class OfflineSupport {
  #window;
  #document;
  #onUnavailable;
  #isIdle;
  #registration;
  #checking = false;
  #started = false;
  #updatePending = false;
  #reloading = false;

  constructor({ window, document, onUnavailable, isIdle }) {
    if (!window?.navigator || typeof window.addEventListener !== 'function'
      || typeof window.location?.reload !== 'function' || typeof document?.addEventListener !== 'function') {
      throw new TypeError('offline support requires a browser window and document');
    }
    if (typeof onUnavailable !== 'function' || typeof isIdle !== 'function') {
      throw new TypeError('offline support requires failure and idle callbacks');
    }
    this.#window = window;
    this.#document = document;
    this.#onUnavailable = onUnavailable;
    this.#isIdle = isIdle;
  }

  async start() {
    const worker = this.#window.navigator.serviceWorker;
    if (!worker || !this.#window.isSecureContext || this.#started) return;
    this.#started = true;
    worker.addEventListener('message', ({ data }) => {
      if (data?.type !== 'APP_UPDATED') return;
      this.#updatePending = true;
      this.applyPendingUpdate();
    });
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

  /** Called by the session owner after stopping; paused sessions stay intact. */
  applyPendingUpdate() {
    if (!this.#updatePending || this.#reloading || this.#document.hidden || !this.#isIdle()) return;
    this.#reloading = true;
    this.#window.location.reload();
  }

  async #refresh() {
    this.applyPendingUpdate();
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
