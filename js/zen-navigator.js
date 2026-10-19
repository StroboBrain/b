/** Owns the #zen history entry. enter() must be called from a user gesture. */
export class ZenNavigator {
  #window;
  #onChange;
  #enabled = null;
  #sync = () => this.#set(this.#window.location.hash === '#zen');

  constructor({ window, onChange } = {}) {
    if (typeof window?.addEventListener !== 'function') throw new TypeError('The window must provide addEventListener().');
    for (const method of ['pushState', 'replaceState', 'back']) {
      if (typeof window.history?.[method] !== 'function') throw new TypeError(`History must provide ${method}().`);
    }
    for (const field of ['hash', 'pathname', 'search']) {
      if (typeof window.location?.[field] !== 'string') throw new TypeError(`Location must provide a ${field} string.`);
    }
    if (typeof onChange !== 'function') throw new TypeError('onChange must be a function.');
    this.#window = window;
    this.#onChange = onChange;
    // Sessions live in memory. A restored URL must start with accessible setup controls.
    if (window.location.hash === '#zen') {
      const state = window.history.state;
      const { simpleBZen, ...rest } = state ?? {};
      window.history.replaceState(state === null ? null : rest, '', window.location.pathname + window.location.search);
    }
    window.addEventListener('popstate', this.#sync);
    window.addEventListener('hashchange', this.#sync);
  }

  get enabled() { return this.#enabled === true; }
  sync() { this.#sync(); }

  enter() {
    if (this.enabled) return;
    const { history, location } = this.#window;
    if (location.hash !== '#zen') history.pushState({ ...history.state, simpleBZen: true }, '', '#zen');
    this.#set(true);
  }

  leave() {
    if (!this.enabled) return;
    const { history, location } = this.#window;
    this.#set(false);
    if (history.state?.simpleBZen) history.back();
    else history.replaceState(history.state, '', location.pathname + location.search);
  }

  #set(enabled) {
    if (enabled === this.#enabled) return;
    this.#enabled = enabled;
    this.#onChange(enabled);
  }
}
