const HOLD_DURATION_MS = 4000;

/** A reset requires one uninterrupted pointer or keyboard hold in the modal. */
export class ResetConfirmation {
  #document;
  #window;
  #dialog;
  #deleteButton;
  #onConfirm;
  #hold = null;
  #listeners = [];

  constructor({ document, window, dialog, cancelButton, deleteButton, onConfirm } = {}) {
    if (typeof document?.addEventListener !== 'function' || typeof window?.addEventListener !== 'function'
      || typeof window.setTimeout !== 'function' || typeof window.clearTimeout !== 'function'
      || typeof dialog?.showModal !== 'function' || typeof dialog.close !== 'function'
      || typeof cancelButton?.addEventListener !== 'function' || typeof deleteButton?.addEventListener !== 'function'
      || typeof onConfirm !== 'function') {
      throw new TypeError('ResetConfirmation requires a document, window, dialog, buttons and confirmation callback.');
    }
    this.#document = document;
    this.#window = window;
    this.#dialog = dialog;
    this.#deleteButton = deleteButton;
    this.#onConfirm = onConfirm;
    deleteButton.style.setProperty('--reset-hold-duration', `${HOLD_DURATION_MS}ms`);
    this.#listen(cancelButton, 'click', () => this.close());
    this.#listen(dialog, 'cancel', () => this.#cancelHold());
    this.#listen(dialog, 'close', () => this.#cancelHold());
    this.#listen(deleteButton, 'click', (event) => event.preventDefault());
    this.#listen(deleteButton, 'pointerdown', (event) => {
      if (event.button !== 0 || event.isPrimary === false) return;
      event.preventDefault();
      deleteButton.focus({ preventScroll: true });
      if (this.#startHold({ pointerId: event.pointerId })) deleteButton.setPointerCapture?.(event.pointerId);
    });
    this.#listen(deleteButton, 'pointermove', (event) => {
      if (this.#hold?.pointerId !== event.pointerId) return;
      const rect = deleteButton.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.left + rect.width
        || event.clientY < rect.top || event.clientY > rect.top + rect.height) this.#cancelHold();
    });
    const release = (event) => {
      if (this.#hold?.pointerId === event.pointerId) this.#cancelHold();
    };
    this.#listen(document, 'pointerup', release);
    this.#listen(document, 'pointercancel', release);
    this.#listen(deleteButton, 'lostpointercapture', release);
    this.#listen(deleteButton, 'keydown', (event) => {
      if (![' ', 'Enter'].includes(event.key) || event.altKey || event.ctrlKey || event.metaKey) return;
      event.preventDefault();
      if (!event.repeat) this.#startHold({ key: event.key });
    });
    this.#listen(deleteButton, 'keyup', (event) => {
      if (this.#hold?.key !== event.key) return;
      event.preventDefault();
      this.#cancelHold();
    });
    this.#listen(deleteButton, 'blur', () => this.#cancelHold());
    this.#listen(window, 'blur', () => this.#cancelHold());
    this.#listen(document, 'visibilitychange', () => {
      if (document.hidden) this.#cancelHold();
    });
  }

  open() {
    if (this.#dialog.open) return;
    this.#cancelHold();
    this.#dialog.showModal();
  }

  close() {
    this.#cancelHold();
    if (this.#dialog.open) this.#dialog.close();
  }

  dispose() {
    this.close();
    for (const remove of this.#listeners) remove();
    this.#listeners = [];
  }

  #startHold(input) {
    if (this.#hold || !this.#dialog.open || this.#document.hidden) return false;
    const hold = { ...input, timer: null };
    this.#hold = hold;
    this.#deleteButton.classList.toggle('is-holding', true);
    hold.timer = this.#window.setTimeout(() => {
      if (this.#hold !== hold || !this.#dialog.open || this.#document.hidden) return;
      this.close();
      this.#onConfirm();
    }, HOLD_DURATION_MS);
    return true;
  }

  #cancelHold() {
    const hold = this.#hold;
    this.#hold = null;
    this.#deleteButton.classList.toggle('is-holding', false);
    if (!hold) return;
    this.#window.clearTimeout(hold.timer);
    if (hold.pointerId !== undefined && this.#deleteButton.hasPointerCapture?.(hold.pointerId)) {
      this.#deleteButton.releasePointerCapture(hold.pointerId);
    }
  }

  #listen(target, type, listener) {
    target.addEventListener(type, listener);
    this.#listeners.push(() => target.removeEventListener(type, listener));
  }
}
