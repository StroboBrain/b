import { CONFIG_LIMITS, PHASES, validateConfig } from './breathing-engine.js';
import { formatDuration, phaseDescription, spokenDuration } from './phase-labels.js';
import { OutsideDismissal } from './outside-dismissal.js';
import { visibleViewport } from './viewport-layout.js';

const REPEAT_DELAY_MS = 400;
const REPEAT_INTERVAL_MS = 100;
const STEP_REVEAL_DELAY_MS = 160;
const STEP_REVEAL_PAUSE_MS = 240;

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
    this.#listen(document, 'pointerdown', () => { this.#openingSource = null; }, true);
    this.#listen(document, 'click', (event) => {
      if (!this.#openingSource?.contains(event.target)) return;
      this.#openingSource = null;
      event.preventDefault();
      event.stopImmediatePropagation();
    }, true);
    this.#outsideDismissal = new OutsideDismissal({ document,
      surface: () => Object.values(this.#controls).find(({ picker }) => picker.matches(':popover-open'))?.picker,
      onDismiss: () => this.close(),
      isInside: (event, surface) => {
        // Another timing, pattern or explicit navigation is a direct destination.
        // Other outside controls still consume the gesture for dismissal.
        const button = event.target?.closest?.('button');
        const destination = button ?? event.target?.closest?.('.preset-tile');
        if (destination && !destination.matches(':disabled') && this.#canChange()
          && (canActivateOutside(destination)
            || (button && Object.values(this.#controls).some(({ value, picker }) => value === button && picker !== surface)))) return true;
        if (typeof event.composedPath === 'function') return event.composedPath().includes(surface);
        for (let element = event.target; element; element = element.parentElement) {
          if (element === surface) return true;
        }
        return false;
      },
    });

    this.#listen(container, 'pointerdown', (event) => this.#startPress(event));
    this.#listen(container, 'click', (event) => this.#click(event));
    const release = (event) => this.#finishPress(event.pointerId);
    this.#listen(document, 'pointerup', release);
    this.#listen(document, 'pointercancel', release);
    this.#listen(container, 'lostpointercapture', release);
    // Keep targets still while native section snapping settles in the page.
    // Only a real viewport resize should move an already open picker.
    this.#listen(window, 'resize', () => this.#positionOpenPicker());
    if (window.visualViewport?.addEventListener) {
      this.#listen(window.visualViewport, 'resize', () => this.#positionOpenPicker());
    }
    this.#listen(window, 'blur', () => this.#finishPress());
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
        for (const entry of entries) {
          const controls = Object.values(this.#controls).find(({ picker }) => picker === entry.target);
          if (controls) this.#revealButtons(controls);
        }
      });
      for (const { picker } of Object.values(this.#controls)) this.#resizeObserver.observe(picker);
    }
  }

  render(config) {
    this.#values = validateConfig(config);
    for (const phase of PHASES) this.#renderValue(phase);
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
    const field = controls.value.closest('.timing-field') ?? controls.value.closest('.phase-step');
    field?.classList.toggle('is-off', value === 0);
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
    output.closest('.picker-center').focus({ preventScroll: true });
  }

  #positionOpenPicker() {
    const bounds = visibleViewport(this.#window);
    if (Object.keys(bounds).every(key => bounds[key] === this.#viewportBounds?.[key])) return;
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
    const openHeight = Math.min(content.offsetHeight + 8, Math.max(0, height - 16));
    controls.openHeight = openHeight;
    picker.dataset.scrollable = String(content.offsetHeight + 8 > openHeight);
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
        sequence.fadeDuration = this.#cssTime(style, '--picker-step-fade-duration', STEP_REVEAL_DELAY_MS);
        const pause = this.#cssTime(style, '--picker-reveal-pause', STEP_REVEAL_PAUSE_MS);
        sequence.stage = 1;
        sequence.timer = this.#window.setTimeout(() => {
          if (this.#revealSequence !== sequence) return;
          sequence.timer = null;
          sequence.stage = 2;
          this.#revealButtons(controls);
        }, pause);
      } else if (sequence.stage === 2 && sequence.timer === null) {
        sequence.timer = this.#window.setTimeout(() => {
          if (this.#revealSequence !== sequence) return;
          sequence.timer = null;
          sequence.stage = 3;
          this.#revealButtons(controls);
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
    this.#closing.set(controls, {});
    controls.picker.dataset.closing = 'true';
    controls.picker.inert = true;
    controls.value.setAttribute('aria-expanded', 'false');
    for (const button of [controls.increase, controls['fine-increase'], controls['fine-decrease'], controls.decrease]) {
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

  #cssTime(style, property, fallback) {
    const value = style?.getPropertyValue(property).trim() ?? '';
    const match = /^(\d+(?:\.\d+)?|\.\d+)(ms|s)$/i.exec(value);
    if (!match) return fallback;
    const milliseconds = Number(match[1]) * (match[2].toLowerCase() === 's' ? 1000 : 1);
    return Number.isFinite(milliseconds) ? milliseconds : fallback;
  }
}
