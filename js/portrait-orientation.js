/** Keeps phone screens in portrait when the browser permits orientation locking.
 * Installed apps also declare portrait in the manifest. Tabs may require fullscreen;
 * a rejected or unavailable lock must never interrupt the breathing controls.
 */
export class PortraitOrientation {
  #window;
  #document;
  #orientation;
  #pending = false;
  #locked = false;
  #disposed = false;

  #resume = () => {
    if (this.#document.hidden) return;
    this.#locked = false;
    this.#request();
  };

  #interaction = (event) => {
    if (event.isTrusted) this.#request();
  };

  #rotation = () => {
    if (this.#orientation.type?.startsWith('landscape')) this.#resume();
  };

  constructor({ window = globalThis.window, document = globalThis.document } = {}) {
    if (typeof window?.addEventListener !== 'function' || typeof window.removeEventListener !== 'function'
      || typeof document?.addEventListener !== 'function' || typeof document.removeEventListener !== 'function') {
      throw new TypeError('PortraitOrientation requires browser window and document event targets.');
    }
    this.#window = window;
    this.#document = document;
    this.#orientation = window.screen?.orientation;
    if (typeof this.#orientation?.lock !== 'function') return;
    window.addEventListener('pageshow', this.#resume);
    document.addEventListener('visibilitychange', this.#resume);
    document.addEventListener('fullscreenchange', this.#resume);
    document.addEventListener('pointerup', this.#interaction, { capture: true, passive: true });
    document.addEventListener('keydown', this.#interaction, { capture: true, passive: true });
    this.#orientation.addEventListener?.('change', this.#rotation);
    this.#request();
  }

  dispose() {
    this.#disposed = true;
    this.#window.removeEventListener('pageshow', this.#resume);
    this.#document.removeEventListener('visibilitychange', this.#resume);
    this.#document.removeEventListener('fullscreenchange', this.#resume);
    this.#document.removeEventListener('pointerup', this.#interaction, true);
    this.#document.removeEventListener('keydown', this.#interaction, true);
    this.#orientation?.removeEventListener?.('change', this.#rotation);
  }

  #isPhone() {
    const width = this.#window.screen?.width || this.#window.innerWidth;
    const height = this.#window.screen?.height || this.#window.innerHeight;
    return this.#window.matchMedia?.('(pointer: coarse)').matches === true
      && Number.isFinite(width) && Number.isFinite(height)
      && Math.min(width, height) > 0 && Math.min(width, height) < 600
      && Math.max(width, height) <= 1200;
  }

  async #request() {
    if (this.#disposed || this.#pending || this.#locked || this.#document.hidden || !this.#isPhone()) return;
    this.#pending = true;
    try {
      await this.#orientation.lock('portrait');
      if (!this.#disposed) this.#locked = true;
    } catch {
      // Fullscreen or an installed app may be required. Retry on the next real
      // interaction or resume without forcing fullscreen or blocking any input.
    } finally {
      this.#pending = false;
    }
  }
}
