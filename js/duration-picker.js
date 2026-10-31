import { CONFIG_LIMITS, PHASES, validateConfig } from './breathing-engine.js';
import { formatDuration, phaseDescription, spokenDuration } from './phase-labels.js';
import { OutsideDismissal } from './outside-dismissal.js';
import { visibleViewport } from './viewport-layout.js';
import { parseCssMilliseconds, readCssMilliseconds } from './css-time.js';

const REPEAT_DELAY_MS = 400;
const REPEAT_INTERVAL_MS = 100;
const STEP_REVEAL_DELAY_MS = 160;
const STEP_REVEAL_PAUSE_MS = 120;
const EXPANSION_DURATION_MS = 760;
const RISE_EASING = 'cubic-bezier(.4, 0, .6, 1)';
const SLIDE_DURATION_MS = 500;
const SLIDE_EASING = 'cubic-bezier(.5, 0, .85, .5)';
const DOUBLE_TAP_MS = 320;
const TAP_DISTANCE_PX = 20;

/** Timing controls only. The caller owns editing policy and persistence.
 * Render a validated configuration before using the controls; every accepted
 * edit is reported through onChange.
 */
export class DurationPicker {
  #window;
  #controls;
  #onChange;
  #canChange;
  #values;
  #press = null;
  #pointerClick = null;
  #listeners = [];
  #outsideDismissal;
  #viewportBounds;
  #resizeObserver;
  #revealSequence = null;
  #openingSource = null;
  #disposed = false;
  #closing = new Map();
  #transferred = new WeakSet();
  #slide = null;
  #context = null;
  #tapPress = null;
  #lastTap = null;
  #dismissClick = null;

