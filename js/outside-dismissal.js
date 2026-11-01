import { acquireGestureArbiter, GESTURE_PRIORITIES } from './gesture-arbiter.js';

/** Dismiss a floating surface with one gesture, consuming that entire gesture.
 * Capture runs before controls underneath receive a pointer press or click.
 */
export class OutsideDismissal {
  #surface;
  #onDismiss;
  #isInside;
  #pointers = new Map();
  #unregister;

  /** @param {{document?: any, surface?: () => any, onDismiss?: () => void,
   * isInside?: (event: any, surface: any) => boolean, name?: string, priority?: number}} [options] */
  constructor({ document, surface, onDismiss, isInside = eventIsInside,
    name = 'outside-dismissal', priority = GESTURE_PRIORITIES.POPUP_OUTSIDE } = {}) {
    if (typeof document?.addEventListener !== 'function' || typeof document.removeEventListener !== 'function'
      || [surface, onDismiss, isInside].some(callback => typeof callback !== 'function')) {
      throw new TypeError('OutsideDismissal requires a document, surface and dismissal callbacks.');
    }
    this.#surface = surface;
    this.#onDismiss = onDismiss;
    this.#isInside = isInside;
    this.#unregister = acquireGestureArbiter(document).register({ name, priority, handlers: {
      pointerdown: event => {
        // Some browsers omit click after a cancelled press. A new gesture must
        // remain usable without relying on a timeout to clear its predecessor.
        // Reused IDs also recover when backgrounding dropped the old release.
        for (const [id, released] of this.#pointers) {
          if (released || id === event.pointerId) this.#pointers.delete(id);
        }
        if (!this.#dismissOutside(event)) return;
        this.#pointers.set(event.pointerId, false);
        return true;
      },
      pointerup: event => {
        if (!this.#pointers.has(event.pointerId)) return;
        this.#pointers.set(event.pointerId, true);
        return true;
      },
      pointercancel: event => {
        if (!this.#pointers.delete(event.pointerId)) return;
        return true;
      },
      click: event => {
        const pointerId = event.pointerId ?? this.#pointers.keys().next().value;
        if (event.detail !== 0 && this.#pointers.has(pointerId)) {
          this.#pointers.delete(pointerId);
          return true;
        }
        // Keyboard/assistive-technology clicks have no preceding pointerdown.
        return this.#dismissOutside(event);
      },
    } });
  }

  dispose() {
    this.#unregister();
    this.#pointers.clear();
  }

  #dismissOutside(event) {
    const surface = this.#surface();
    if (!surface || this.#isInside(event, surface)) return false;
    this.#onDismiss();
    return true;
  }
}

function eventIsInside(event, surface) {
  if (typeof event.composedPath === 'function') return event.composedPath().includes(surface);
  for (let element = event.target; element; element = element.parentElement) {
    if (element === surface) return true;
  }
  return false;
}
