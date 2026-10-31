const DOT_SPACING_PX = 5;

/** Give each closed guide an integer number of equally spaced dots at its layout size. */
export class GuideLayout {
  #window;
  #circles;
  #observer;
  #resize = () => this.#sync();
  #sync = (entries) => {
    for (const [guide, circle] of this.#circles) {
      if (entries && !entries.some(entry => entry.target === guide)) continue;
      // SVG geometry ignores the exit transform, so hiding a ring never changes its dot count.
      const length = circle.getTotalLength();
      if (!Number.isFinite(length) || length <= 0) continue;
      const count = String(Math.max(1, Math.round(length / DOT_SPACING_PX)));
      if (circle.getAttribute('pathLength') !== count) circle.setAttribute('pathLength', count);
    }
  };

  constructor({ window = globalThis.window, document = globalThis.document } = {}) {
    if (typeof document?.querySelectorAll !== 'function' || typeof window?.addEventListener !== 'function'
      || typeof window.removeEventListener !== 'function') {
      throw new TypeError('GuideLayout requires a document and resize-capable window.');
    }
    this.#window = window;
    this.#circles = new Map([...document.querySelectorAll('.breath-guide')]
      .map(guide => [guide, guide.querySelector('circle')]));
    if ([...this.#circles.values()].some(circle => typeof circle?.getTotalLength !== 'function'
      || typeof circle.getAttribute !== 'function' || typeof circle.setAttribute !== 'function')) {
      throw new TypeError('GuideLayout requires measurable SVG guide circles.');
    }
    this.#sync();
    if (typeof window.ResizeObserver === 'function') {
      this.#observer = new window.ResizeObserver(entries => this.#sync(entries));
      for (const guide of this.#circles.keys()) this.#observer.observe(guide);
    } else window.addEventListener('resize', this.#resize);
  }

  dispose() {
    this.#observer?.disconnect();
    this.#window.removeEventListener('resize', this.#resize);
  }
}
