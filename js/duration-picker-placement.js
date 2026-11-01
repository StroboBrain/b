import { visibleViewport } from './viewport-layout.js';

/** @typedef {object} PickerControls
 * @property {HTMLButtonElement} value
 * @property {HTMLElement} picker
 * @property {HTMLElement} picker-content
 * @property {HTMLOutputElement} picked-value
 * @property {HTMLButtonElement} decrease
 * @property {HTMLButtonElement} increase
 * @property {HTMLButtonElement} fine-decrease
 * @property {HTMLButtonElement} fine-increase
 * @property {number} [openHeight]
 * @property {string} [centerTop]
 * @property {string} [centerBottom]
 * @property {{duration:number,easing:string}} [shellMotion]
 * @property {{transform:string,opacityEasing:string,transformEasing:string}[]} [stepMotion]
 * @property {number} [fadeDuration]
 * @property {number} [revealPause]
 */

/** Anchors popup columns to timing cards and follows viewport/layout changes. */
export class DurationPickerPlacement {
  #window;
  #controls;
  #onReveal;
  #beforeReposition;
  #viewportBounds;
  #resizeObserver;
  #listeners = [];
  #disposed = false;

  /** @param {{window:Window & typeof globalThis, container:HTMLElement,
   * controls:Record<string,PickerControls>, onReveal:(controls:PickerControls)=>void,
   * beforeReposition:()=>void}} options */
  constructor({ window, container, controls, onReveal, beforeReposition }) {
    if (typeof window?.addEventListener !== 'function' || typeof window.removeEventListener !== 'function'
      || !controls || typeof onReveal !== 'function' || typeof beforeReposition !== 'function') {
      throw new TypeError('DurationPickerPlacement requires viewport, controls and layout callbacks.');
    }
    this.#window = window;
    this.#controls = controls;
    this.#onReveal = onReveal;
    this.#beforeReposition = beforeReposition;
    this.#listen(window, 'resize', () => this.reposition());
    if (window.visualViewport?.addEventListener) this.#listen(window.visualViewport, 'resize', () => this.reposition());
    if (typeof window.ResizeObserver === 'function') {
      this.#resizeObserver = new window.ResizeObserver(entries => {
        if (this.#disposed) return;
        let layoutChanged = false;
        for (const entry of entries) {
          const control = Object.values(controls).find(({ picker }) => picker === entry.target);
          if (control) onReveal(control);
          else if (entry.target === container || entry.target === container.parentElement) layoutChanged = true;
        }
        if (layoutChanged) this.reposition({ layoutChanged: true });
      });
      for (const { picker } of Object.values(controls)) this.#resizeObserver.observe(picker);
      this.#resizeObserver.observe(container);
      if (container.parentElement) this.#resizeObserver.observe(container.parentElement);
    }
  }

  dispose() {
    this.#disposed = true;
    this.#resizeObserver?.disconnect();
    for (const remove of this.#listeners) remove();
    this.#listeners = [];
  }

  #listen(target, type, listener) {
    target.addEventListener(type, listener);
    this.#listeners.push(() => target.removeEventListener(type, listener));
  }

  reposition({ layoutChanged = false } = {}) {
    const bounds = visibleViewport(this.#window);
    if (!layoutChanged && Object.keys(bounds).every(key => bounds[key] === this.#viewportBounds?.[key])) return;
    this.#beforeReposition();
    const entry = Object.entries(this.#controls).find(([, { picker }]) => picker.matches(':popover-open'));
    if (entry) this.position(entry[0], bounds);
  }

  position(phase, bounds = visibleViewport(this.#window)) {
    const controls = this.#controls[phase];
    const { value: trigger, picker, 'picker-content': content } = controls;
    const anchor = trigger.getBoundingClientRect();
    const { left, top, width, height } = bounds;
    this.#viewportBounds = bounds;
    // The expanded column occupies the timing cell's width. Its center stays
    // over the original time while the adjustment buttons grow above and below.
    const viewportWidth = Math.max(0, width - 16);
    const center = /** @type {HTMLElement} */ (controls['picked-value'].closest('.picker-center'));
    picker.style.setProperty('--picker-center-height', `${center.offsetHeight}px`);
    picker.style.width = `${Math.max(52, anchor.width)}px`;
    picker.style.maxWidth = `${viewportWidth}px`;
    picker.style.maxHeight = `${Math.max(0, height - 16)}px`;
    picker.dataset.compact = String(height < 272);
    const edgeValue = this.#window.getComputedStyle?.(picker).getPropertyValue('--picker-edge-space').trim() ?? '';
    const edgeSpace = /^(\d+(?:\.\d+)?)px$/.test(edgeValue) ? Number.parseFloat(edgeValue) : NaN;
    const frameSpace = edgeSpace >= 0 && edgeSpace <= 24 ? 2 * edgeSpace + 2 : 8;
    const contentHeight = content.offsetHeight + frameSpace;
    const openHeight = Math.min(contentHeight, Math.max(0, height - 16));
    controls.openHeight = openHeight;
    picker.dataset.scrollable = String(contentHeight > openHeight);
    const pickerLeft = Math.max(left + 8, Math.min(anchor.left + (anchor.width - picker.offsetWidth) / 2, left + width - picker.offsetWidth - 8));
    const pickerTop = Math.max(top + 8, Math.min(anchor.top + (anchor.height - openHeight) / 2, top + height - openHeight - 8));
    picker.style.left = `${pickerLeft}px`;
    picker.style.setProperty('--picker-closed-height', `${anchor.height}px`);
    picker.style.setProperty('--picker-open-height', `${openHeight}px`);
    picker.style.setProperty('--picker-closed-top', `${anchor.top}px`);
    picker.style.setProperty('--picker-open-top', `${pickerTop}px`);
    this.#onReveal(controls);
  }

}
