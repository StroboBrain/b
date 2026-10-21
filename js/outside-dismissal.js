/** Dismiss a floating surface with one gesture, consuming that entire gesture.
 * Capture runs before controls underneath receive a pointer press or click.
 */
export class OutsideDismissal {
  #surface;
  #onDismiss;
  #isInside;
  #pointers = new Map();
  #listeners = [];

  constructor({ document, surface, onDismiss, isInside = eventIsInside } = {}) {
    if (typeof document?.addEventListener !== 'function' || typeof document.removeEventListener !== 'function'
      || [surface, onDismiss, isInside].some(callback => typeof callback !== 'function')) {
      throw new TypeError('OutsideDismissal requires a document, surface and dismissal callbacks.');
    }
    this.#surface = surface;
    this.#onDismiss = onDismiss;
    this.#isInside = isInside;
    this.#listen(document, 'pointerdown', event => {
      // Some browsers omit click after a cancelled press. A new gesture must
      // remain usable without relying on a timeout to clear its predecessor.
      for (const [id, released] of this.#pointers) {
        if (released) this.#pointers.delete(id);
      }
      if (this.#dismissOutside(event)) this.#pointers.set(event.pointerId, false);
    });
    this.#listen(document, 'pointerup', event => {
      if (!this.#pointers.has(event.pointerId)) return;
      consume(event);
      this.#pointers.set(event.pointerId, true);
    });
    this.#listen(document, 'pointercancel', event => {
      if (!this.#pointers.delete(event.pointerId)) return;
      consume(event);
    });
    this.#listen(document, 'click', event => {
      const pointerId = event.pointerId ?? this.#pointers.keys().next().value;
      if (event.detail !== 0 && this.#pointers.has(pointerId)) {
        this.#pointers.delete(pointerId);
        consume(event);
        return;
      }
      // Keyboard/assistive-technology clicks have no preceding pointerdown.
      this.#dismissOutside(event);
    });
  }

  dispose() {
    for (const remove of this.#listeners) remove();
    this.#listeners = [];
    this.#pointers.clear();
  }

  #dismissOutside(event) {
    const surface = this.#surface();
    if (!surface || this.#isInside(event, surface)) return false;
    consume(event);
    this.#onDismiss();
    return true;
  }

  #listen(document, type, listener) {
    document.addEventListener(type, listener, true);
    this.#listeners.push(() => document.removeEventListener(type, listener, true));
  }
}

function eventIsInside(event, surface) {
  if (typeof event.composedPath === 'function') return event.composedPath().includes(surface);
  for (let element = event.target; element; element = element.parentElement) {
    if (element === surface) return true;
  }
  return false;
}

function consume(event) {
  event.preventDefault();
  event.stopImmediatePropagation();
}
