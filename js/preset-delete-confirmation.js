import { OutsideDismissal } from './outside-dismissal.js';

/** Confirm one captured preset from a popup that expands from its trash control.
 * The caller owns selection, the minimum preset count and persistence.
 */
export class PresetDeleteConfirmation {
  #document;
  #window;
  #trigger;
  #popup;
  #cancelButton;
  #confirmButton;
  #nameElement;
  #canDelete;
  #getPreset;
  #onConfirm;
  #dismissal;
  #preset = null;
  #listeners = [];

  constructor({ document, window, trigger, popup, cancelButton, confirmButton, nameElement,
    onConfirm, canDelete, getPreset } = {}) {
    if (typeof document?.addEventListener !== 'function' || typeof window?.addEventListener !== 'function'
      || [trigger, popup, cancelButton, confirmButton].some(element => typeof element?.addEventListener !== 'function')
      || typeof popup.showPopover !== 'function' || typeof popup.hidePopover !== 'function'
      || typeof popup.style?.setProperty !== 'function' || !nameElement
      || [onConfirm, canDelete, getPreset].some(callback => typeof callback !== 'function')) {
      throw new TypeError('PresetDeleteConfirmation requires popup controls and preset callbacks.');
    }
    this.#document = document;
    this.#window = window;
    this.#trigger = trigger;
    this.#popup = popup;
    this.#cancelButton = cancelButton;
    this.#confirmButton = confirmButton;
    this.#nameElement = nameElement;
    this.#canDelete = canDelete;
    this.#getPreset = getPreset;
    this.#onConfirm = onConfirm;
    this.#dismissal = new OutsideDismissal({ document,
      surface: () => popup.matches(':popover-open') ? popup : null,
      onDismiss: () => this.close(),
    });
    this.#listen(trigger, 'click', () => this.open());
    this.#listen(cancelButton, 'click', () => this.close({ restoreFocus: true }));
    this.#listen(confirmButton, 'click', () => {
      if (!this.#validConfirmation()) { this.close(); return; }
      const id = this.#preset.id;
      this.close();
      this.#onConfirm(id);
    });
    for (const button of [trigger, confirmButton]) {
      this.#listen(button, 'keydown', event => {
        if (event.repeat && (event.key === 'Enter' || event.key === ' ')) event.preventDefault();
      });
    }
    this.#listen(document, 'keydown', event => {
      if (event.key !== 'Escape' || !popup.matches(':popover-open')) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      this.close({ restoreFocus: true });
    }, true);
    this.#listen(popup, 'toggle', () => {
      if (!popup.matches(':popover-open')) this.#clear();
    });
    this.#listen(window, 'resize', () => {
      if (popup.matches(':popover-open')) this.#position();
    });
    this.#listen(window, 'blur', () => this.close());
    this.#listen(document, 'visibilitychange', () => { if (document.hidden) this.close(); });
  }

  open() {
    if (this.#popup.matches(':popover-open') || !this.#available()) return;
    const preset = this.#getPreset();
    if (typeof preset?.id !== 'string' || !preset.id || typeof preset.name !== 'string') {
      throw new TypeError('PresetDeleteConfirmation requires a selected preset with an id and name.');
    }
    this.#preset = { id: preset.id, name: preset.name };
    this.#nameElement.textContent = preset.name;
    this.#confirmButton.setAttribute('aria-label', `delete ${preset.name}`);
    this.#trigger.setAttribute('aria-expanded', 'true');
    this.#trigger.classList.toggle('is-confirming', true);
    this.#popup.showPopover();
    this.#position();
    this.#cancelButton.focus({ preventScroll: true });
  }

  /** A changed selection or policy must never leave an old confirmation active. */
  render() {
    if (this.#preset && !this.#validConfirmation()) this.close();
  }

  close({ restoreFocus = false } = {}) {
    const wasOpen = this.#popup.matches(':popover-open');
    this.#clear();
    if (wasOpen) this.#popup.hidePopover();
    if (wasOpen && restoreFocus && !this.#trigger.matches(':disabled')) {
      this.#trigger.focus({ preventScroll: true });
    }
  }

  dispose() {
    this.close();
    this.#dismissal.dispose();
    for (const remove of this.#listeners) remove();
    this.#listeners = [];
  }

  #clear() {
    this.#preset = null;
    this.#trigger.setAttribute('aria-expanded', 'false');
    this.#trigger.classList.toggle('is-confirming', false);
  }

  #available() {
    return !this.#document.hidden && !this.#trigger.matches(':disabled') && this.#canDelete();
  }

  #validConfirmation() {
    const selected = this.#getPreset();
    return this.#preset !== null && this.#popup.matches(':popover-open') && this.#available()
      && selected?.id === this.#preset.id && selected.name === this.#preset.name;
  }

  #position() {
    const popup = this.#popup, anchor = this.#trigger.getBoundingClientRect();
    const viewport = this.#window.visualViewport;
    const bounds = { left: viewport?.offsetLeft ?? 0, top: viewport?.offsetTop ?? 0,
      width: viewport?.width ?? this.#window.innerWidth, height: viewport?.height ?? this.#window.innerHeight };
    const width = popup.offsetWidth, height = popup.offsetHeight;
    const left = Math.max(bounds.left + 12, Math.min(anchor.left + anchor.width - width, bounds.left + bounds.width - width - 12));
    const top = Math.max(bounds.top + 12, Math.min(anchor.top, bounds.top + bounds.height - height - 12));
    popup.style.left = `${left}px`;
    popup.style.top = `${top}px`;
    popup.style.setProperty('--delete-origin-x', `${anchor.left - left}px`);
    popup.style.setProperty('--delete-origin-y', `${anchor.top - top}px`);
    popup.style.setProperty('--delete-scale-x', String(anchor.width / width));
    popup.style.setProperty('--delete-scale-y', String(anchor.height / height));
  }

  #listen(target, type, listener, options) {
    target.addEventListener(type, listener, options);
    this.#listeners.push(() => target.removeEventListener(type, listener, options));
  }
}
