/** The visible screen rectangle, including a reduced visual viewport while the keyboard is open. */
export function visibleViewport(window) {
  const viewport = window.visualViewport;
  return { left: viewport?.offsetLeft ?? 0, top: viewport?.offsetTop ?? 0,
    width: viewport?.width ?? window.innerWidth, height: viewport?.height ?? window.innerHeight };
}

/** Centers the page against the full viewport without a mirrored native gutter.
 * Measure the root's painted width: clientWidth includes the reserved gutter
 * when scrolling locks, while viewport CSS units also change their basis.
 */
export class ViewportLayout {
  #window;
  #root;
  #sync = () => {
    const width = Math.max(0, this.#window.innerWidth - this.#root.getBoundingClientRect().width);
    this.#root.style.setProperty('--scrollbar-space', `${width}px`);
  };

  constructor({ window = globalThis.window, document = globalThis.document } = {}) {
    if (typeof window?.addEventListener !== 'function' || typeof window.removeEventListener !== 'function'
      || !Number.isFinite(window.innerWidth) || typeof document?.documentElement?.getBoundingClientRect !== 'function'
      || !Number.isFinite(document.documentElement.getBoundingClientRect().width)
      || typeof document.documentElement.style?.setProperty !== 'function') {
      throw new TypeError('ViewportLayout requires a window and measurable document root.');
    }
    this.#window = window;
    this.#root = document.documentElement;
    this.#sync();
    window.addEventListener('resize', this.#sync);
    window.visualViewport?.addEventListener('resize', this.#sync);
  }

  dispose() {
    this.#window.removeEventListener('resize', this.#sync);
    this.#window.visualViewport?.removeEventListener('resize', this.#sync);
  }
}
