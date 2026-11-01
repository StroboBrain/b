import { parseCssMilliseconds, readCssMilliseconds } from './css-time.js';

// Fallbacks serve tests/embedders without the app stylesheet; popup.css owns app timing.
const STEP_REVEAL_DELAY_MS = 160;
const STEP_REVEAL_PAUSE_MS = 120;
const EXPANSION_DURATION_MS = 760;
const RISE_EASING = 'cubic-bezier(.4, 0, .6, 1)';
const SLIDE_DURATION_MS = 500;
const SLIDE_EASING = 'cubic-bezier(.5, 0, .85, .5)';

/** @typedef {import('./duration-picker-placement.js').PickerControls} PickerControls */

/** Owns the reversible Rise reveal, collapse and already-open timing transfers. */
export class DurationPickerMotion {
  #window;
  #controls;
  #position;
  #onNativeClose;
  #revealSequence = null;
  #closing = new Map();
  #transferred = new WeakSet();
  #slide = null;
  #listeners = [];

  /** @param {{window:Window & typeof globalThis, controls:Record<string,PickerControls>,
   * position:(phase:string)=>void, onNativeClose:()=>void}} options */
  constructor({ window, controls, position, onNativeClose }) {
    if (typeof window?.setTimeout !== 'function' || typeof window.clearTimeout !== 'function'
      || !controls || typeof position !== 'function' || typeof onNativeClose !== 'function') {
      throw new TypeError('DurationPickerMotion requires timers, controls and animation callbacks.');
    }
    this.#window = window;
    this.#controls = controls;
    this.#position = position;
    this.#onNativeClose = onNativeClose;
    for (const controls of Object.values(this.#controls)) {
      this.#listen(controls.picker, 'scroll', () => this.#revealButtons(controls));
      this.#listen(controls.picker, 'transitionend', (event) => {
        if (event.target === controls.picker && event.propertyName === 'height') this.#revealButtons(controls);
        if (event.target === controls.picker && ['display', 'overlay'].includes(event.propertyName)
          && !controls.picker.matches(':popover-open')) this.#finishClosing(controls);
      });
      this.#listen(controls.picker, 'toggle', () => {
        const open = controls.picker.matches(':popover-open');
        controls.value.setAttribute('aria-expanded', String(open));
        // A transfer replaces the native dialog without running its exit.
        if (this.#transferred.delete(controls.picker) && !open) return;
        if (!open) {
          this.#prepareClose(controls);
          this.#onNativeClose();
          this.#cancelReveal(controls);
          this.#revealButtons(controls);
          this.#watchClose(controls);
        }
      });
    }
  }

  get closingSurface() { return this.#closing.keys().next().value?.picker ?? null; }

  close({ immediately = false } = {}) {
    this.#finishSlide();
    const controls = this.#revealSequence?.controls;
    this.#cancelReveal(controls);
    for (const control of Object.values(this.#controls)) {
      if (control.picker.matches(':popover-open')) {
        this.#prepareClose(control);
        control.picker.hidePopover();
        this.#watchClose(control);
      }
      if (immediately) this.#finishImmediately(control);
    }
    if (controls) this.#revealButtons(controls);
  }

  revealButtons(controls) { this.#revealButtons(controls); }

  beforeReposition() {
    this.#finishSlide();
    for (const controls of this.#closing.keys()) this.#finishImmediately(controls);
  }

  dispose() {
    this.close({ immediately: true });
    for (const remove of this.#listeners) remove();
    this.#listeners = [];
  }

  #listen(target, type, listener) {
    target.addEventListener(type, listener);
    this.#listeners.push(() => target.removeEventListener(type, listener));
  }

  open(phase) {
    const controls = this.#controls[phase];
    const { value: trigger, picker, 'picked-value': output } = controls;
    // Reopening this same column reverses its native transition in place.
    // Other outgoing columns must finish before a fresh editor can paint.
    for (const closing of this.#closing.keys()) {
      if (closing !== controls) this.#finishImmediately(closing);
    }
    this.#finishClosing(controls);
    picker.inert = false;
    this.#revealSequence = { controls, stage: 0, timer: null };
    trigger.focus({ preventScroll: true });
    const anchor = trigger.getBoundingClientRect();
    // Supply the starting box before native popover layout creates its transitions.
    picker.style.setProperty('--picker-closed-height', `${anchor.height}px`);
    picker.style.setProperty('--picker-closed-top', `${anchor.top}px`);
    picker.showPopover();
    this.#position(phase);
    const style = this.#window.getComputedStyle?.(picker);
    controls.shellMotion = {
      duration: readCssMilliseconds(style, '--picker-expansion-duration',
        parseCssMilliseconds(style?.transitionDuration?.split(',')[0] ?? '', EXPANSION_DURATION_MS)),
      easing: this.#reverseEasing(this.#cssList(style?.transitionTimingFunction)[0] ?? RISE_EASING),
    };
    /** @type {HTMLElement} */ (output.closest('.picker-center')).focus({ preventScroll: true });
  }

  transfer(previous, phase) {
    const controls = this.#controls[phase];
    const { picker, value: trigger, 'picked-value': output } = controls;
    const origin = previous.picker.getBoundingClientRect();
    this.#finishSlide({ cancel: true });
    this.#finishImmediately(controls);

    // Continue the existing reveal stage and timers. A fully open editor stays
    // fully open; switching during its first opening does not restart Rise.
    if (this.#revealSequence) this.#revealSequence.controls = controls;
    controls.shellMotion = previous.shellMotion;
    controls.stepMotion = previous.stepMotion;
    controls.fadeDuration = previous.fadeDuration;
    controls.revealPause = previous.revealPause;
    previous.picker.dataset.transferring = 'true';
    previous.picker.inert = true;
    previous.value.setAttribute('aria-expanded', 'false');
    this.#transferred.add(previous.picker);
    previous.picker.hidePopover();
    previous.picker.getBoundingClientRect();
    delete previous.picker.dataset.transferring;

    picker.dataset.transferring = 'true';
    picker.dataset.transferInitializing = 'true';
    picker.inert = false;
    picker.scrollTop = previous.picker.scrollTop;
    trigger.focus({ preventScroll: true });
    picker.showPopover();
    this.#position(phase);
    const destination = picker.getBoundingClientRect();
    delete picker.dataset.transferInitializing;

    const style = this.#window.getComputedStyle?.(picker);
    const duration = readCssMilliseconds(style, '--picker-slide-duration', SLIDE_DURATION_MS);
    const easing = style?.getPropertyValue('--picker-slide-easing').trim() || SLIDE_EASING;
    const animation = picker.animate?.([
      { left: `${origin.left}px`, top: `${origin.top}px`, width: `${origin.width}px`, height: `${origin.height}px` },
      { left: `${destination.left}px`, top: `${destination.top}px`, width: `${destination.width}px`, height: `${destination.height}px` },
    ], { duration, easing });
    if (animation) {
      const slide = this.#slide = { controls, animation };
      animation.finished.then(() => {
        if (this.#slide !== slide) return;
        this.#slide = null;
        delete picker.dataset.transferring;
        this.#revealButtons(controls);
      }, () => {});
    } else {
      delete picker.dataset.transferring;
      this.#revealButtons(controls);
    }
    /** @type {HTMLElement} */ (output.closest('.picker-center')).focus({ preventScroll: true });
  }

  #finishSlide({ cancel = false } = {}) {
    const slide = this.#slide;
    if (!slide) return;
    this.#slide = null;
    if (cancel) slide.animation.cancel();
    else slide.animation.finish();
    delete slide.controls.picker.dataset.transferring;
  }

  #revealButtons(controls) {
    const { picker } = controls;
    const bounds = picker.getBoundingClientRect();
    const center = controls['picked-value'].closest('.picker-center').getBoundingClientRect();
    const centerTop = `${center.top - bounds.top}px`, centerBottom = `${center.bottom - bounds.top}px`;
    if (controls.centerTop !== centerTop || controls.centerBottom !== centerBottom) {
      controls.centerTop = centerTop;
      controls.centerBottom = centerBottom;
      picker.style.setProperty('--picker-center-top', centerTop);
      picker.style.setProperty('--picker-center-bottom', centerBottom);
    }
    const top = bounds.top + picker.clientTop;
    const bottom = top + picker.clientHeight;
    const moving = picker.getAnimations?.().some(animation => animation.transitionProperty === 'height'
      && animation.playState !== 'finished') ?? false;
    const fullyExpanded = picker.matches(':popover-open') && Math.abs(bounds.height - controls.openHeight) < .1 && !moving;
    const sequence = this.#revealSequence;
    if (sequence?.controls === controls) {
      if (!fullyExpanded) {
        this.#window.clearTimeout(sequence.timer);
        sequence.timer = null;
        sequence.stage = 0;
      } else if (sequence.stage === 0) {
        // Let the fully expanded box rest before the fine pair fades in, then
        // reveal the outer whole-second pair after that fade has completed.
        const style = this.#window.getComputedStyle?.(picker);
        sequence.fadeDuration = readCssMilliseconds(style, '--picker-step-fade-duration', STEP_REVEAL_DELAY_MS);
        const pause = readCssMilliseconds(style, '--picker-reveal-pause', STEP_REVEAL_PAUSE_MS);
        controls.revealPause = pause;
        controls.fadeDuration = sequence.fadeDuration;
        controls.stepMotion = ['increase', 'fine-increase', 'fine-decrease', 'decrease'].map((suffix, index) => {
          const stepStyle = this.#window.getComputedStyle?.(controls[suffix]);
          const easings = this.#cssList(stepStyle?.transitionTimingFunction);
          return { transform: stepStyle?.transform ?? `translateY(${index < 2 ? 12 : -12}px)`,
            opacityEasing: this.#reverseEasing(easings[0] ?? 'ease'),
            transformEasing: this.#reverseEasing(easings.at(-1) ?? RISE_EASING) };
        });
        sequence.stage = 1;
        sequence.timer = this.#window.setTimeout(() => {
          if (this.#revealSequence !== sequence) return;
          sequence.timer = null;
          sequence.stage = 2;
          this.#revealButtons(sequence.controls);
        }, pause);
      } else if (sequence.stage === 2 && sequence.timer === null) {
        sequence.timer = this.#window.setTimeout(() => {
          if (this.#revealSequence !== sequence) return;
          sequence.timer = null;
          sequence.stage = 3;
          this.#revealButtons(sequence.controls);
        }, sequence.fadeDuration);
      }
    }
    const stage = fullyExpanded && sequence?.controls === controls ? sequence.stage : 0;
    // Read all geometry before changing visibility, so each button does not
    // force another style calculation for the next button in the same frame.
    const visibility = [controls.increase, controls['fine-increase'], controls['fine-decrease'], controls.decrease].map((button) => {
      const box = button.getBoundingClientRect();
      const fine = button === controls['fine-increase'] || button === controls['fine-decrease'];
      const revealed = stage >= (fine ? 2 : 3) && box.top >= top - .1 && box.bottom <= bottom + .1;
      return { button, revealed };
    });
    for (const { button, revealed } of visibility) {
      if (button.dataset.revealed === String(revealed)) continue;
      button.dataset.revealed = String(revealed);
      button.inert = !revealed;
    }
  }

  #cancelReveal(controls) {
    if (!this.#revealSequence || this.#revealSequence.controls !== controls) return;
    this.#window.clearTimeout(this.#revealSequence.timer);
    this.#revealSequence = null;
  }

  #prepareClose(controls) {
    if (this.#closing.has(controls)) return;
    const { picker } = controls;
    const coarse = [controls.increase, controls.decrease].some(button => button.dataset.revealed === 'true');
    const fine = [controls['fine-increase'], controls['fine-decrease']].some(button => button.dataset.revealed === 'true');
    const fade = controls.fadeDuration ?? STEP_REVEAL_DELAY_MS;
    const pause = coarse || fine ? controls.revealPause ?? STEP_REVEAL_PAUSE_MS : 0;
    const coarseDuration = coarse ? fade : 0, fineDuration = fine ? fade : 0;
    const collapseDelay = coarseDuration + fineDuration + pause;
    const duration = controls.shellMotion?.duration ?? EXPANSION_DURATION_MS;
    picker.style.setProperty('--picker-close-coarse-duration', `${coarseDuration}ms`);
    picker.style.setProperty('--picker-close-fine-duration', `${fineDuration}ms`);
    picker.style.setProperty('--picker-close-collapse-delay', `${collapseDelay}ms`);
    picker.style.setProperty('--picker-close-collapse-duration', `${duration}ms`);
    picker.style.setProperty('--picker-close-collapse-easing', controls.shellMotion?.easing ?? RISE_EASING);
    picker.style.setProperty('--picker-close-total-duration', `${collapseDelay + duration}ms`);
    this.#closing.set(controls, {});
    picker.dataset.closing = 'true';
    picker.inert = true;
    controls.value.setAttribute('aria-expanded', 'false');
    for (const [index, button] of [controls.increase, controls['fine-increase'], controls['fine-decrease'], controls.decrease].entries()) {
      const motion = controls.stepMotion?.[index];
      button.style.setProperty('--picker-close-transform', motion?.transform ?? `translateY(${index < 2 ? 12 : -12}px)`);
      button.style.setProperty('--picker-close-opacity-easing', motion?.opacityEasing ?? 'cubic-bezier(.75, 0, .75, .9)');
      button.style.setProperty('--picker-close-transform-easing', motion?.transformEasing ?? RISE_EASING);
      button.dataset.folding = String(button.dataset.revealed === 'true');
      button.inert = true;
    }
  }

  #watchClose(controls) {
    const closing = this.#closing.get(controls);
    if (!closing || closing.watching) return;
    closing.watching = true;
    const animations = controls.picker.getAnimations?.({ subtree: true }) ?? [];
    const finished = animations.map(animation => animation.finished).filter(promise => typeof promise?.then === 'function');
    if (!animations.length) this.#finishClosing(controls);
    else if (finished.length) Promise.allSettled(finished).then(() => {
      if (this.#closing.get(controls) === closing && !controls.picker.matches(':popover-open')) this.#finishClosing(controls);
    });
  }

  #finishClosing(controls) {
    this.#closing.delete(controls);
    delete controls.picker.dataset.closing;
    for (const button of [controls.increase, controls['fine-increase'], controls['fine-decrease'], controls.decrease]) {
      delete button.dataset.folding;
    }
  }

  #finishImmediately(controls) {
    for (const animation of controls.picker.getAnimations?.({ subtree: true }) ?? []) animation.finish?.();
    this.#finishClosing(controls);
  }

  #cssList(value = '') {
    return value.match(/(?:[^(),]+|\([^)]*\))+/g)?.map(item => item.trim()) ?? [];
  }

  #reverseEasing(easing) {
    const standard = { ease: [.25, .1, .25, 1], 'ease-in': [.42, 0, 1, 1],
      'ease-out': [0, 0, .58, 1], 'ease-in-out': [.42, 0, .58, 1] };
    const bezier = standard[easing] ?? /^cubic-bezier\(([^)]+)\)$/.exec(easing)?.[1].split(',').map(Number);
    if (!bezier || bezier.length !== 4 || bezier.some(value => !Number.isFinite(value))) return 'linear';
    return `cubic-bezier(${[1 - bezier[2], 1 - bezier[3], 1 - bezier[0], 1 - bezier[1]]
      .map(value => Number(value.toFixed(6))).join(', ')})`;
  }
}
