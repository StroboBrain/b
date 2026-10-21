const HOLD_DURATION_MS = 3000;
const RAPID_CLICK_WINDOW_MS = 1000;
const TRAILING_CLICK_WINDOW_MS = 800;

/** Delete one selected preset only after an uninterrupted pointer or keyboard hold. */
export class PresetDeleteHold {
  #document;
  #window;
  #button;
  #onConfirm;
  #onHint;
  #canDelete;
  #hold = null;
  #completion = null;
  #rapidClicks = [];
  #listeners = [];

  constructor({ document, window, button, onConfirm, onHint, canDelete = () => true } = {}) {
    if (typeof document?.addEventListener !== 'function' || typeof window?.addEventListener !== 'function'
      || typeof window.setTimeout !== 'function' || typeof window.clearTimeout !== 'function'
      || typeof button?.addEventListener !== 'function' || typeof button.style?.setProperty !== 'function'
      || typeof button.classList?.toggle !== 'function'
      || [onConfirm, onHint, canDelete].some((callback) => typeof callback !== 'function')) {
      throw new TypeError('PresetDeleteHold requires a document, window, button and deletion callbacks.');
    }
    this.#document = document;
    this.#window = window;
    this.#button = button;
    this.#onConfirm = onConfirm;
    this.#onHint = onHint;
    this.#canDelete = canDelete;
    button.style.setProperty('--preset-delete-hold-duration', `${HOLD_DURATION_MS}ms`);

    this.#listen(button, 'pointerdown', (event) => {
      if (event.button !== 0 || event.isPrimary === false) return;
      event.preventDefault();
      button.focus({ preventScroll: true });
      if (this.#start({ pointerId: event.pointerId })) button.setPointerCapture?.(event.pointerId);
    });
    this.#listen(button, 'pointermove', (event) => {
      if (this.#hold?.pointerId !== event.pointerId) return;
      const rect = button.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.left + rect.width
        || event.clientY < rect.top || event.clientY > rect.top + rect.height) this.cancel();
    });
    this.#listen(button, 'pointerleave', (event) => {
      if (this.#hold?.pointerId === event.pointerId) this.cancel();
    });
    this.#listen(button, 'lostpointercapture', (event) => {
      if (this.#hold?.pointerId === event.pointerId) this.cancel();
    });
    this.#listen(document, 'pointerup', (event) => this.#releasePointer(event), true);
    this.#listen(document, 'pointercancel', (event) => this.#releasePointer(event, true), true);

    this.#listen(button, 'keydown', (event) => {
      if (![' ', 'Enter'].includes(event.key) || event.altKey || event.ctrlKey || event.metaKey) return;
      event.preventDefault();
      if (!event.repeat) this.#start({ key: event.key });
    });
    this.#listen(document, 'keydown', (event) => {
      if (this.#completion?.key === event.key) this.#consume(event);
    }, true);
    this.#listen(document, 'keyup', (event) => {
      if (this.#completion?.key === event.key) {
        this.#consume(event);
        this.#awaitTrailingClick();
      } else if (this.#hold?.key === event.key) {
        event.preventDefault();
        this.cancel();
      }
    }, true);

    // A completed hold can change focus or disable this button. Consume its final
    // release and click before either reaches the newly selected UI element.
    this.#listen(document, 'click', (event) => {
      const completion = this.#completion;
      if (!completion) return;
      if (completion.key !== undefined && event.detail !== 0) return;
      if (completion.pointerId !== undefined
        && (event.detail === 0 || (event.pointerId !== undefined && event.pointerId !== completion.pointerId))) return;
      this.#consume(event);
      this.#clearCompletion();
    }, true);
    this.#listen(button, 'click', (event) => {
      this.#consume(event);
      if (!this.#available()) return;
      const now = this.#window.performance?.now?.() ?? Date.now();
      this.#rapidClicks = this.#rapidClicks.filter((time) => now - time <= RAPID_CLICK_WINDOW_MS);
      this.#rapidClicks.push(now);
      if (this.#rapidClicks.length >= 3) {
        this.#rapidClicks = [];
        this.#onHint();
      }
    });
    this.#listen(button, 'blur', () => this.cancel());
    const interrupt = () => {
      this.cancel();
      // Browsers can omit the matching release when the whole window loses focus.
      if (this.#completion) {
        this.#releaseCapture(this.#completion);
        this.#awaitTrailingClick();
      }
    };
    this.#listen(window, 'blur', interrupt);
    this.#listen(document, 'visibilitychange', () => { if (document.hidden) interrupt(); });
  }

  /** Cancel pending deletion when selection or editing policy changes. */
  cancel() {
    const hold = this.#hold;
    this.#hold = null;
    this.#button.classList.toggle('is-holding', false);
    if (!hold) return;
    this.#window.clearTimeout(hold.timer);
    this.#releaseCapture(hold);
  }

  dispose() {
    this.cancel();
    this.#clearCompletion();
    for (const remove of this.#listeners) remove();
    this.#listeners = [];
    this.#rapidClicks = [];
  }

  #available() {
    return !this.#document.hidden && !this.#button.disabled
      && !this.#button.matches?.(':disabled') && this.#canDelete();
  }

  #start(input) {
    if (this.#hold || this.#completion || !this.#available()) return false;
    const hold = { ...input, timer: null };
    this.#hold = hold;
    this.#button.classList.toggle('is-holding', true);
    hold.timer = this.#window.setTimeout(() => {
      if (this.#hold !== hold) return;
      if (!this.#available()) { this.cancel(); return; }
      this.#hold = null;
      this.#button.classList.toggle('is-holding', false);
      this.#rapidClicks = [];
      this.#completion = { ...hold, timer: null };
      this.#onConfirm();
    }, HOLD_DURATION_MS);
    return true;
  }

  #releasePointer(event, cancelled = false) {
    if (this.#completion?.pointerId === event.pointerId) {
      this.#consume(event);
      this.#releaseCapture(this.#completion);
      if (cancelled) this.#clearCompletion();
      else this.#awaitTrailingClick();
    } else if (this.#hold?.pointerId === event.pointerId) this.cancel();
  }

  #awaitTrailingClick() {
    const completion = this.#completion;
    this.#window.clearTimeout(completion.timer);
    completion.timer = this.#window.setTimeout(() => this.#clearCompletion(), TRAILING_CLICK_WINDOW_MS);
  }

  #clearCompletion() {
    const completion = this.#completion;
    this.#completion = null;
    if (!completion) return;
    this.#window.clearTimeout(completion.timer);
    this.#releaseCapture(completion);
  }

  #releaseCapture(input) {
    if (input.pointerId !== undefined && this.#button.hasPointerCapture?.(input.pointerId)) {
      this.#button.releasePointerCapture(input.pointerId);
    }
  }

  #consume(event) {
    event.preventDefault();
    event.stopImmediatePropagation?.();
  }

  #listen(target, type, listener, options) {
    target.addEventListener(type, listener, options);
    this.#listeners.push(() => target.removeEventListener(type, listener, options));
  }
}
