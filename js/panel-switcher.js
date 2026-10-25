const SWIPE_DISTANCE_PX = 48;
const DIRECTION_RATIO = 1.3;
const SLIDE_DURATION_MS = 900;
const PANEL_NAMES = Object.freeze(['timing', 'settings']);

/** Two interchangeable control panels beneath one persistent breathing stage.
 * Horizontal gestures swap in either direction; vertical scrolling and pinch
 * zoom stay native. A consumed popup dismissal cannot also start a swipe.
 */
export class PanelSwitcher {
  #document;
  #window;
  #root;
  #panels;
  #tabs;
  #onChange;
  #canSwitch;
  #active = 'timing';
  #pointerReady = false;
  #gesture = null;
  #suppressClick = false;
  #disposed = false;
  #motion = null;
  #motionTimer;
  #reducedMotion;
  #stateObserver;
  #listeners = [];

  constructor({ document = globalThis.document, window = globalThis.window,
    onChange = () => {}, canSwitch = () => true } = {}) {
    if (typeof document?.addEventListener !== 'function' || typeof document.removeEventListener !== 'function'
      || typeof document.getElementById !== 'function' || typeof document.querySelector !== 'function'
      || typeof window?.addEventListener !== 'function' || typeof window.removeEventListener !== 'function'
      || typeof window.matchMedia !== 'function' || typeof window.getComputedStyle !== 'function'
      || typeof window.setTimeout !== 'function' || typeof window.clearTimeout !== 'function'
      || typeof onChange !== 'function' || typeof canSwitch !== 'function') {
      throw new TypeError('PanelSwitcher requires a document, window and switching callbacks.');
    }
    this.#document = document;
    this.#window = window;
    this.#onChange = onChange;
    this.#canSwitch = canSwitch;
    this.#root = document.getElementById('practice');
    this.#panels = { timing: document.getElementById('timing-panel'), settings: document.getElementById('display-settings') };
    this.#tabs = { timing: document.getElementById('timing-tab'), settings: document.getElementById('settings-tab') };
    if (!this.#root?.dataset || typeof this.#root.contains !== 'function'
      || Object.values(this.#panels).some(element => !element?.dataset
        || !('hidden' in element) || typeof element.setAttribute !== 'function' || typeof element.removeAttribute !== 'function')
      || Object.values(this.#tabs).some(tab => typeof tab?.addEventListener !== 'function'
        || typeof tab.removeEventListener !== 'function' || typeof tab.setAttribute !== 'function' || typeof tab.focus !== 'function')) {
      throw new TypeError('PanelSwitcher requires the practice root, both panels and tabs.');
    }
    this.#reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

    for (const name of PANEL_NAMES) {
      this.#listen(this.#tabs[name], 'click', () => this.show(name));
      this.#listen(this.#tabs[name], 'keydown', event => {
        const destination = event.key === 'Home' ? 'timing' : event.key === 'End' ? 'settings'
          : ['ArrowLeft', 'ArrowRight'].includes(event.key) ? this.#otherPanel() : null;
        if (!destination || !this.#available()) return;
        event.preventDefault();
        this.show(destination, { direction: event.key === 'ArrowLeft' ? 'left'
          : event.key === 'ArrowRight' ? 'right' : undefined });
        this.#tabs[destination].focus({ preventScroll: true });
      });
    }
    this.#listen(document, 'pointerdown', event => {
      this.#suppressClick = false;
      this.#pointerReady = event.pointerType === 'touch' && event.isPrimary !== false
        && !event.defaultPrevented && this.#available() && this.#root.contains(event.target)
        && !this.#excludedTarget(event.target);
      if (!this.#pointerReady) this.#gesture = null;
    }, true);
    this.#listen(document, 'touchstart', event => {
      const ready = this.#pointerReady;
      this.#pointerReady = false;
      this.#gesture = null;
      if (!ready || event.defaultPrevented || event.touches.length !== 1 || !this.#available()) return;
      const touch = event.touches[0];
      this.#gesture = { id: touch.identifier, x: touch.clientX, y: touch.clientY,
        lastX: touch.clientX, lastY: touch.clientY, axis: null };
    }, { passive: true });
    this.#listen(document, 'touchmove', event => {
      const gesture = this.#gesture;
      if (!gesture) return;
      if (event.touches.length !== 1 || !this.#available()) { this.#cancel(); return; }
      const touch = event.touches[0];
      if (touch.identifier !== gesture.id) { this.#cancel(); return; }
      gesture.lastX = touch.clientX;
      gesture.lastY = touch.clientY;
      const horizontal = Math.abs(touch.clientX - gesture.x), vertical = Math.abs(touch.clientY - gesture.y);
      if (gesture.axis === null && Math.max(horizontal, vertical) >= 10) {
        if (horizontal > vertical * DIRECTION_RATIO) gesture.axis = 'horizontal';
        else if (vertical >= horizontal) gesture.axis = 'vertical';
      }
      if (gesture.axis === 'vertical') { this.#cancel(); return; }
      if (gesture.axis === 'horizontal' && event.cancelable) event.preventDefault();
    }, { passive: false });
    this.#listen(document, 'touchend', event => {
      const gesture = this.#gesture;
      this.#cancel();
      if (!gesture || event.touches.length || !this.#available()) return;
      const touch = [...(event.changedTouches ?? [])].find(item => item.identifier === gesture.id);
      const deltaX = (touch?.clientX ?? gesture.lastX) - gesture.x;
      const horizontal = Math.abs(deltaX);
      const vertical = Math.abs((touch?.clientY ?? gesture.lastY) - gesture.y);
      if (gesture.axis === 'vertical' || horizontal < SWIPE_DISTANCE_PX || horizontal <= vertical * DIRECTION_RATIO) return;
      if (this.show(this.#otherPanel(), { direction: deltaX < 0 ? 'left' : 'right' })) {
        this.#suppressClick = true;
        if (event.cancelable) event.preventDefault();
      }
    }, { passive: false });
    for (const type of ['touchcancel', 'pointercancel']) this.#listen(document, type, () => this.#cancel(), true);
    this.#listen(document, 'click', event => {
      if (!this.#suppressClick || event.detail === 0) return;
      this.#suppressClick = false;
      event.preventDefault();
      event.stopImmediatePropagation();
    }, true);
    this.#listen(this.#root, 'animationend', event => {
      if (event.animationName && event.animationName !== this.#motion?.animationName) return;
      if (!this.#motion?.pending.delete(event.target)) return;
      if (this.#motion.pending.size === 0) this.#finishMotion();
    });
    this.#listen(document, 'visibilitychange', () => { if (document.hidden) this.#interrupt(); });
    for (const type of ['blur', 'resize', 'pagehide']) this.#listen(window, type, () => this.#interrupt());
    if (typeof window.visualViewport?.addEventListener === 'function') {
      this.#listen(window.visualViewport, 'resize', () => this.#interrupt());
    }
    if (typeof this.#reducedMotion.addEventListener === 'function') {
      this.#listen(this.#reducedMotion, 'change', () => { if (this.#reducedMotion.matches) this.#interrupt(); });
    }
    if (typeof window.MutationObserver === 'function') {
      this.#stateObserver = new window.MutationObserver(() => {
        if (!this.#available()) this.#interrupt();
      });
      this.#stateObserver.observe(this.#root, { attributes: true, attributeFilter: ['data-state'] });
      this.#stateObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    }
    this.#render();
  }

  get active() { return this.#active; }

  /** Returns whether a different panel became active. */
  show(name, { direction = name === 'settings' ? 'left' : 'right' } = {}) {
    if (!PANEL_NAMES.includes(name)) throw new RangeError('Choose the timing or settings panel.');
    if (!['left', 'right'].includes(direction)) throw new RangeError('Choose a left or right slide direction.');
    if (!this.#available()) { this.#interrupt(); return false; }
    if (this.#active === name) return false;
    this.#finishMotion();
    const previous = this.#active;
    const focus = this.#document.activeElement;
    const focusWillHide = this.#panels[previous].contains?.(focus);
    this.#active = name;
    this.#cancel();
    const duration = this.#slideDuration();
    if (!this.#reducedMotion.matches && duration > 0) {
      this.#motion = { outgoing: previous, animationName: `panel-enter-${direction}`,
        pending: new Set([this.#panels[name]]) };
      this.#root.dataset.panelMotion = direction;
      // animationend completes normal transitions; this also settles hidden
      // documents or styles that no longer produce an animation event.
      this.#motionTimer = this.#window.setTimeout(() => this.#finishMotion(), duration + 80);
    }
    this.#render();
    if (focusWillHide) this.#tabs[name].focus({ preventScroll: true });
    this.#onChange(name);
    return true;
  }

  dispose() {
    this.#disposed = true;
    this.#interrupt();
    this.#stateObserver?.disconnect();
    this.#suppressClick = false;
    for (const remove of this.#listeners) remove();
    this.#listeners = [];
  }

  #otherPanel() { return this.#active === 'timing' ? 'settings' : 'timing'; }

  #available() {
    return !this.#disposed && !this.#document.hidden && !this.#document.body?.classList.contains('is-zen')
      && (this.#window.visualViewport?.scale ?? 1) === 1 && this.#canSwitch();
  }

  #excludedTarget(target) {
    return Boolean(target?.closest?.('input, select, textarea, [contenteditable="true"], .duration-picker, [popover], dialog, .notification')
      || this.#document.querySelector(':popover-open, dialog[open]'));
  }

  #render() {
    this.#root.dataset.activePanel = this.#active;
    for (const name of PANEL_NAMES) {
      const selected = name === this.#active;
      const element = this.#panels[name];
      element.hidden = !selected && this.#motion?.outgoing !== name;
      element.inert = !selected;
      if (selected) element.removeAttribute('aria-hidden');
      else element.setAttribute('aria-hidden', 'true');
      if (this.#motion) element.dataset.panelSlide = selected ? 'incoming' : 'outgoing';
      else delete element.dataset.panelSlide;
      this.#tabs[name].setAttribute('aria-selected', String(selected));
      this.#tabs[name].tabIndex = selected ? 0 : -1;
    }
  }

  #cancel() { this.#gesture = null; this.#pointerReady = false; }

  #slideDuration() {
    const value = this.#window.getComputedStyle(this.#root).getPropertyValue('--panel-slide-duration').trim();
    const match = /^(\d+(?:\.\d+)?|\.\d+)(ms|s)$/.exec(value);
    return match ? Number(match[1]) * (match[2] === 's' ? 1000 : 1) : SLIDE_DURATION_MS;
  }

  #finishMotion() {
    if (!this.#motion) return;
    this.#window.clearTimeout(this.#motionTimer);
    this.#motion = null;
    delete this.#root.dataset.panelMotion;
    this.#render();
  }

  #interrupt() { this.#cancel(); this.#finishMotion(); }

  #listen(target, type, listener, options) {
    target.addEventListener(type, listener, options);
    this.#listeners.push(() => target.removeEventListener(type, listener, options));
  }
}
