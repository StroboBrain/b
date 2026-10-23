import { visibleViewport } from './viewport-layout.js';

/** Offer a return only while the main breathing visual is outside the visible screen. */
export class ReturnNavigation {
  #window;
  #breathing;
  #button;
  #observer;
  #listeners = [];
  #disposed = false;
  #sync = () => {
    if (this.#disposed) return;
    const box = this.#breathing.getBoundingClientRect();
    // Startup restores saved state while the app is still hidden. Wait for layout.
    if (box.width <= 0 || box.height <= 0) { this.#button.hidden = true; return; }
    const viewport = visibleViewport(this.#window);
    this.#button.hidden = box.right > viewport.left && box.left < viewport.left + viewport.width
      && box.bottom > viewport.top && box.top < viewport.top + viewport.height;
  };

  constructor({ window, breathing, button } = {}) {
    if (typeof window?.IntersectionObserver !== 'function'
      || typeof window.addEventListener !== 'function' || typeof window.removeEventListener !== 'function'
      || !Number.isFinite(window.innerWidth) || !Number.isFinite(window.innerHeight)
      || typeof breathing?.getBoundingClientRect !== 'function' || typeof button?.hidden !== 'boolean') {
      throw new TypeError('ReturnNavigation requires a window, measurable breathing visual and button.');
    }
    this.#window = window;
    this.#breathing = breathing;
    this.#button = button;
    this.#sync();
    this.#observer = new window.IntersectionObserver(entries => {
      if (entries.some(entry => entry.target === breathing)) this.#sync();
    // An edge touching the viewport has zero area; also observe its first visible pixel.
    }, { threshold: [0, Number.EPSILON] });
    this.#observer.observe(breathing);
    this.#listen(window, 'resize');
    this.#listen(window, 'pageshow');
    if (window.visualViewport?.addEventListener) {
      this.#listen(window.visualViewport, 'resize');
      this.#listen(window.visualViewport, 'scroll');
    }
  }

  dispose() {
    this.#disposed = true;
    this.#observer.disconnect();
    for (const remove of this.#listeners) remove();
    this.#listeners = [];
  }

  #listen(target, type) {
    target.addEventListener(type, this.#sync);
    this.#listeners.push(() => target.removeEventListener(type, this.#sync));
  }
}
