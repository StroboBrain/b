import { readCssMilliseconds } from './css-time.js';

const SVG = 'http://www.w3.org/2000/svg';
const controllers = new WeakMap();
export const findGuideAnimation = document => document && controllers.get(document);

export function animateOneByOne([inner, outer], { animate, total }) {
  const opacity = (from, to) => [{ opacity: 1, offset: 0 }, { opacity: 1, offset: from },
    { opacity: 0, offset: to }, { opacity: 0, offset: 1 }];
  const dotFade = Math.min(total, Math.max(80, total / Math.max(inner.dots.length, outer.dots.length)));
  for (const ring of [inner, outer]) for (const dot of ring.dots) {
    const count = ring.dots.length;
    // Each stationary ring fades in the opposite direction from the same start point.
    const rank = ring === inner ? dot.index : (count - dot.index) % count;
    const from = (total - dotFade) * rank / Math.max(1, count - 1) / total;
    animate(dot.node, opacity(from, Math.min(1, from + dotFade / total)));
  }
}

export const defaultGuideAnimation = Object.freeze({
  id: 'one-by-one',
  duration: ({ fade, rings }) => Math.max(fade, Math.min(1600, Math.max(...rings.map(ring => ring.dots.length)) * 12)),
  animate: animateOneByOne,
});

/** Fades guide dots without changing breathing or display preferences. */
export class GuideAnimation {
  #document;
  #window;
  #stage;
  #practice;
  #visual;
  #guides;
  #media;
  #observer;
  #resizeObserver;
  #lastSize;
  #shown;
  #animation = defaultGuideAnimation;
  #speed = 1;
  #run = null;
  #disposed = false;
  #listeners = [];

  constructor({ document = globalThis.document, window = globalThis.window } = {}) {
    if (typeof document?.getElementById !== 'function' || typeof document.createElementNS !== 'function'
      || typeof document.addEventListener !== 'function' || typeof document.removeEventListener !== 'function'
      || typeof window?.addEventListener !== 'function' || typeof window.removeEventListener !== 'function'
      || typeof window.getComputedStyle !== 'function' || typeof window.setTimeout !== 'function'
      || typeof window.clearTimeout !== 'function') {
      throw new TypeError('GuideAnimation requires SVG-capable document and animation window ports.');
    }
    this.#document = document;
    this.#window = window;
    this.#stage = document.getElementById('exercise-stage');
    this.#practice = document.getElementById('practice');
    this.#visual = document.getElementById('breathing-visual');
    this.#guides = ['min', 'max'].map(name => this.#visual?.querySelector(`.breath-guide-${name}`));
    if (!this.#stage?.dataset || !this.#visual?.dataset || this.#guides.some(guide => !guide?.querySelector('circle'))) {
      throw new TypeError('GuideAnimation requires the breathing stage and both SVG guides.');
    }
    this.#shown = this.#stage.dataset.showGuides !== 'false';
    this.#media = window.matchMedia?.('(prefers-reduced-motion: reduce)') ?? { matches: true };
    this.#lastSize = this.#size();
    if (typeof window.MutationObserver === 'function') {
      this.#observer = new window.MutationObserver(() => {
        const shown = this.#stage.dataset.showGuides !== 'false';
        const changed = shown !== this.#shown;
        this.#shown = shown;
        if (!this.#idle()) { this.#cancel(); return; }
        if (!changed) return;
        this.#cancel();
        this.#play(shown ? 'show' : 'hide');
      });
      this.#observer.observe(this.#stage, { attributes: true, attributeFilter: ['data-show-guides'] });
      this.#observer.observe(this.#visual, { attributes: true, attributeFilter: ['data-state'] });
      if (this.#practice) this.#observer.observe(this.#practice, { attributes: true, attributeFilter: ['data-starting', 'data-state'] });
    }
    if (typeof window.ResizeObserver === 'function') {
      this.#resizeObserver = new window.ResizeObserver(() => {
        const size = this.#size();
        if (size !== this.#lastSize) this.#cancel();
        this.#lastSize = size;
      });
      this.#resizeObserver.observe(this.#visual);
    }
    this.#listen(document, 'visibilitychange', () => { if (document.hidden) this.#cancel(); });
    for (const type of ['resize', 'blur', 'pagehide']) this.#listen(window, type, () => this.#cancel());
    if (typeof this.#media.addEventListener === 'function') this.#listen(this.#media, 'change', () => this.#cancel());
    controllers.set(document, this);
    this.#stage.dataset.guideAnimation = this.#animation.id;
  }

