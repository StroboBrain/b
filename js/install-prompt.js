/** Owns the browser's single-use install prompt and its availability control. */
export class InstallPrompt {
  #prompt = null;
  #button;
  #onUnavailable;

  constructor({ window, button, onUnavailable }) {
    if (typeof window?.addEventListener !== 'function'
      || typeof button?.addEventListener !== 'function'
      || typeof onUnavailable !== 'function') {
      throw new TypeError('InstallPrompt requires a window, button and onUnavailable callback.');
    }
    this.#button = button;
    this.#onUnavailable = onUnavailable;
    window.addEventListener('beforeinstallprompt', (event) => {
      event.preventDefault();
      this.#prompt = event;
      this.#sync();
    });
    window.addEventListener('appinstalled', () => {
      this.#prompt = null;
      this.#sync();
    });
    button.addEventListener('click', () => this.#install());
    this.#sync();
  }

  #sync() {
    this.#button.hidden = this.#prompt === null;
  }

  async #install() {
    if (!this.#prompt) return;
    const prompt = this.#prompt;
    this.#prompt = null;
    this.#sync();
    try {
      await prompt.prompt();
      await prompt.userChoice;
    } catch {
      this.#onUnavailable();
    }
  }
}
