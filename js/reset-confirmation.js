import { OutsideDismissal } from './outside-dismissal.js';
import { visibleViewport } from './viewport-layout.js';

const HOLD_DURATION_MS = 3000;

/** Anchored confirmation only; its caller owns the destructive action and persistence. */
export class ResetConfirmation {
  #document;
  #window;
  #button;
  #confirmButton;
  #panel;
  #content;
  #cancelButton;
  #closedLabel;
  #onConfirm;
  #canOpen;
  #outside;
  #listeners = [];
  #disposed = false;
  #hold = null;
  #completedKey = null;
  #completedPointer = null;

  constructor({ document, window, button, panel, confirmButton, cancelButton,
    onConfirm, canOpen = () => true } = {}) {
    if ([document, window, button, panel, confirmButton, cancelButton].some(target =>
      typeof target?.addEventListener !== 'function' || typeof target.removeEventListener !== 'function')
      || typeof panel?.showPopover !== 'function' || typeof panel.hidePopover !== 'function'
      || typeof button?.getBoundingClientRect !== 'function' || typeof panel?.style?.setProperty !== 'function'
      || !Number.isFinite(window?.innerWidth) || !Number.isFinite(window?.innerHeight)
      || typeof window?.setTimeout !== 'function' || typeof window?.clearTimeout !== 'function'
      || typeof window?.performance?.now !== 'function') {
      throw new TypeError('ResetConfirmation requires a document, window, trigger, popover and action buttons.');
    }
    if (typeof onConfirm !== 'function' || typeof canOpen !== 'function') {
      throw new TypeError('ResetConfirmation requires confirmation and availability callbacks.');
    }
    const content = panel.querySelector?.('#reset-confirmation-content');
    if (!content) throw new Error('ResetConfirmation is missing its content.');
    const anchorCancel = panel.querySelector?.('#reset-anchor-cancel');
    if (typeof anchorCancel?.addEventListener !== 'function'
      || typeof anchorCancel?.removeEventListener !== 'function') {
      throw new Error('ResetConfirmation is missing its anchor cancel button.');
    }
    this.#document = document;
    this.#window = window;
    this.#button = button;
    this.#confirmButton = confirmButton;
    this.#panel = panel;
    this.#content = content;
    this.#cancelButton = cancelButton;
    this.#closedLabel = button.textContent?.trim() || 'reset all data';
    this.#onConfirm = onConfirm;
    this.#canOpen = canOpen;
    this.#outside = new OutsideDismissal({ document,
      surface: () => panel.matches(':popover-open') ? panel : null,
      onDismiss: () => this.close(),
    });
    this.#listen(button, 'click', () => this.#open());
    this.#listen(cancelButton, 'click', () => this.close());
    this.#listen(anchorCancel, 'click', () => this.close());
    // Activation is owned by the uninterrupted hold. A click (including the
    // synthetic click following a completed touch or key press) never resets.
    this.#listen(confirmButton, 'click', event => event.preventDefault?.());
    this.#listen(confirmButton, 'contextmenu', event => event.preventDefault());
    this.#listen(confirmButton, 'pointerdown', event => {
      if (event.button !== 0 || event.isPrimary === false) return;
      event.preventDefault?.();
      if (this.#startHold({ pointerId: event.pointerId, x: event.clientX, y: event.clientY })) {
        confirmButton.setPointerCapture?.(event.pointerId);
      }
    });
    this.#listen(confirmButton, 'pointerleave', () => this.#cancelHold());
    this.#listen(confirmButton, 'lostpointercapture', () => this.#cancelHold());
    this.#listen(confirmButton, 'blur', () => this.#cancelHold());
    this.#listen(document, 'pointerdown', () => {
      if (this.#completedPointer?.released) this.#completedPointer = null;
    }, true);
    this.#listen(document, 'pointermove', event => {
      const hold = this.#hold;
      if (!hold || hold.pointerId !== event.pointerId || hold.key) return;
      hold.x = event.clientX;
      hold.y = event.clientY;
      if (!this.#pointerInside(hold)) this.#cancelHold();
    });
    for (const type of ['pointerup', 'pointercancel']) {
      this.#listen(document, type, event => {
        if (this.#completedPointer?.id === event.pointerId) {
          this.#consume(event);
          if (type === 'pointercancel') this.#completedPointer = null;
          else this.#completedPointer.released = true;
          return;
        }
        if (this.#hold?.pointerId === event.pointerId) this.#cancelHold();
      }, true);
    }
    this.#listen(document, 'click', event => {
      if (!this.#completedPointer || event.detail === 0
        || event.pointerId !== undefined && event.pointerId !== this.#completedPointer.id) return;
      this.#completedPointer = null;
      this.#consume(event);
    }, true);
    this.#listen(confirmButton, 'keydown', event => {
      if (event.key !== ' ' && event.key !== 'Enter') return;
      event.preventDefault?.();
      if (!event.repeat && this.#completedKey !== event.key) this.#startHold({ key: event.key });
    });
    this.#listen(document, 'keyup', event => {
      if (this.#completedKey === event.key) {
        event.preventDefault?.();
        this.#completedKey = null;
      }
      if (this.#hold?.key === event.key) {
        event.preventDefault?.();
        this.#cancelHold();
      }
    });
    this.#listen(panel, 'toggle', () => {
      this.#syncTrigger();
      if (!panel.matches(':popover-open')) this.#cancelHold();
    });
    this.#listen(document, 'keydown', event => {
      if (this.#completedKey === event.key) event.preventDefault?.();
      if (event.key !== 'Escape' || !panel.matches(':popover-open')) return;
      event.preventDefault();
      this.close();
    });
    this.#listen(document, 'visibilitychange', () => {
      if (document.hidden) this.close({ restoreFocus: false });
    });
    this.#listen(window, 'pagehide', () => this.close({ restoreFocus: false }));
    this.#listen(window, 'blur', () => this.#cancelHold());
    const position = () => { if (panel.matches(':popover-open')) this.#position(); };
    this.#listen(window, 'resize', position);
    this.#listen(window, 'scroll', position);
    if (window.visualViewport?.addEventListener) {
      this.#listen(window.visualViewport, 'resize', position);
      this.#listen(window.visualViewport, 'scroll', position);
    }
    this.#syncTrigger();
  }

  close({ restoreFocus = true } = {}) {
    this.#cancelHold();
    if (!this.#panel.matches(':popover-open')) return;
    this.#panel.hidePopover();
    this.#syncTrigger();
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

  #listen(target, type, listener, capture = false) {
    target.addEventListener(type, listener, capture);
    this.#listeners.push(() => target.removeEventListener(type, listener, capture));
  }

  #consume(event) {
    event.preventDefault?.();
    event.stopImmediatePropagation?.();
  }

  #syncTrigger() {
    const open = Boolean(this.#panel.matches(':popover-open'));
    this.#button.setAttribute('aria-expanded', String(open));
    this.#button.textContent = open ? 'cancel' : this.#closedLabel;
  }

  #available() {
    return !this.#disposed && !this.#document.hidden && this.#panel.matches(':popover-open')
      && !this.#button.matches(':disabled') && !this.#confirmButton.matches(':disabled') && this.#canOpen()
      && (typeof this.#document.hasFocus !== 'function' || this.#document.hasFocus());
  }

  #pointerInside(hold) {
    if (hold.key) return true;
    const box = this.#confirmButton.getBoundingClientRect();
    if (!Number.isFinite(hold.x) || !Number.isFinite(hold.y)
      || hold.x < box.left || hold.x >= box.left + box.width
      || hold.y < box.top || hold.y >= box.top + box.height) return false;
    if (typeof this.#document.elementFromPoint !== 'function') return true;
    const hit = this.#document.elementFromPoint(hold.x, hold.y);
    return hit === this.#confirmButton || Boolean(this.#confirmButton.contains?.(hit));
  }

  #startHold(input) {
    if (this.#hold) return false;
    if (!this.#available()) {
      if (this.#panel.matches(':popover-open')) this.close({ restoreFocus: false });
      return false;
    }
    const hold = { ...input, started: this.#window.performance.now(), timer: null };
    this.#hold = hold;
    this.#confirmButton.style.setProperty('--reset-hold-duration', `${HOLD_DURATION_MS}ms`);
    this.#confirmButton.dataset.holding = 'true';
    const finish = () => {
      if (this.#hold !== hold) return;
      if (!this.#available()) {
        this.close({ restoreFocus: false });
        return;
      }
      // Captured pointers may remain stationary while the expanding panel or
      // viewport moves the action away. Recheck its actual hit area at completion.
      if (!this.#pointerInside(hold)) {
        this.#cancelHold();
        return;
      }
      const remaining = HOLD_DURATION_MS - (this.#window.performance.now() - hold.started);
      // A timer is only a wake-up request; elapsed monotonic time authorizes the reset.
      if (remaining > 0) {
        hold.timer = this.#window.setTimeout(finish, remaining);
        return;
      }
      this.#completedKey = hold.key ?? null;
      if (hold.pointerId !== undefined) this.#completedPointer = { id: hold.pointerId, released: false };
      this.#cancelHold();
      if (this.#onConfirm() === true) this.close();
    };
    hold.timer = this.#window.setTimeout(finish, HOLD_DURATION_MS);
    return true;
  }

  #cancelHold() {
    const hold = this.#hold;
    this.#hold = null;
    delete this.#confirmButton.dataset.holding;
    if (!hold) return;
    this.#window.clearTimeout(hold.timer);
    if (hold.pointerId !== undefined && this.#confirmButton.hasPointerCapture?.(hold.pointerId)) {
      this.#confirmButton.releasePointerCapture(hold.pointerId);
    }
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
    this.#syncTrigger();
    this.#position();
    this.#cancelButton.focus({ preventScroll: true });
  }

  #position() {
    const anchor = this.#button.getBoundingClientRect();
    const viewport = visibleViewport(this.#window);
    const width = Math.min(anchor.width, Math.max(0, viewport.width - 16));
    const bottom = Math.min(anchor.top + anchor.height, viewport.top + viewport.height - 8);
    const availableHeight = Math.max(0, bottom - viewport.top - 8);
    this.#panel.style.width = `${width}px`;
    this.#panel.style.maxHeight = `${availableHeight}px`;
    this.#panel.style.left = `${Math.max(viewport.left + 8,
      Math.min(anchor.left, viewport.left + viewport.width - width - 8))}px`;
    this.#panel.style.setProperty('--reset-closed-height', `${anchor.height}px`);
    this.#panel.style.setProperty('--reset-closed-top', `${anchor.top}px`);
    // The original trigger's entire hit area becomes Cancel. Confirmation stays
    // above it so repeated taps cannot start a destructive hold.
    const contentHeight = Math.max(this.#content.scrollHeight ?? 0, this.#content.offsetHeight);
    // The content's percentage limit uses the panel's padding box, so include
    // its two 1px borders as well as the gap and top inset in the outer height.
    const height = Math.min(contentHeight + anchor.height + 22, availableHeight);
    const top = Math.max(viewport.top + 8, bottom - height);
    this.#panel.style.setProperty('--reset-open-height', `${height}px`);
    this.#panel.style.setProperty('--reset-open-top', `${top}px`);
  }
}
