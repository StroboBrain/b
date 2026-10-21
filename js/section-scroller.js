const MOBILE_QUERY = '(max-width: 760px), (hover: none) and (pointer: coarse)';
const SWIPE_THRESHOLD_PX = 96;
const TRANSITION_MS = 600;
const SECTION_SELECTOR = '.practice-primary, .display-options, .settings-card, .install-footer';

/** Advance one section after a deliberate gesture; tall sections retain native scrolling. */
export class SectionScroller {
  #document;
  #window;
  #mobile;
  #reducedMotion;
  #gesture = null;
  #pointerReady = false;
  #wheel = null;
  #wheelTimer;
  #animation = null;
  #listeners = [];

  constructor({ document = globalThis.document, window = globalThis.window } = {}) {
    if (typeof document?.addEventListener !== 'function' || typeof document.removeEventListener !== 'function'
      || typeof document.querySelectorAll !== 'function' || typeof document.querySelector !== 'function'
      || !document.documentElement?.dataset || typeof window?.matchMedia !== 'function'
      || typeof window.requestAnimationFrame !== 'function' || typeof window.cancelAnimationFrame !== 'function'
      || typeof window.scrollTo !== 'function' || typeof window.setTimeout !== 'function'
      || typeof window.clearTimeout !== 'function' || typeof window.performance?.now !== 'function'
      || typeof window.addEventListener !== 'function' || typeof window.removeEventListener !== 'function') {
      throw new TypeError('SectionScroller requires a document, viewport, animation clock and scrolling window.');
    }
    this.#document = document;
    this.#window = window;
    this.#mobile = window.matchMedia(MOBILE_QUERY);
    this.#reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

    // Popup dismissal captures and consumes pointerdown first. Such a gesture
    // never arms this tracker, even when its touchstart follows popup closure.
    this.#listen(document, 'pointerdown', event => {
      this.#interrupt();
      this.#pointerReady = event.pointerType === 'touch' && !event.defaultPrevented
        && this.#canNavigate() && !this.#excludedTarget(event.target);
    }, true);
    this.#listen(document, 'touchstart', event => {
      if (!this.#pointerReady || event.touches.length !== 1 || !this.#canNavigate()) {
        this.#interrupt();
        return;
      }
      this.#pointerReady = false;
      const { clientX: x, clientY: y } = event.touches[0];
      this.#gesture = { ...this.#origin(), x, y, lastX: x, lastY: y };
    }, { passive: true });
    this.#listen(document, 'touchmove', event => {
      if (!this.#gesture) return;
      if (event.touches.length !== 1) { this.#interrupt(); return; }
      this.#gesture.lastX = event.touches[0].clientX;
      this.#gesture.lastY = event.touches[0].clientY;
    }, { passive: true });
    this.#listen(document, 'touchend', event => {
      const gesture = this.#gesture;
      this.#gesture = null;
      if (!gesture || !this.#canNavigate()) return;
      const touch = event.changedTouches?.[0];
      const delta = gesture.y - (touch?.clientY ?? gesture.lastY);
      const sideways = Math.abs(gesture.x - (touch?.clientX ?? gesture.lastX));
      if (Math.abs(delta) < 8 || sideways >= Math.abs(delta)) return;
      const target = this.#destination(gesture, delta);
      if (target === null) return;
      // Stop the release from producing a click or continuing a native fling.
      if (event.cancelable) event.preventDefault();
      this.#animate(target);
    }, { passive: false });
    this.#listen(document, 'touchcancel', () => this.#interrupt(), { passive: true });
    this.#listen(document, 'wheel', event => this.#onWheel(event), { passive: true });
    this.#listen(document, 'keydown', () => this.#interrupt(), true);
    this.#listen(document, 'visibilitychange', () => { if (document.hidden) this.#interrupt(); });
    this.#listen(window, 'resize', () => this.#interrupt());
    this.#listen(window, 'blur', () => this.#interrupt());
    if (window.visualViewport?.addEventListener) this.#listen(window.visualViewport, 'resize', () => this.#interrupt());
  }

  dispose() {
    this.#interrupt();
    for (const remove of this.#listeners) remove();
    this.#listeners = [];
  }

  #excludedTarget(target) {
    return Boolean(target?.closest?.('input, select, textarea, [contenteditable="true"], .duration-picker, dialog, .notification'));
  }

  #canNavigate() {
    const active = this.#document.activeElement;
    const editing = active?.isContentEditable || active?.tagName === 'TEXTAREA'
      || (active?.tagName === 'INPUT' && !['checkbox', 'radio', 'range', 'button', 'submit', 'reset'].includes(active.type));
    return this.#mobile.matches && !this.#document.hidden && !editing
      && !this.#document.body.classList.contains('is-zen')
      && (this.#window.visualViewport?.scale ?? 1) === 1
      && !this.#document.querySelector(':popover-open, dialog[open]');
  }

  #origin() {
    const scroll = this.#window.scrollY;
    const height = this.#window.innerHeight;
    const maximum = Math.max(0, this.#document.documentElement.scrollHeight - height);
    const sections = [];
    for (const element of this.#document.querySelectorAll(SECTION_SELECTOR)) {
      const rect = element.getBoundingClientRect();
      const top = rect.top + scroll;
      const footer = element.classList.contains('install-footer');
      const target = Math.max(0, Math.min(maximum, footer ? top + rect.height - height + 16
        : top - (element.classList.contains('practice-primary') ? 12 : 8)));
      if (sections.some(section => Math.abs(section.target - target) < 1)) continue;
      sections.push({ target, height: rect.height, end: Math.min(maximum, Math.max(target, top + rect.height - height + 8)) });
    }
    let index = 0;
    for (let i = 0; i < sections.length; i++) {
      const section = sections[i];
      if (section.height > height && scroll >= section.target - 2 && scroll <= section.end + 2) {
        index = i;
        break;
      }
      if (Math.abs(section.target - scroll) < Math.abs(sections[index].target - scroll)) index = i;
    }
    return { scroll, sections, index };
  }

  #destination({ scroll, sections, index }, delta) {
    const section = sections[index];
    if (!section) return null;
    const direction = Math.sign(delta);
    if (section.height > this.#window.innerHeight) {
      const atEdge = direction > 0 ? scroll >= section.end - 2 : scroll <= section.target + 2;
      if (!atEdge || Math.abs(delta) < SWIPE_THRESHOLD_PX) return null;
    }
    if (Math.abs(delta) < SWIPE_THRESHOLD_PX) return section.target;
    const next = sections[index + direction];
    if (!next) return null;
    // Enter an oversized section from the edge the user approached.
    return direction < 0 && next.height > this.#window.innerHeight ? next.end : next.target;
  }

  #onWheel(event) {
    if (event.ctrlKey || Math.abs(event.deltaX) >= Math.abs(event.deltaY)
      || !this.#canNavigate() || this.#excludedTarget(event.target)) return;
    this.#cancelAnimation();
    const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? this.#window.innerHeight : 1);
    if (!this.#wheel || Math.sign(this.#wheel.delta) !== Math.sign(delta)) this.#wheel = { ...this.#origin(), delta: 0 };
    this.#wheel.delta += delta;
    this.#window.clearTimeout(this.#wheelTimer);
    this.#wheelTimer = this.#window.setTimeout(() => {
      const gesture = this.#wheel;
      this.#wheel = null;
      if (!gesture || !this.#canNavigate()) return;
      const target = this.#destination(gesture, gesture.delta);
      if (target !== null) this.#animate(target);
    }, 120);
  }

  #animate(target) {
    this.#cancelAnimation();
    const from = this.#window.scrollY;
    if (this.#reducedMotion.matches || Math.abs(target - from) < 1) {
      this.#window.scrollTo({ top: target, behavior: 'instant' });
      return;
    }
    const animation = { from, target, start: this.#window.performance.now(), frame: null };
    this.#animation = animation;
    this.#document.documentElement.dataset.sectionScrolling = 'true';
    const tick = now => {
      if (this.#animation !== animation) return;
      if (!this.#canNavigate()) { this.#cancelAnimation(); return; }
      const progress = Math.min(1, Math.max(0, (now - animation.start) / TRANSITION_MS));
      const eased = (1 - Math.cos(Math.PI * progress)) / 2;
      this.#window.scrollTo({ top: from + (target - from) * eased, behavior: 'instant' });
      if (progress < 1) animation.frame = this.#window.requestAnimationFrame(tick);
      else this.#cancelAnimation();
    };
    animation.frame = this.#window.requestAnimationFrame(tick);
  }

  #cancelAnimation() {
    if (this.#animation) this.#window.cancelAnimationFrame(this.#animation.frame);
    this.#animation = null;
    delete this.#document.documentElement.dataset.sectionScrolling;
  }

  #interrupt() {
    this.#cancelAnimation();
    this.#gesture = null;
    this.#pointerReady = false;
    this.#wheel = null;
    this.#window.clearTimeout(this.#wheelTimer);
  }

  #listen(target, type, listener, options) {
    target.addEventListener(type, listener, options);
    this.#listeners.push(() => target.removeEventListener(type, listener, options));
  }
}
