import { CONFIG_LIMITS, PHASES, validateConfig } from './breathing-engine.js';
import { formatDuration, phaseDescription, spokenDuration } from './phase-labels.js';
import { OutsideDismissal } from './outside-dismissal.js';
import { DurationPickerPlacement } from './duration-picker-placement.js';
import { DurationPickerInput } from './duration-picker-input.js';
import { DurationPickerMotion } from './duration-picker-motion.js';
import { acquireGestureArbiter, GESTURE_PRIORITIES } from './gesture-arbiter.js';

/** Timing controls only. The caller owns editing policy and persistence.
 * Render a validated configuration before using the controls; every accepted
 * edit is reported through onChange.
 */
export class DurationPicker {
  #document;
  #controls;
  #onChange;
  #canChange;
  #values;
  #listeners = [];
  #outsideDismissal;
  #openingSource = null;
  #openingFocus = null;
  #openingInput = 0;
  #disposed = false;
  #input;
  #motion;
  #placement;
  #context = null;
  #dismissClick = null;
  #focusDismissed = false;

  /** Browser ports are duck-typed at runtime so isolated views can supply small test ports.
   * @param {{document?:any, window?:any, container?:any,
   * onChange?:(phase:string,value:number)=>void, canChange?:()=>boolean,
   * canActivateOutside?:(target:HTMLElement)=>boolean}} [options] */
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
    this.#document = document;
    this.#onChange = onChange;
    this.#canChange = canChange;
    this.#controls = /** @type {Record<string, import('./duration-picker-placement.js').PickerControls>} */ (/** @type {unknown} */ (Object.fromEntries(PHASES.map((phase) => {
      const controls = Object.fromEntries(['value', 'picker', 'picker-content', 'picked-value', 'decrease', 'increase', 'fine-decrease', 'fine-increase']
        .map((suffix) => [suffix, document.getElementById(`${phase}-${suffix}`)]));
      if (Object.values(controls).some((element) => !element)) {
        throw new Error(`DurationPicker is missing controls for ${phase}.`);
      }
      return [phase, controls];
    }))));

    this.#input = new DurationPickerInput({ window, controls: this.#controls, canChange,
      step: button => this.#step(button), onDismiss: (controls, consumeClick = false) => {
        this.close();
        if (consumeClick) this.#dismissClick = controls;
        controls.value.focus({ preventScroll: true });
      } });
    this.#motion = new DurationPickerMotion({ window, controls: this.#controls,
      position: phase => this.#placement.position(phase), onNativeClose: () => this.#input.finish() });
    this.#placement = new DurationPickerPlacement({ window, container, controls: this.#controls,
      onReveal: controls => this.#motion.revealButtons(controls), beforeReposition: () => this.#motion.beforeReposition() });

    // Pattern gestures can open the editor before their trailing click arrives.
    this.#listen(document, 'pointerdown', () => {
      this.#clearOpeningFocus();
      this.#dismissClick = null;
    }, true);
    this.#listen(document, 'click', (event) => {
      if (this.#dismissClick && event.detail !== 0) {
        this.#dismissClick = null;
        return true;
      }
      if (!this.#openingSource?.contains(event.target)) return;
      const openingFocus = this.#openingFocus;
      this.#openingSource = null;
      Promise.resolve().then(() => {
        if (this.#openingFocus === openingFocus) this.#openingFocus = null;
      });
      return true;
    }, true);
    this.#outsideDismissal = new OutsideDismissal({ document,
      surface: () => this.#dismissalSurface(),
      onDismiss: () => this.close(),
      isInside: (event, surface) => {
        const path = event.composedPath?.();
        if (this.#insideSurface(event, surface)) return true;
        // Another enabled timing moves the open editor in one gesture. Closing
        // graphics still shield new controls until their exit has finished.
        const timing = this.#timingControls(event.target);
        if (surface.matches(':popover-open') && timing && timing.picker !== surface) return true;
        // Direct interaction additionally permits unrelated Dev destinations.
        if (!this.#directInteraction()) return false;
        if (path?.some(node => node?.dataset?.keepDurationPickerOpen === 'true')) return true;
        // A pattern or explicit navigation may be a direct destination.
        // Other outside controls still consume the gesture for dismissal.
        const button = event.target?.closest?.('button');
        const destination = button ?? event.target?.closest?.('.preset-tile');
        if (destination && !destination.matches(':disabled') && this.#canChange()
          && canActivateOutside(destination)) return true;
        if (path) return false;
        for (let element = event.target; element; element = element.parentElement) {
          if (element.dataset?.keepDurationPickerOpen === 'true') return true;
        }
        return false;
      },
    });

    this.#listen(container, 'pointerdown', event => this.#input.start(event));
    this.#listen(container, 'click', event => this.#click(event));
    this.#listen(container, 'dblclick', event => this.#input.doubleClick(event));
    this.#listen(document, 'pointerup', event => this.#input.release(event));
    this.#listen(document, 'pointercancel', event => this.#input.cancel(event));
    this.#listen(document, 'pointermove', event => this.#input.move(event), { passive: true });
    this.#listen(container, 'lostpointercapture', event => this.#input.release(event));
    this.#listen(window, 'blur', () => {
      this.#input.resetTap();
      this.#input.finish();
    });
    this.#listen(document, 'keydown', (event) => {
      this.#clearOpeningFocus();
      const surface = this.#dismissalSurface();
      if (!surface) return;
      if (event.key !== 'Escape') {
        if (this.#directInteraction() || this.#insideSurface(event, surface)
          || (surface.matches(':popover-open') && this.#timingControls(event.target))
          || !['Enter', ' ', 'Spacebar', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
        this.close();
        return true;
      }
      if (this.#directInteraction() && !this.#insideSurface(event, surface)) return;
      const controls = Object.values(this.#controls).find(({ picker }) => picker === surface);
      if (!controls) return;
      this.close();
      controls.value.focus({ preventScroll: true });
      return true;
    }, true);
    this.#listen(document, 'focusin', (event) => {
      if (this.#directInteraction()) return;
      const surface = this.#dismissalSurface();
      if (!surface || this.#insideSurface(event, surface)) return;
      if (this.#isOpeningFocus(event.target)) return;
      if (surface.matches(':popover-open') && this.#timingControls(event.target)) return;
      if (surface.matches(':popover-open')) {
        // A non-modal popup must release the newly focused control even while
        // its closing graphics finish. Pointer dismissal still shields its exit.
        this.#focusDismissed = true;
        this.close();
      }
    }, true);
    this.#listen(document, 'focusout', (event) => {
      if (this.#directInteraction()) return;
      const surface = this.#dismissalSurface();
      if (!surface?.matches(':popover-open')) return;
      const openingFocus = this.#openingFocus;
      // Native popover handoffs can temporarily clear focus. Check after the
      // handoff completes so moving to another timing never collapses it.
      Promise.resolve().then(() => {
        if (this.#disposed || !surface.matches(':popover-open') || this.#dismissalSurface() !== surface) return;
        const destination = event.relatedTarget ?? this.#document.activeElement;
        if (this.#insideSurface({ target: destination }, surface) || this.#timingControls(destination)) return;
        if (this.#isOpeningFocus(destination, openingFocus)) return;
        this.#focusDismissed = true;
        this.close();
      });
    }, true);
    this.#listen(document, 'visibilitychange', () => { if (document.hidden) this.close(); });
  }

  /** A different preset updates the existing editor and stops its old held adjustment. */
  render(config, context = null) {
    if (context !== null && (typeof context !== 'string' || !context)) {
      throw new TypeError('A timing context must be a nonempty preset ID or null.');
    }
    this.#values = validateConfig(config);
    if (context !== this.#context) this.#input.finish();
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
    this.#openingFocus = source ? { source, anchor: source.closest?.('[tabindex]'), generation: this.#openingInput } : null;
    return true;
  }

  close({ immediately = false } = {}) {
    this.#clearOpeningFocus();
    this.#input.resetTap();
    this.#input.finish();
    this.#motion.close({ immediately });
  }

  dispose() {
    this.#disposed = true;
    this.#clearOpeningFocus();
    this.#input.resetTap();
    this.#input.finish();
    this.#placement.dispose();
    this.#motion.dispose();
    this.#outsideDismissal.dispose();
    for (const remove of this.#listeners) remove();
    this.#listeners = [];
  }

  #listen(target, type, listener, options = undefined) {
    if (target === this.#document && ['pointerdown', 'click', 'pointerup', 'pointercancel', 'pointermove', 'keydown', 'focusin', 'focusout'].includes(type)) {
      this.#listeners.push(acquireGestureArbiter(this.#document).register({ name: 'duration-popup-' + type,
        priority: ['pointerdown', 'click'].includes(type) ? GESTURE_PRIORITIES.POPUP_COMPLETION : GESTURE_PRIORITIES.POPUP_INPUT,
        handlers: { [type]: listener } }));
      return;
    }
    target.addEventListener(type, listener, options);
    this.#listeners.push(() => target.removeEventListener(type, listener, options));
  }

  #directInteraction() {
    return this.#document.documentElement?.dataset?.devPopupInteraction === 'direct';
  }

  #clearOpeningFocus() {
    this.#openingSource = this.#openingFocus = null;
    this.#openingInput++;
  }

  /** Native label activation can focus its tabpanel before its radio. */
  #isOpeningFocus(target, opening = this.#openingFocus) {
    return Boolean(opening && opening.generation === this.#openingInput && target
      && (opening.source.contains(target) || opening.anchor === target));
  }

  #timingControls(target) {
    const button = target?.closest?.('button');
    if (!button || button.matches(':disabled') || !this.#canChange()) return null;
    return Object.values(this.#controls).find(({ value }) => value === button) ?? null;
  }

  #dismissalSurface() {
    const open = Object.values(this.#controls).find(({ picker }) => picker.matches(':popover-open'));
    if (open) return open.picker;
    if (!this.#directInteraction() && !this.#focusDismissed) return this.#motion.closingSurface;
    return null;
  }

  #insideSurface(event, surface) {
    const path = event.composedPath?.();
    if (path) return path.includes(surface);
    for (let node = event.target; node; node = node.parentElement) if (node === surface) return true;
    return false;
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
      this.#open(phase);
    } else if (button.classList.contains('duration-step')) {
      // A pointer press already changed the value; keyboard/AT clicks have no pointer.
      if (this.#input.consumeClick(event, button)) return;
      this.#step(button);
    }
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
    const focused = this.#document.activeElement;
    const focusWillDisable = value === minimum && [controls.decrease, controls['fine-decrease']].includes(focused)
      || value === maximum && [controls.increase, controls['fine-increase']].includes(focused);
    if (focusWillDisable) {
      // A control becoming disabled loses native focus. Keep this internal edit
      // inside the non-modal popup before the browser dispatches that blur.
      /** @type {HTMLElement} */ (controls['picked-value'].closest('.picker-center')).focus({ preventScroll: true });
    }
    controls.decrease.disabled = value === minimum;
    controls.increase.disabled = value === maximum;
    controls['fine-decrease'].disabled = controls.decrease.disabled;
    controls['fine-increase'].disabled = controls.increase.disabled;
  }

  #open(phase) {
    this.#focusDismissed = false;
    const controls = this.#controls[phase];
    if (controls.picker.matches(':popover-open')) { this.close(); return; }
    const previous = Object.values(this.#controls).find(({ picker }) => picker.matches(':popover-open'));
    if (previous) {
      this.#clearOpeningFocus();
      this.#input.resetTap();
      this.#input.finish();
      this.#motion.transfer(previous, phase);
    } else {
      this.close();
      this.#motion.open(phase);
    }
  }

}
