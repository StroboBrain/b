import { PHASES, validateConfig } from './breathing-engine.js';
import { phaseDescription } from './phase-labels.js';

const REPEAT_DELAY_MS = 400;
const REPEAT_INTERVAL_MS = 100;

/** Timing controls only. The caller owns editing policy and persistence.
 * Render a validated configuration before using the controls. Each pointer
 * gesture commits once; dismissing the picker also commits pending changes.
 */
export class DurationPicker {
  #window;
  #controls;
  #onChange;
  #onCommit;
  #canChange;
  #values;
  #dirty = false;
  #press = null;
  #pointerClick = null;
  #listeners = [];

  constructor({ document, window, container, onChange, onCommit, canChange = () => true } = {}) {
    if (typeof document?.getElementById !== 'function' || typeof document.addEventListener !== 'function'
      || typeof window?.addEventListener !== 'function' || typeof window.setTimeout !== 'function'
      || typeof window.clearTimeout !== 'function' || typeof container?.addEventListener !== 'function') {
      throw new TypeError('DurationPicker requires a document, window and timing container.');
    }
    if ([onChange, onCommit, canChange].some((callback) => typeof callback !== 'function')) {
      throw new TypeError('DurationPicker requires change, commit and editing callbacks.');
    }
    this.#window = window;
    this.#onChange = onChange;
    this.#onCommit = onCommit;
    this.#canChange = canChange;
    this.#controls = Object.fromEntries(PHASES.map((phase) => {
      const controls = Object.fromEntries(['value', 'picker', 'picked-value', 'decrease', 'increase', 'slider', 'fine-decrease', 'fine-increase']
        .map((suffix) => [suffix, document.getElementById(`${phase}-${suffix}`)]));
      if (Object.values(controls).some((element) => !element)) {
        throw new Error(`DurationPicker is missing controls for ${phase}.`);
      }
      controls.choices = [...container.querySelectorAll(`.time-choice[data-field="${phase}"]`)];
      return [phase, controls];
    }));

    this.#listen(container, 'pointerdown', (event) => this.#startPress(event));
    this.#listen(container, 'click', (event) => this.#click(event));
    this.#listen(container, 'input', (event) => this.#slide(event));
    this.#listen(container, 'change', (event) => {
      if (event.target.classList.contains('duration-slider')) this.#commit();
    });
    this.#listen(document, 'pointerup', (event) => this.#finishPress(event.pointerId));
    this.#listen(document, 'pointercancel', (event) => this.#finishPress(event.pointerId));
    this.#listen(container, 'lostpointercapture', (event) => this.#finishPress(event.pointerId));
    this.#listen(document, 'scroll', () => this.close(), true);
    this.#listen(window, 'resize', () => this.close());
    this.#listen(window, 'blur', () => this.#finishPress());
    this.#listen(document, 'visibilitychange', () => { if (document.hidden) this.close(); });
    for (const controls of Object.values(this.#controls)) {
      this.#listen(controls.picker, 'toggle', () => {
        const open = controls.picker.matches(':popover-open');
        controls.value.setAttribute('aria-expanded', String(open));
        if (!open) {
          this.#finishPress();
          this.#commit();
        }
      });
    }
  }

  render(config) {
    this.#values = validateConfig(config);
    for (const phase of PHASES) this.#renderValue(phase);
  }

  close() {
    this.#finishPress();
    for (const { picker } of Object.values(this.#controls)) {
      if (picker.matches(':popover-open')) picker.hidePopover();
    }
    this.#commit();
  }

  dispose() {
    this.close();
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
    if (button.classList.contains('duration-button')) {
      this.#open(phase);
    } else if (button.classList.contains('time-choice')) {
      this.#setValue(phase, Number(button.dataset.value));
      this.#commit();
    } else if (button.classList.contains('duration-step')) {
      // A pointer press already changed the value; keyboard/AT clicks have no pointer.
      if (event.detail !== 0 && this.#pointerClick === button) {
        this.#pointerClick = null;
        return;
      }
      this.#step(button);
      this.#commit();
    }
  }

  #startPress(event) {
    const button = event.target.closest('.duration-step');
    if (!button || event.button !== 0 || event.isPrimary === false
      || button.matches(':disabled') || !this.#canChange()) return;
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

  #slide(event) {
    const slider = event.target;
    const phase = slider.dataset.field;
    if (!slider.classList.contains('duration-slider') || !PHASES.includes(phase)) return;
    if (slider.matches(':disabled') || !this.#canChange()) {
      this.#renderValue(phase);
      return;
    }
    const minimum = phase.startsWith('hold') ? 0 : 1;
    const value = Math.max(minimum, Math.min(60, Math.round(Number(slider.value) * 10) / 10));
    if (Number.isFinite(value)) this.#setValue(phase, value);
  }

  #finishPress(pointerId) {
    const press = this.#press;
    if (!press || (pointerId !== undefined && pointerId !== press.pointerId)) return;
    this.#press = null;
    this.#window.clearTimeout(press.timer);
    if (press.button.hasPointerCapture?.(press.pointerId)) press.button.releasePointerCapture(press.pointerId);
    this.#commit();
  }

  #step(button) {
    const phase = button.dataset.field;
    if (!this.#values || !PHASES.includes(phase)) return false;
    const value = Math.max(phase.startsWith('hold') ? 0 : 1,
      Math.min(60, Math.round((this.#values[phase] + Number(button.dataset.step)) * 10) / 10));
    return this.#setValue(phase, value);
  }

  #setValue(phase, value) {
    if (!this.#values || this.#values[phase] === value) return false;
    this.#values = validateConfig({ ...this.#values, [phase]: value });
    this.#dirty = true;
    this.#renderValue(phase);
    this.#onChange(phase, value);
    return true;
  }

  #commit() {
    if (!this.#dirty) return;
    this.#dirty = false;
    this.#onCommit();
  }

  #renderValue(phase) {
    const controls = this.#controls[phase];
    const value = this.#values[phase];
    const duration = value === 0 ? 'off' : `${value}s`;
    controls.value.value = value;
    controls.value.textContent = duration;
    controls.value.setAttribute('aria-label', `adjust ${phaseDescription(phase)} duration, ${value === 0 ? 'off' : `${value} seconds`}`);
    controls.value.closest('.timing-field').classList.toggle('is-off', value === 0);
    controls['picked-value'].value = duration;
    controls.slider.value = String(value);
    controls.slider.setAttribute('aria-valuetext', value === 0 ? 'off' : `${value} seconds`);
    controls.decrease.disabled = value === (phase.startsWith('hold') ? 0 : 1);
    controls.increase.disabled = value === 60;
    controls['fine-decrease'].disabled = controls.decrease.disabled;
    controls['fine-increase'].disabled = controls.increase.disabled;
    for (const choice of controls.choices) {
      choice.setAttribute('aria-pressed', String(Number(choice.dataset.value) === value));
    }
  }

  #open(phase) {
    const { value: trigger, picker, increase } = this.#controls[phase];
    if (picker.matches(':popover-open')) {
      picker.hidePopover();
      return;
    }
    trigger.focus({ preventScroll: true });
    picker.showPopover();
    const anchor = trigger.getBoundingClientRect();
    const viewport = this.#window.visualViewport;
    const left = viewport?.offsetLeft ?? 0;
    const top = viewport?.offsetTop ?? 0;
    const width = viewport?.width ?? this.#window.innerWidth;
    const height = viewport?.height ?? this.#window.innerHeight;
    picker.style.left = `${Math.max(left + 8, Math.min(anchor.left + anchor.width / 2 - picker.offsetWidth / 2, left + width - picker.offsetWidth - 8))}px`;
    picker.style.top = `${Math.max(top + 8, Math.min(anchor.top + anchor.height / 2 - picker.offsetHeight / 2, top + height - picker.offsetHeight - 8))}px`;
    const focus = increase.disabled ? this.#controls[phase].decrease : increase;
    focus.focus({ preventScroll: true });
  }
}
