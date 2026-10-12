/** Owns the #zen history entry. enter() must be called from a user gesture. */
export class ZenNavigator {
  #window;
  #onChange;
  #enabled = null;
  #sync = () => this.#set(this.#window.location.hash === '#zen');

  constructor({ window, onChange }) {
    this.#window = window;
    this.#onChange = onChange;
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
