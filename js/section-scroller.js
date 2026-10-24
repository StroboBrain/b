const FLICK_DISTANCE_PX = 32;
const FLICK_SPEED_PX_MS = 0.2;
const WHEEL_DISTANCE_PX = 48;
const VELOCITY_WINDOW_MS = 100;
const SETTLE_MS = 140;
const TRANSITION_MIN_MS = 850;
const TRANSITION_PAGE_MS = 1700;
const TRANSITION_MAX_MS = 2200;
const PAGE_SELECTOR = '.app-page';

/** Continuous vertical pages: flicks and threshold crossings advance a page;
 * shorter scrolls return to that page. Oversized page content stays scrollable.
 */
export class SectionScroller {
  #document;
  #window;
  #reducedMotion;
  #touchViewport;
  #viewportWidth;
  #viewportHeight;
  #gesture = null;
  #pointerReady = false;
  #pointerActive = false;
  #touchActive = false;
  #wheel = null;
  #wheelTimer;
  #pendingOrigin = null;
  #settleTimer;
  #animation = null;
  #restingPosition = null;
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
    this.#reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    this.#touchViewport = window.matchMedia('(hover: none) and (pointer: coarse)');
    this.#viewportWidth = window.innerWidth;
    this.#viewportHeight = window.innerHeight;

