const REPEAT_DELAY_MS = 400;
const REPEAT_INTERVAL_MS = 100;
const DOUBLE_TAP_MS = 320;
const TAP_DISTANCE_PX = 20;

/** Owns press capture, bounded hold-repeat and the trailing pointer click. */
export class DurationPickerInput {
  #window;
  #controls;
  #canChange;
  #step;
  #press = null;
  #pointerClick = null;
  #tapPress = null;
  #lastTap = null;
  #onDismiss;

  /** @param {{window:Pick<Window,'setTimeout'|'clearTimeout'>,
   * controls:Record<string,import('./duration-picker-placement.js').PickerControls>,
   * canChange:()=>boolean, step:(button:HTMLButtonElement)=>boolean,
   * onDismiss:(controls:import('./duration-picker-placement.js').PickerControls,consumeClick?:boolean)=>void}} options */
  constructor({ window, controls, canChange, step, onDismiss }) {
    if (typeof window?.setTimeout !== 'function' || typeof window.clearTimeout !== 'function'
      || !controls || typeof canChange !== 'function' || typeof step !== 'function' || typeof onDismiss !== 'function') {
      throw new TypeError('DurationPickerInput requires timers, controls and adjustment callbacks.');
    }
    this.#window = window;
    this.#controls = controls;
    this.#canChange = canChange;
    this.#step = step;
    this.#onDismiss = onDismiss;
  }

  /** Pointer presses adjust immediately; keyboard and AT clicks still adjust once. */
  consumeClick(event, button) {
    if (event.detail === 0 || this.#pointerClick !== button) return false;
    this.#pointerClick = null;
    return true;
  }

  #startPress(event) {
    const button = event.target.closest('.duration-step');
    if (!button || event.button !== 0 || event.isPrimary === false
      || button.matches(':disabled') || !this.#canChange()
      || this.#controls[button.dataset.field]?.picker.dataset.closing === 'true') return;
    this.finish();
    this.#pointerClick = button;
    if (!this.#step(button)) return;
    // A step can disable its own target before native pointer focus runs.
    // Suppress only that default so focus cannot fall through to the page.
    if (button.matches(':disabled')) event.preventDefault?.();
    const press = { button, pointerId: event.pointerId, timer: null };
    this.#press = press;
    button.setPointerCapture?.(event.pointerId);
    const repeat = () => {
      if (this.#press !== press) return;
      if (button.matches(':disabled') || !this.#canChange() || !this.#step(button)) {
        this.finish();
        return;
      }
      press.timer = this.#window.setTimeout(repeat, REPEAT_INTERVAL_MS);
    };
    press.timer = this.#window.setTimeout(repeat, REPEAT_DELAY_MS);
  }

  finish(pointerId) {
    const press = this.#press;
    if (!press || (pointerId !== undefined && pointerId !== press.pointerId)) return;
    this.#press = null;
    this.#window.clearTimeout(press.timer);
    if (press.button.hasPointerCapture?.(press.pointerId)) press.button.releasePointerCapture(press.pointerId);
  }

  start(event) { if (!this.#startTap(event)) this.#startPress(event); }

  release(event) { this.#endTap(event); this.finish(event.pointerId); }

  cancel(event) { this.resetTap(); this.finish(event.pointerId); }

  resetTap() { this.#tapPress = this.#lastTap = null; }

  move(event) {
    const press = this.#tapPress;
    if (press && press.id === event.pointerId && Math.hypot(event.clientX - press.x, event.clientY - press.y) > TAP_DISTANCE_PX) this.resetTap();
  }

  doubleClick(event) {
    const controls = this.#controlsForTarget(event.target);
    if (!controls?.picker.matches(':popover-open') || event.target?.closest?.('.duration-step')) return;
    event.preventDefault();
    this.#onDismiss(controls);
  }

  #controlsForTarget(target) {
    const picker = target?.closest?.('.duration-picker');
    return picker && Object.values(this.#controls).find(controls => controls.picker === picker);
  }

  /** Nearby taps dismiss the popup surface; adjustment buttons accept every press. */
  #startTap(event) {
    if (event.button !== 0 || event.isPrimary === false) return false;
    const controls = this.#controlsForTarget(event.target);
    if (!controls?.picker.matches(':popover-open') || event.target?.closest?.('.duration-step')) {
      this.#tapPress = this.#lastTap = null;
      return false;
    }
    const time = event.timeStamp ?? Date.now();
    const previous = this.#lastTap;
    if (previous?.controls === controls && time - previous.time >= 0 && time - previous.time <= DOUBLE_TAP_MS
      && Math.hypot(event.clientX - previous.x, event.clientY - previous.y) <= TAP_DISTANCE_PX) {
      this.#onDismiss(controls, true);
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

}
