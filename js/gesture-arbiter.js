/** Input ownership is independent of component construction order. Higher wins. */
export const GESTURE_PRIORITIES = Object.freeze({
  ZEN: 600,
  POPUP_COMPLETION: 500,
  POPUP_OUTSIDE: 400,
  POPUP_INPUT: 300,
  NOTIFICATION: 200,
  PANEL: 100,
});

const INPUT_TYPES = new Set(['pointerdown', 'pointermove', 'pointerup', 'pointercancel',
  'touchstart', 'touchmove', 'touchend', 'touchcancel', 'click', 'keydown', 'focusin', 'focusout']);
const arbiters = new WeakMap();

/** Standalone components and the app share one capture owner for their document. */
/** @param {any} document */
export function acquireGestureArbiter(document) {
  if (!document || typeof document.addEventListener !== 'function'
    || typeof document.removeEventListener !== 'function') {
    throw new TypeError('GestureArbiter requires an event-capable document.');
  }
  let arbiter = arbiters.get(document);
  if (!arbiter) {
    arbiter = new GestureArbiter({ document });
    arbiters.set(document, arbiter);
  }
  return arbiter;
}

/** Policies return true to consume; observing handlers leave native input alone.
 * Each input type has one non-passive document capture listener, only while a
 * registered policy needs it. Component disposal unregisters its own policies.
 */
export class GestureArbiter {
  #document;
  #policies = new Map();
  #listeners = new Map();

  /** @param {{document?: any}} [options] */
  constructor({ document } = {}) {
    if (typeof document?.addEventListener !== 'function' || typeof document.removeEventListener !== 'function') {
      throw new TypeError('GestureArbiter requires an event-capable document.');
    }
    const existing = arbiters.get(document);
    if (existing) return existing;
    this.#document = document;
    arbiters.set(document, this);
  }

  /** @param {{name?: string, priority?: number, handlers?: Record<string, (event: any) => boolean | void>}} [policy] */
  register({ name, priority, handlers } = {}) {
    if (typeof name !== 'string' || !name || !Number.isFinite(priority)
      || !handlers || !Object.keys(handlers).length
      || Object.entries(handlers).some(([type, handler]) => !INPUT_TYPES.has(type) || typeof handler !== 'function')) {
      throw new TypeError('A gesture policy requires a name, numeric priority and supported input handlers.');
    }
    if (this.#policies.has(name)) throw new Error(`Gesture policy already registered: ${name}`);
    const policy = { name, priority, handlers };
    this.#policies.set(name, policy);
    for (const type of Object.keys(handlers)) {
      if (this.#listeners.has(type)) continue;
      const listener = event => this.#dispatch(type, event);
      this.#listeners.set(type, listener);
      this.#document.addEventListener(type, listener, { capture: true, passive: false });
    }
    return () => {
      if (this.#policies.get(name) !== policy) return;
      this.#policies.delete(name);
      for (const type of Object.keys(handlers)) {
        if ([...this.#policies.values()].some(current => current.handlers[type])) continue;
        this.#document.removeEventListener(type, this.#listeners.get(type), { capture: true });
        this.#listeners.delete(type);
      }
    };
  }

  #dispatch(type, event) {
    const policies = [...this.#policies.values()].sort((a, b) => b.priority - a.priority || a.name.localeCompare(b.name));
    for (const policy of policies) {
      if (this.#policies.get(policy.name) !== policy) continue;
      if (policy.handlers[type]?.(event) !== true) continue;
      event.preventDefault?.();
      event.stopImmediatePropagation?.();
      return;
    }
  }
}