    // An outside-popup dismissal consumes pointerdown before it can arm a swipe.
    this.#listen(document, 'pointerdown', event => {
      const settling = Boolean(this.#animation || this.#pendingOrigin);
      this.#interrupt();
      this.#pointerActive = true;
      if (settling) this.#pendingOrigin = { ...this.#origin(), delta: 0 };
      this.#pointerReady = event.pointerType === 'touch' && !event.defaultPrevented
        && this.#canNavigate() && !this.#excludedTarget(event.target);
    }, true);
    for (const type of ['pointerup', 'pointercancel']) this.#listen(document, type, () => {
      this.#pointerActive = false;
      this.#resumeSettlement();
    }, true);
    this.#listen(document, 'touchstart', event => {
      this.#touchActive = event.touches.length > 0;
      if (!this.#pointerReady || event.touches.length !== 1 || !this.#canNavigate()) {
        this.#interrupt();
        return;
      }
      this.#pointerReady = false;
      this.#pendingOrigin = null;
      this.#window.clearTimeout(this.#settleTimer);
      const { clientX: x, clientY: y } = event.touches[0];
      this.#gesture = { ...this.#origin(), x, y, lastX: x, lastY: y,
        samples: [{ position: -y, time: this.#eventTime(event) }] };
    }, { passive: true });
    this.#listen(document, 'touchmove', event => {
      if (!this.#gesture) return;
      if (event.touches.length !== 1) { this.#interrupt(); return; }
      this.#gesture.lastX = event.touches[0].clientX;
      this.#gesture.lastY = event.touches[0].clientY;
      this.#sampleVelocity(this.#gesture.samples, -this.#gesture.lastY, this.#eventTime(event));
    }, { passive: true });
    this.#listen(document, 'touchend', event => {
      this.#touchActive = event.touches.length > 0;
      const gesture = this.#gesture;
      this.#gesture = null;
      if (!gesture || !this.#canNavigate()) { this.#resumeSettlement(); return; }
      const touch = event.changedTouches?.[0];
      const delta = gesture.y - (touch?.clientY ?? gesture.lastY);
      const sideways = Math.abs(gesture.x - (touch?.clientX ?? gesture.lastX));
      if (Math.abs(delta) < 8 || sideways >= Math.abs(delta)) { this.#settle(gesture, 0); return; }
      const velocity = this.#sampleVelocity(gesture.samples, -(touch?.clientY ?? gesture.lastY), this.#eventTime(event));
      const flick = Math.abs(delta) >= FLICK_DISTANCE_PX && Math.sign(velocity) === Math.sign(delta)
        && Math.abs(velocity) >= FLICK_SPEED_PX_MS;
      const target = this.#destination(gesture, delta, flick);
      if (target === null) { this.#settle(gesture, delta); return; }
      if (event.cancelable) event.preventDefault();
      this.#animate(target, velocity);
    }, { passive: false });
    this.#listen(document, 'touchcancel', event => {
      this.#touchActive = event.touches.length > 0;
      this.#interrupt();
    }, { passive: true });
    this.#listen(document, 'wheel', event => this.#onWheel(event), { passive: true });
    this.#listen(document, 'scroll', event => {
      // Ignore scrolling inside popups and controls. Keyboard and scrollbar
      // scrolling of the document should settle just like a swipe.
      if ((event.target !== document && event.target !== document.documentElement)
        || this.#gesture || this.#wheel || this.#animation || !this.#canNavigate()) return;
      const origin = this.#pendingOrigin ?? { ...this.#origin(), delta: 0 };
      this.#settle(origin, origin.delta);
    }, { passive: true, capture: true });
    this.#listen(document, 'keydown', () => this.#interrupt(true), true);
    this.#listen(document, 'visibilitychange', () => { if (document.hidden) this.#interrupt(true); });
    this.#listen(window, 'resize', () => this.#resize());
    this.#listen(window, 'blur', () => this.#interrupt(true));
    if (window.visualViewport?.addEventListener) this.#listen(window.visualViewport, 'resize', () => this.#resize());
    const columnLayout = window.matchMedia('(min-width: 1000px) and (hover: hover) and (pointer: fine)');
    if (typeof columnLayout.addEventListener === 'function') this.#listen(columnLayout, 'change', () => this.#resize());
    this.#rememberPageEdge();
  }

  dispose() {
    this.#interrupt(true);
    for (const remove of this.#listeners) remove();
    this.#listeners = [];
  }

  /** Explicit navigation uses the same glide as a swipe; columns stay alongside. */
  goTo(page) {
    if (![...this.#document.querySelectorAll(PAGE_SELECTOR)].includes(page)) {
      throw new RangeError('Choose an app page in this document.');
    }
    this.#interrupt(true);
    if (this.#document.hidden || this.#document.body.classList.contains('is-zen')) return;
    const maximum = Math.max(0, this.#document.documentElement.scrollHeight - this.#window.innerHeight);
    const target = Math.max(0, Math.min(maximum, page.getBoundingClientRect().top + this.#window.scrollY - 8));
    if (this.#hasColumns()) this.#window.scrollTo({ top: target, behavior: 'instant' });
    else this.#animate(target);
  }

  #hasColumns() {
    const [first, second] = [...this.#document.querySelectorAll(PAGE_SELECTOR)].map(page => page.getBoundingClientRect());
    return first && second && Math.abs(first.top - second.top) < 1
      && second.left >= first.left + first.width - 1;
  }

  #excludedTarget(target) {
    return Boolean(target?.closest?.('input, select, textarea, [contenteditable="true"], .duration-picker, [popover], dialog, .notification'));
  }

  #eventTime(event) {
    // Native timestamps preserve the user's gesture speed when event delivery is delayed.
    return Number.isFinite(event.timeStamp) ? event.timeStamp : this.#window.performance.now();
  }

  #sampleVelocity(samples, position, time) {
    const previous = samples.at(-1);
    if (time < previous.time) return 0;
    if (time === previous.time) previous.position = position;
    else samples.push({ position, time });
    const cutoff = time - VELOCITY_WINDOW_MS;
    while (samples.length > 2 && samples[1].time <= cutoff) samples.shift();
    const first = samples[0], next = samples[1];
    const start = Math.max(first.time, cutoff);
    // Interpolate the window's leading edge so event frequency cannot change
    // the measured strength. A pause before release naturally reduces it to zero.
    const from = next && start > first.time
      ? first.position + (next.position - first.position) * (start - first.time) / (next.time - first.time)
      : first.position;
    return (position - from) / Math.max(16, time - start);
  }

  #resize() {
    const width = this.#window.innerWidth, height = this.#window.innerHeight;
    if (!this.#canNavigate()) { this.#interrupt(); return; }
    if (width === this.#viewportWidth && height === this.#viewportHeight) return;
    // Browser toolbar changes must not interrupt an active swipe or glide.
    const toolbar = this.#touchViewport.matches && width === this.#viewportWidth
      && Math.abs(height - this.#viewportHeight) <= 160;
    const resting = this.#restingPosition;
    const idle = !this.#gesture && !this.#wheel && !this.#animation && !this.#pointerActive && !this.#touchActive;
    const preservePage = resting && Math.abs(this.#window.scrollY - resting.scroll) < 1
      && idle;
    this.#viewportWidth = width;
    this.#viewportHeight = height;
    if (!toolbar) this.#interrupt(true);
    if (preservePage) {
      // Flexible page contents can move the page boundary after a resize. Keep
      // an unchanged, completed landing at its new boundary without a glide.
      const page = this.#origin().pages.find(page => page.element === resting.element);
      if (page) {
        this.#interrupt(true);
        this.#window.scrollTo({ top: page[resting.edge], behavior: 'instant' });
        this.#rememberPageEdge();
      }
    } else if (idle) {
      // Chrome can clamp scrollY to the shorter document before delivering
      // resize. Remember that new landing before another resize can follow.
      this.#rememberPageEdge();
    }
  }

  #rememberPageEdge() {
    const { pages, index } = this.#origin();
    const page = pages[index], scroll = this.#window.scrollY;
    const edge = page && Math.abs(scroll - page.start) < 1 ? 'start'
      : page && Math.abs(scroll - page.end) < 1 ? 'end' : null;
    this.#restingPosition = edge ? { element: page.element, edge, scroll } : null;
  }

  #canNavigate(checkLayout = true) {
    const active = this.#document.activeElement;
    const editing = active?.isContentEditable || active?.tagName === 'TEXTAREA'
      || (active?.tagName === 'INPUT' && !['checkbox', 'radio', 'range', 'button', 'submit', 'reset'].includes(active.type));
    return !this.#document.hidden && !editing && (!checkLayout || !this.#hasColumns()) && !this.#document.body.classList.contains('is-zen')
      && (this.#window.visualViewport?.scale ?? 1) === 1
      && !this.#document.querySelector(':popover-open, dialog[open]');
  }

  #origin() {
    const scroll = this.#window.scrollY;
    const height = this.#window.innerHeight;
    const maximum = Math.max(0, this.#document.documentElement.scrollHeight - height);
    const pages = [];
    for (const element of this.#document.querySelectorAll(PAGE_SELECTOR)) {
      const rect = element.getBoundingClientRect();
      if (rect.height <= 0) continue;
      const top = rect.top + scroll;
      const start = pages.length === 0 ? 0 : Math.max(0, Math.min(maximum, top - 8));
      const end = rect.height > height + 1 ? Math.min(maximum, Math.max(start, top + rect.height - height + 8)) : start;
      pages.push({ element, start, end });
    }
    let index = 0, nearest = Infinity;
    for (let i = 0; i < pages.length; i++) {
      const distance = Math.max(pages[i].start - scroll, scroll - pages[i].end, 0);
      if (distance < nearest) { index = i; nearest = distance; }
    }
    return { pages, index };
  }

  #destination({ pages, index }, delta, flick = false) {
    const direction = Math.sign(delta);
    const current = pages[index], next = pages[index + direction];
    if (!current || !next || !direction) return null;
    const gap = direction > 0 ? next.start - current.end : current.start - next.end;
    const threshold = Math.min(gap * 0.35, Math.max(36, Math.min(80, this.#window.innerHeight * 0.1)));
    const progress = direction > 0 ? this.#window.scrollY - current.end : current.start - this.#window.scrollY;
    if (!flick && progress < threshold) return null;
    return direction > 0 ? next.start : next.end;
  }

  #settle(origin, delta) {
    this.#pendingOrigin = { ...origin, delta };
    this.#window.clearTimeout(this.#settleTimer);
    // Never fight a finger or a held scrollbar while it is still moving.
    if (this.#pointerActive || this.#touchActive) return;
    this.#settleTimer = this.#window.setTimeout(() => {
      const pending = this.#pendingOrigin;
      this.#pendingOrigin = null;
      if (!pending || !this.#canNavigate()) return;
      const current = pending.pages[pending.index];
      const target = this.#destination(pending, pending.delta)
        ?? (current ? Math.max(current.start, Math.min(current.end, this.#window.scrollY)) : null);
      if (target !== null) this.#animate(target);
    }, SETTLE_MS);
  }

  #resumeSettlement() {
    if (!this.#pointerActive && !this.#touchActive && this.#pendingOrigin) {
      this.#settle(this.#pendingOrigin, this.#pendingOrigin.delta);
    }
  }

  #onWheel(event) {
    if (event.ctrlKey || Math.abs(event.deltaX) >= Math.abs(event.deltaY)
      || !this.#canNavigate() || this.#excludedTarget(event.target)) return;
    this.#cancelAnimation();
    this.#pendingOrigin = null;
    this.#window.clearTimeout(this.#settleTimer);
    const now = this.#eventTime(event);
    const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? this.#window.innerHeight : 1);
    if (!this.#wheel || Math.sign(this.#wheel.delta) !== Math.sign(delta)) {
      this.#wheel = { ...this.#origin(), delta: 0, samples: [{ position: 0, time: now - 40 }] };
    }
    this.#wheel.delta += delta;
    this.#wheel.velocity = this.#sampleVelocity(this.#wheel.samples, this.#wheel.delta, now);
    this.#window.clearTimeout(this.#wheelTimer);
    this.#wheelTimer = this.#window.setTimeout(() => {
      const gesture = this.#wheel;
      this.#wheel = null;
      if (!gesture || !this.#canNavigate()) return;
      const flick = Math.abs(gesture.delta) >= WHEEL_DISTANCE_PX
        && Math.abs(gesture.velocity) >= FLICK_SPEED_PX_MS;
      const target = this.#destination(gesture, gesture.delta, flick);
      if (target === null) this.#settle(gesture, gesture.delta);
      // The wheel has already settled: ease from rest, but retain its strength
      // when choosing how quickly to travel to the page.
      else this.#animate(target, 0, Math.abs(gesture.velocity));
    }, SETTLE_MS);
  }

  #animate(target, releaseVelocity = 0, inputSpeed = Math.abs(releaseVelocity)) {
    this.#cancelAnimation();
    this.#pendingOrigin = null;
    this.#window.clearTimeout(this.#settleTimer);
    this.#wheel = null;
    this.#window.clearTimeout(this.#wheelTimer);
    // Apply the native scroll lock before reading the handoff position.
    this.#document.documentElement.dataset.sectionScrolling = 'true';
    const from = this.#window.scrollY;
    if (this.#reducedMotion.matches || Math.abs(target - from) < 1) {
      this.#window.scrollTo({ top: target, behavior: 'instant' });
      this.#cancelAnimation();
      this.#rememberPageEdge();
      return;
    }
    // Strength changes continuously rather than selecting a fixed animation.
    // A light gesture keeps the long glide; a strong one carries more momentum.
    const strength = inputSpeed / (inputSpeed + 0.8);
    const duration = Math.min(TRANSITION_MAX_MS, Math.max(TRANSITION_MIN_MS,
      TRANSITION_PAGE_MS * Math.sqrt(Math.abs(target - from) / this.#window.innerHeight)
        * (1 - 0.5 * strength ** 2)));
    const distance = target - from;
    // This bound keeps the curve monotonic while allowing a stronger release
    // to carry proportionally more speed into the movement.
    const velocity = Math.max(0, Math.min(2, releaseVelocity * duration / distance));
    const animation = { from, target, duration, start: this.#window.performance.now(), frame: null };
    this.#animation = animation;
    const tick = now => {
      if (this.#animation !== animation) return;
      // Layout is checked at navigation and on viewport/media changes. Measuring
      // page rectangles here would force style/layout work on every scroll frame.
      if (!this.#canNavigate(false)) { this.#cancelAnimation(); return; }
      const progress = Math.min(1, Math.max(0, (now - animation.start) / animation.duration));
      // Match the release speed and keep acceleration zero at both ends. A
      // fifth-degree curve avoids long stretches of subpixel movement that
      // make the start and finish appear to stall on integer scroll offsets.
      const eased = progress ** 3 * (10 + progress * (-15 + 6 * progress))
        + velocity * progress * (1 - progress) ** 3 * (1 + 3 * progress);
      const position = from + distance * eased;
      // Chrome may deliver one final native momentum frame after touchend. Never
      // pull back against it while the glide catches up.
      const current = this.#window.scrollY;
      const top = distance > 0 ? Math.min(target, Math.max(current, position))
        : Math.max(target, Math.min(current, position));
      this.#window.scrollTo({ top, behavior: 'instant' });
      if (progress < 1) animation.frame = this.#window.requestAnimationFrame(tick);
      else {
        this.#cancelAnimation();
        this.#rememberPageEdge();
      }
    };
    // Start the handoff immediately rather than waiting for the next paint.
    tick(animation.start);
  }

  #cancelAnimation() {
    if (this.#animation) this.#window.cancelAnimationFrame(this.#animation.frame);
    this.#animation = null;
    delete this.#document.documentElement.dataset.sectionScrolling;
  }

  #interrupt(releaseInput = false) {
    if (releaseInput) this.#pointerActive = this.#touchActive = false;
    this.#cancelAnimation();
    this.#gesture = null;
    this.#pointerReady = false;
    this.#wheel = null;
    this.#pendingOrigin = null;
    this.#window.clearTimeout(this.#wheelTimer);
    this.#window.clearTimeout(this.#settleTimer);
  }

  #listen(target, type, listener, options) {
    target.addEventListener(type, listener, options);
    this.#listeners.push(() => target.removeEventListener(type, listener, options));
  }
}