  constructor({ document, window, container, onChange, canChange = () => true,
    canActivateOutside = () => false } = {}) {
    if (typeof document?.getElementById !== 'function' || typeof document.addEventListener !== 'function'
      || typeof window?.addEventListener !== 'function' || typeof window.setTimeout !== 'function'
      || typeof window.clearTimeout !== 'function' || typeof container?.addEventListener !== 'function') {
      throw new TypeError('DurationPicker requires a document, window and timing container.');
    }
    if ([onChange, canChange, canActivateOutside].some((callback) => typeof callback !== 'function')) {
      throw new TypeError('DurationPicker requires change and editing callbacks.');
    }
    this.#window = window;
    this.#onChange = onChange;
    this.#canChange = canChange;
    this.#controls = Object.fromEntries(PHASES.map((phase) => {
      const controls = Object.fromEntries(['value', 'picker', 'picker-content', 'picked-value', 'decrease', 'increase', 'fine-decrease', 'fine-increase']
        .map((suffix) => [suffix, document.getElementById(`${phase}-${suffix}`)]));
      if (Object.values(controls).some((element) => !element)) {
        throw new Error(`DurationPicker is missing controls for ${phase}.`);
      }
      return [phase, controls];
    }));

    // Pattern gestures can open the editor before their trailing click arrives.
    this.#listen(document, 'pointerdown', () => {
      this.#openingSource = null;
      this.#dismissClick = null;
    }, true);
    this.#listen(document, 'click', (event) => {
      if (this.#dismissClick && event.detail !== 0) {
        this.#dismissClick = null;
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      if (!this.#openingSource?.contains(event.target)) return;
      this.#openingSource = null;
      event.preventDefault();
      event.stopImmediatePropagation();
    }, true);
    this.#outsideDismissal = new OutsideDismissal({ document,
      surface: () => Object.values(this.#controls).find(({ picker }) => picker.matches(':popover-open'))?.picker,
      onDismiss: () => this.close(),
      isInside: (event, surface) => {
        const path = event.composedPath?.();
        if (path?.some(node => node?.dataset?.keepDurationPickerOpen === 'true')) return true;
        // Another timing, pattern or explicit navigation is a direct destination.
        // Other outside controls still consume the gesture for dismissal.
        const button = event.target?.closest?.('button');
        const destination = button ?? event.target?.closest?.('.preset-tile');
        if (destination && !destination.matches(':disabled') && this.#canChange()
          && (canActivateOutside(destination)
            || (button && Object.values(this.#controls).some(({ value, picker }) => value === button && picker !== surface)))) return true;
        if (path) return path.includes(surface);
        for (let element = event.target; element; element = element.parentElement) {
          if (element === surface || element.dataset?.keepDurationPickerOpen === 'true') return true;
        }
        return false;
      },
    });

    this.#listen(container, 'pointerdown', (event) => {
      if (!this.#startTap(event)) this.#startPress(event);
    });
    this.#listen(container, 'click', (event) => this.#click(event));
    this.#listen(container, 'dblclick', (event) => {
      const controls = this.#controlsForTarget(event.target);
      if (!controls?.picker.matches(':popover-open')) return;
      event.preventDefault();
      this.close();
      controls.value.focus({ preventScroll: true });
    });
    const release = (event) => {
      this.#endTap(event);
      this.#finishPress(event.pointerId);
    };
    this.#listen(document, 'pointerup', release);
    this.#listen(document, 'pointercancel', (event) => {
      this.#tapPress = this.#lastTap = null;
      this.#finishPress(event.pointerId);
    });
    this.#listen(document, 'pointermove', (event) => {
      const press = this.#tapPress;
      if (press && press.id === event.pointerId && Math.hypot(event.clientX - press.x, event.clientY - press.y) > TAP_DISTANCE_PX) {
        this.#tapPress = this.#lastTap = null;
      }
    }, { passive: true });
    this.#listen(container, 'lostpointercapture', release);
    // Viewport and layout changes reposition an open editor; ordinary scrolls
    // leave its targets still while a gesture is in progress.
    this.#listen(window, 'resize', () => this.#positionOpenPicker());
    if (window.visualViewport?.addEventListener) {
      this.#listen(window.visualViewport, 'resize', () => this.#positionOpenPicker());
    }
    this.#listen(window, 'blur', () => {
      this.#tapPress = this.#lastTap = null;
      this.#finishPress();
    });
    this.#listen(document, 'keydown', (event) => {
      if (event.key !== 'Escape') return;
      const controls = Object.values(this.#controls).find(({ picker }) => picker.matches(':popover-open'));
      if (!controls) return;
      event.preventDefault();
      this.close();
      controls.value.focus({ preventScroll: true });
    });
    this.#listen(document, 'visibilitychange', () => { if (document.hidden) this.close(); });
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
          this.#finishPress();
          this.#cancelReveal(controls);
          this.#revealButtons(controls);
          this.#watchClose(controls);
        }
      });
    }
    if (typeof window.ResizeObserver === 'function') {
      this.#resizeObserver = new window.ResizeObserver((entries) => {
        if (this.#disposed) return;
        let layoutChanged = false;
        for (const entry of entries) {
          const controls = Object.values(this.#controls).find(({ picker }) => picker === entry.target);
          if (controls) this.#revealButtons(controls);
          else if (entry.target === container || entry.target === container.parentElement) layoutChanged = true;
        }
        if (layoutChanged) this.#positionOpenPicker({ layoutChanged: true });
      });
      for (const { picker } of Object.values(this.#controls)) this.#resizeObserver.observe(picker);
      this.#resizeObserver.observe(container);
      if (container.parentElement) this.#resizeObserver.observe(container.parentElement);
    }
  }

  /** A different preset updates the existing editor and stops its old held adjustment. */
  render(config, context = null) {
    if (context !== null && (typeof context !== 'string' || !context)) {
      throw new TypeError('A timing context must be a nonempty preset ID or null.');
    }
    this.#values = validateConfig(config);
    if (context !== this.#context) this.#finishPress();
    this.#context = context;
    for (const phase of PHASES) this.#renderValue(phase);
  }

  get activePhase() {
    return Object.entries(this.#controls).find(([, { picker }]) => picker.matches(':popover-open'))?.[0] ?? null;
  }

  /** Open a phase from another control without toggling an already open editor. */
  open(phase, { source = null } = {}) {
    if (!PHASES.includes(phase)) throw new RangeError('Choose a supported breathing phase.');
    if (source !== null && typeof source.contains !== 'function') {
      throw new TypeError('An opening source must contain its gesture targets.');
    }
    const controls = this.#controls[phase];
    if (this.#disposed || !this.#values || !this.#canChange() || controls.value.matches(':disabled')
      || controls.picker.matches(':popover-open')) return false;
    this.#open(phase);
    this.#openingSource = source;
    return true;
  }

  close({ immediately = false } = {}) {
    this.#openingSource = null;
    this.#tapPress = this.#lastTap = null;
    this.#finishSlide();
    this.#finishPress();
    const controls = this.#revealSequence?.controls;
    this.#cancelReveal(controls);
    for (const control of Object.values(this.#controls)) {
      const { picker } = control;
      if (picker.matches(':popover-open')) {
        this.#prepareClose(control);
        picker.hidePopover();
        this.#watchClose(control);
      }
      // A page change must also remove any native light-dismissal exit that
      // started before the navigation click reached the app.
      if (immediately) this.#finishImmediately(control);
    }
    if (controls) this.#revealButtons(controls);
  }

  dispose() {
    this.#disposed = true;
    this.close({ immediately: true });
    this.#resizeObserver?.disconnect();
    this.#outsideDismissal.dispose();
    for (const remove of this.#listeners) remove();
    this.#listeners = [];
  }

  #listen(target, type, listener, options) {
    target.addEventListener(type, listener, options);
    this.#listeners.push(() => target.removeEventListener(type, listener, options));
  }

  #click(event) {
    const button = event.target.closest('button');
    if (!button || button.matches(':disabled') || !this.#canChange()) return;
    const phase = button.dataset.field;
    if (!PHASES.includes(phase)) return;
    if (this.#controls[phase].picker.dataset.closing === 'true' && button !== this.#controls[phase].value) return;
    if (button.classList.contains('picker-done')) {
      this.close();
      this.#controls[phase].value.focus({ preventScroll: true });
    } else if (button.classList.contains('duration-button')) {
      this.#open(phase, event);
    } else if (button.classList.contains('duration-step')) {
      // A pointer press already changed the value; keyboard/AT clicks have no pointer.
      if (event.detail !== 0 && this.#pointerClick === button) {
        this.#pointerClick = null;
        return;
      }
      this.#step(button);
    }
  }

  #controlsForTarget(target) {
    const picker = target?.closest?.('.duration-picker');
    return picker && Object.values(this.#controls).find(controls => controls.picker === picker);
  }

  /** A second nearby tap dismisses before its adjustment or trailing click can run. */
  #startTap(event) {
    if (event.button !== 0 || event.isPrimary === false) return false;
    const controls = this.#controlsForTarget(event.target);
    if (!controls?.picker.matches(':popover-open')) {
      this.#tapPress = this.#lastTap = null;
      return false;
    }
    const time = event.timeStamp ?? Date.now();
    const previous = this.#lastTap;
    if (previous?.controls === controls && time - previous.time >= 0 && time - previous.time <= DOUBLE_TAP_MS
      && Math.hypot(event.clientX - previous.x, event.clientY - previous.y) <= TAP_DISTANCE_PX) {
      this.close();
      this.#dismissClick = controls;
      controls.value.focus({ preventScroll: true });
      event.preventDefault();
      event.stopImmediatePropagation();
      return true;
    }
    this.#tapPress = { controls, id: event.pointerId, time, x: event.clientX, y: event.clientY };
    this.#lastTap = null;
    return false;
  }

  #endTap(event) {
    const press = this.#tapPress;
    if (!press || press.id !== event.pointerId) return;
    this.#tapPress = null;
    const time = event.timeStamp ?? Date.now();
    if (time - press.time <= DOUBLE_TAP_MS && press.controls.picker.matches(':popover-open')
      && Math.hypot(event.clientX - press.x, event.clientY - press.y) <= TAP_DISTANCE_PX) {
      this.#lastTap = { ...press, time };
    }
  }

  #startPress(event) {
    const button = event.target.closest('.duration-step');
    if (!button || event.button !== 0 || event.isPrimary === false
      || button.matches(':disabled') || !this.#canChange()
      || this.#controls[button.dataset.field]?.picker.dataset.closing === 'true') return;
    this.#finishPress();
    this.#pointerClick = button;
    if (!this.#step(button)) return;
    const press = { button, pointerId: event.pointerId, timer: null };
    this.#press = press;
    button.setPointerCapture?.(event.pointerId);
    const repeat = () => {
      if (this.#press !== press) return;
      if (button.matches(':disabled') || !this.#canChange() || !this.#step(button)) {
        this.#finishPress();
        return;
      }
      press.timer = this.#window.setTimeout(repeat, REPEAT_INTERVAL_MS);
    };
    press.timer = this.#window.setTimeout(repeat, REPEAT_DELAY_MS);
  }

  #finishPress(pointerId) {
    const press = this.#press;
    if (!press || (pointerId !== undefined && pointerId !== press.pointerId)) return;
    this.#press = null;
    this.#window.clearTimeout(press.timer);
    if (press.button.hasPointerCapture?.(press.pointerId)) press.button.releasePointerCapture(press.pointerId);
  }

  #step(button) {
    const phase = button.dataset.field;
    const step = Number(button.dataset.step);
    if (!this.#values || !PHASES.includes(phase) || !Number.isFinite(step)) return false;
    return this.#setValue(phase, this.#clamp(phase, this.#values[phase] + step));
  }

  /** Round to tenths within the phase limits; a non-number stays NaN. */
  #clamp(phase, value) {
    const [minimum, maximum] = CONFIG_LIMITS[phase];
    return Math.max(minimum, Math.min(maximum, Math.round(value * 10) / 10));
  }

  #setValue(phase, value) {
    if (!this.#values || this.#values[phase] === value) return false;
    this.#values = validateConfig({ ...this.#values, [phase]: value });
    this.#renderValue(phase);
    this.#onChange(phase, value);
    return true;
  }

  #renderValue(phase) {
    const controls = this.#controls[phase];
    const value = this.#values[phase];
    const duration = formatDuration(value);
    controls.value.value = value;
    const time = controls.value.querySelector('.phase-time');
    if (time) time.textContent = duration;
    else controls.value.textContent = duration;
    controls.value.setAttribute('aria-label', `adjust ${phaseDescription(phase)} duration, ${spokenDuration(value)}`);
    controls['picked-value'].value = duration;
    const [minimum, maximum] = CONFIG_LIMITS[phase];
    controls.decrease.disabled = value === minimum;
    controls.increase.disabled = value === maximum;
    controls['fine-decrease'].disabled = controls.decrease.disabled;
    controls['fine-increase'].disabled = controls.increase.disabled;
  }

  #open(phase) {
    const controls = this.#controls[phase];
    const { value: trigger, picker, 'picked-value': output } = controls;
    if (picker.matches(':popover-open')) {
      this.close();
      return;
    }
    const previous = Object.values(this.#controls).find(({ picker: candidate }) => candidate.matches(':popover-open'));
    if (previous) {
      this.#transfer(previous, phase);
      return;
    }
    this.close();
    this.#finishClosing(controls);
    picker.inert = false;
    this.#revealSequence = { controls, stage: 0, timer: null };
    trigger.focus({ preventScroll: true });
    const anchor = trigger.getBoundingClientRect();
    // Supply the starting box before native popover layout creates its transitions.
    picker.style.setProperty('--picker-closed-height', `${anchor.height}px`);
    picker.style.setProperty('--picker-closed-top', `${anchor.top}px`);
    picker.showPopover();
    this.#position(phase, visibleViewport(this.#window));
    const style = this.#window.getComputedStyle?.(picker);
    controls.shellMotion = {
      duration: parseCssMilliseconds(style?.transitionDuration?.split(',')[0] ?? '', EXPANSION_DURATION_MS),
      easing: this.#reverseEasing(this.#cssList(style?.transitionTimingFunction)[0] ?? RISE_EASING),
    };
    output.closest('.picker-center').focus({ preventScroll: true });
  }

  #transfer(previous, phase) {
    const controls = this.#controls[phase];
    const { picker, value: trigger, 'picked-value': output } = controls;
    const origin = previous.picker.getBoundingClientRect();
    this.#openingSource = null;
    this.#tapPress = this.#lastTap = null;
    this.#finishPress();
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
    this.#position(phase, visibleViewport(this.#window));
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
    output.closest('.picker-center').focus({ preventScroll: true });
  }

  #finishSlide({ cancel = false } = {}) {
    const slide = this.#slide;
    if (!slide) return;
    this.#slide = null;
    if (cancel) slide.animation.cancel();
    else slide.animation.finish();
    delete slide.controls.picker.dataset.transferring;
  }

  #positionOpenPicker({ layoutChanged = false } = {}) {
    const bounds = visibleViewport(this.#window);
    if (!layoutChanged && Object.keys(bounds).every(key => bounds[key] === this.#viewportBounds?.[key])) return;
    this.#finishSlide();
    for (const controls of this.#closing.keys()) this.#finishImmediately(controls);
    const entry = Object.entries(this.#controls).find(([, { picker }]) => picker.matches(':popover-open'));
    if (entry) this.#position(entry[0], bounds);
  }

  #position(phase, bounds = visibleViewport(this.#window)) {
    const controls = this.#controls[phase];
    const { value: trigger, picker, 'picker-content': content } = controls;
    const anchor = trigger.getBoundingClientRect();
    const { left, top, width, height } = bounds;
    this.#viewportBounds = bounds;
    // The expanded column occupies the timing cell's width. Its center stays
    // over the original time while the adjustment buttons grow above and below.
    const viewportWidth = Math.max(0, width - 16);
    picker.style.setProperty('--picker-center-height', `${controls['picked-value'].closest('.picker-center').offsetHeight}px`);
    picker.style.width = `${Math.max(52, anchor.width)}px`;
    picker.style.maxWidth = `${viewportWidth}px`;
    picker.style.maxHeight = `${Math.max(0, height - 16)}px`;
    picker.dataset.compact = String(height < 272);
    const edgeValue = this.#window.getComputedStyle?.(picker).getPropertyValue('--picker-edge-space').trim() ?? '';
    const edgeSpace = /^(\d+(?:\.\d+)?)px$/.test(edgeValue) ? Number.parseFloat(edgeValue) : NaN;
    const frameSpace = edgeSpace >= 0 && edgeSpace <= 24 ? 2 * edgeSpace + 2 : 8;
    const contentHeight = content.offsetHeight + frameSpace;
    const openHeight = Math.min(contentHeight, Math.max(0, height - 16));
    controls.openHeight = openHeight;
    picker.dataset.scrollable = String(contentHeight > openHeight);
    const pickerLeft = Math.max(left + 8, Math.min(anchor.left + (anchor.width - picker.offsetWidth) / 2, left + width - picker.offsetWidth - 8));
    const pickerTop = Math.max(top + 8, Math.min(anchor.top + (anchor.height - openHeight) / 2, top + height - openHeight - 8));
    picker.style.left = `${pickerLeft}px`;
    picker.style.setProperty('--picker-closed-height', `${anchor.height}px`);
    picker.style.setProperty('--picker-open-height', `${openHeight}px`);
    picker.style.setProperty('--picker-closed-top', `${anchor.top}px`);
    picker.style.setProperty('--picker-open-top', `${pickerTop}px`);
    this.#revealButtons(controls);
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
