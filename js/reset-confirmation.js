import { OutsideDismissal } from './outside-dismissal.js';
import { visibleViewport } from './viewport-layout.js';

/** Anchored confirmation only; its caller owns the destructive action and persistence. */
export class ResetConfirmation {
  #window;
  #button;
  #panel;
  #content;
  #cancelButton;
  #onConfirm;
  #canOpen;
  #outside;
  #listeners = [];
  #disposed = false;

  constructor({ document, window, button, panel, confirmButton, cancelButton,
    onConfirm, canOpen = () => true } = {}) {
    if ([document, window, button, panel, confirmButton, cancelButton].some(target =>
      typeof target?.addEventListener !== 'function' || typeof target.removeEventListener !== 'function')
      || typeof panel?.showPopover !== 'function' || typeof panel.hidePopover !== 'function'
      || typeof button?.getBoundingClientRect !== 'function' || typeof panel?.style?.setProperty !== 'function'
      || !Number.isFinite(window?.innerWidth) || !Number.isFinite(window?.innerHeight)) {
      throw new TypeError('ResetConfirmation requires a document, window, trigger, popover and action buttons.');
    }
    if (typeof onConfirm !== 'function' || typeof canOpen !== 'function') {
      throw new TypeError('ResetConfirmation requires confirmation and availability callbacks.');
    }
    const content = panel.querySelector?.('#reset-confirmation-content');
    if (!content) throw new Error('ResetConfirmation is missing its content.');
    this.#window = window;
    this.#button = button;
    this.#panel = panel;
    this.#content = content;
    this.#cancelButton = cancelButton;
    this.#onConfirm = onConfirm;
    this.#canOpen = canOpen;
    this.#outside = new OutsideDismissal({ document,
      surface: () => panel.matches(':popover-open') ? panel : null,
      onDismiss: () => this.close(),
    });
    this.#listen(button, 'click', () => this.#open());
    this.#listen(cancelButton, 'click', () => this.close());
    this.#listen(confirmButton, 'click', () => {
      if (!panel.matches(':popover-open')) return;
      if (!this.#canOpen() || button.matches(':disabled')) {
        this.close({ restoreFocus: false });
        return;
      }
      if (this.#onConfirm() === true) this.close();
    });
    this.#listen(panel, 'toggle', () => {
      button.setAttribute('aria-expanded', String(panel.matches(':popover-open')));
    });
    this.#listen(document, 'keydown', event => {
      if (event.key !== 'Escape' || !panel.matches(':popover-open')) return;
      event.preventDefault();
      this.close();
    });
    this.#listen(document, 'visibilitychange', () => {
      if (document.hidden) this.close({ restoreFocus: false });
    });
    this.#listen(window, 'pagehide', () => this.close({ restoreFocus: false }));
    const position = () => { if (panel.matches(':popover-open')) this.#position(); };
    this.#listen(window, 'resize', position);
    if (window.visualViewport?.addEventListener) this.#listen(window.visualViewport, 'resize', position);
    button.setAttribute('aria-expanded', 'false');
  }

  close({ restoreFocus = true } = {}) {
    if (!this.#panel.matches(':popover-open')) return;
    this.#panel.hidePopover();
    this.#button.setAttribute('aria-expanded', 'false');
    if (restoreFocus && !this.#button.matches(':disabled') && this.#canOpen()) {
      this.#button.focus({ preventScroll: true });
    }
  }

  dispose() {
    this.close({ restoreFocus: false });
    this.#disposed = true;
    this.#outside.dispose();
    for (const remove of this.#listeners) remove();
    this.#listeners = [];
  }

  #listen(target, type, listener) {
    target.addEventListener(type, listener);
    this.#listeners.push(() => target.removeEventListener(type, listener));
  }

  #open() {
    if (this.#disposed || !this.#canOpen() || this.#button.matches(':disabled')) return;
    if (this.#panel.matches(':popover-open')) {
      this.close();
      return;
    }
    const anchor = this.#button.getBoundingClientRect();
    this.#panel.style.setProperty('--reset-closed-height', `${anchor.height}px`);
    this.#panel.style.setProperty('--reset-closed-top', `${anchor.top}px`);
    this.#panel.showPopover();
    this.#button.setAttribute('aria-expanded', 'true');
    this.#position();
    this.#cancelButton.focus({ preventScroll: true });
  }

  #position() {
    const anchor = this.#button.getBoundingClientRect();
    const viewport = visibleViewport(this.#window);
    const width = Math.min(anchor.width, Math.max(0, viewport.width - 16));
    const availableHeight = Math.max(0, viewport.height - 16);
    this.#panel.style.width = `${width}px`;
    this.#panel.style.maxHeight = `${availableHeight}px`;
    this.#panel.style.left = `${Math.max(viewport.left + 8,
      Math.min(anchor.left, viewport.left + viewport.width - width - 8))}px`;
    const height = Math.min(this.#content.offsetHeight + 8, availableHeight);
    const bottom = Math.min(anchor.top + anchor.height, viewport.top + viewport.height - 8);
    const top = Math.max(viewport.top + 8, bottom - height);
    this.#panel.style.setProperty('--reset-closed-height', `${anchor.height}px`);
    this.#panel.style.setProperty('--reset-closed-top', `${anchor.top}px`);
    this.#panel.style.setProperty('--reset-open-height', `${height}px`);
    this.#panel.style.setProperty('--reset-open-top', `${top}px`);
  }
}