  get variant() { return this.#animation.id; }
  get speed() { return this.#speed; }

  /** Dev may temporarily supply a different animation plan to this same controller. */
  setAnimation(animation) {
    if (!animation || typeof animation.id !== 'string' || typeof animation.duration !== 'function'
      || typeof animation.animate !== 'function') throw new TypeError('GuideAnimation requires an animation plan.');
    if (this.#disposed || animation.id === this.#animation.id) return;
    this.#cancel();
    this.#animation = animation;
    this.#stage.dataset.guideAnimation = animation.id;
  }

  setSpeed(value) {
    if (!Number.isFinite(value) || value < .25 || value > 4) {
      throw new RangeError('Guide animation speed must be between 0.25 and 4.');
    }
    if (this.#disposed || value === this.#speed) return;
    this.#cancel();
    this.#speed = value;
  }

  restoreDefault() {
    this.#cancel();
    this.setAnimation(defaultGuideAnimation);
    this.setSpeed(1);
  }

  /** Show the chosen exit once without changing the app's guide preference. */
  preview() { return this.#play('preview'); }

  dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#cancel();
    this.#observer?.disconnect();
    this.#resizeObserver?.disconnect();
    for (const remove of this.#listeners) remove();
    this.#listeners = [];
    delete this.#stage.dataset.guideAnimation;
    if (controllers.get(this.#document) === this) controllers.delete(this.#document);
  }

  #idle() {
    return !this.#document.hidden && this.#visual.dataset.state === 'idle'
      && this.#practice?.dataset.starting !== 'true'
      && (!this.#practice?.dataset.state || this.#practice.dataset.state === 'idle');
  }

  #size() {
    const style = this.#window.getComputedStyle(this.#visual);
    return `${style.width}:${style.height}`;
  }

  #play(mode) {
    this.#cancel();
    if (this.#disposed || !this.#idle() || this.#media.matches) return false;
    const style = this.#window.getComputedStyle(this.#visual);
    const width = Number.parseFloat(style.width), height = Number.parseFloat(style.height);
    if (!(width > 0 && height > 0)) return false;
    const overlay = this.#node('svg', { class: 'guide-overlay', viewBox: `0 0 ${width} ${height}`,
      'aria-hidden': 'true', focusable: 'false', 'data-variant': this.#animation.id });
    const rings = this.#guides.map((guide, ringIndex) => {
      const circle = guide.querySelector('circle'), length = circle.getTotalLength();
      const radius = Number.parseFloat(this.#window.getComputedStyle(guide).width) / 2;
      const count = Math.max(1, Math.round(Number(circle.getAttribute('pathLength')) || length / 5));
      if (!(radius > 0) || !Number.isFinite(count)) return null;
      const group = this.#node('g', { class: 'guide-ring', 'data-ring': ringIndex === 0 ? 'min' : 'max' });
      const dots = Array.from({ length: count }, (_, index) => {
        // Match the native SVG circle's right-hand start point to avoid a dot-position jump.
        const angle = index * Math.PI * 2 / count;
        const dot = this.#node('circle', { class: 'guide-dot', cx: width / 2 + Math.cos(angle) * radius,
          cy: height / 2 + Math.sin(angle) * radius, r: .5, 'data-index': index });
        group.append(dot);
        return { node: dot, angle, index };
      });
      overlay.append(group);
      return { group, dots, radius };
    });
    if (rings.some(ring => !ring)) return false;
    this.#visual.append(overlay);
    if (typeof rings[0].group.animate !== 'function') { overlay.remove(); return false; }
    const timings = this.#window.getComputedStyle(this.#stage);
    const contract = readCssMilliseconds(timings, '--guides-contract-duration', 800);
    const fade = readCssMilliseconds(timings, '--guides-fade-duration', 400);
    const total = Math.max(1, this.#animation.duration({ contract, fade, rings }));
    const tail = total - contract;
    const duration = total / this.#speed;
    const run = { overlay, animations: [], timer: null };
    this.#run = run;
    this.#stage.dataset.guidesRunning = mode;
    const animate = (node, keyframes, easing = 'linear') => {
      const animation = node.animate(keyframes, { duration, easing, fill: 'both', direction: mode === 'show' ? 'reverse' : 'normal' });
      animation.finished?.catch(() => {});
      run.animations.push(animation);
    };
    this.#animation.animate(rings, { animate, contract, tail, total });
    overlay.dataset.duration = String(duration);
    overlay.dataset.speed = String(this.#speed);
    run.timer = this.#window.setTimeout(() => { if (this.#run === run) this.#cancel(); }, (total + 40) / this.#speed);
    return true;
  }

  #cancel() {
    const run = this.#run;
    if (!run) return;
    this.#run = null;
    this.#window.clearTimeout(run.timer);
    // Finish hidden native transitions on completion and interruption alike:
    // removing the overlay must reveal the current saved visibility immediately.
    for (const guide of this.#guides) {
      for (const animation of guide.getAnimations?.({ subtree: true }) ?? []) animation.finish?.();
    }
    for (const animation of run.animations) animation.cancel();
    run.overlay.remove();
    delete this.#stage.dataset.guidesRunning;
  }

  #node(tag, attributes) {
    const node = this.#document.createElementNS(SVG, tag);
    for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, String(value));
    return node;
  }

  #listen(target, type, callback) {
    target.addEventListener(type, callback);
    this.#listeners.push(() => target.removeEventListener(type, callback));
  }
}
