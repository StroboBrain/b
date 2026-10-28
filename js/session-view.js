import { phaseLabel, spokenDuration } from './phase-labels.js';
import { setPhaseCaption } from './phase-caption.js';
import { setPhaseCount } from './phase-count.js';
import { applyPhaseMotion } from './phase-motion.js';

/** Renders engine snapshots; CSS owns motion and the layout of each state. */
export class SessionView {
  #elements;
  #lastVisualKey = '';
  #lastAnnouncementKey = '';

  constructor({ elements }) {
    if (!elements?.practice || !elements['breathing-orb'] || !elements['hold-fill']) {
      throw new TypeError('SessionView requires the collected practice controls.');
    }
    this.#elements = elements;
  }

  invalidate() { this.#lastVisualKey = ''; }

  render(snapshot, { inhale }) {
    const ui = this.#elements;
    const { status, phase } = snapshot;
    const active = status !== 'idle';
    const visualKey = `${status}:${snapshot.phaseStartedAtMs}:${phase}`;
    const label = active ? phaseLabel(phase) : 'inhale';
    if (visualKey !== this.#lastVisualKey) {
      this.#lastVisualKey = visualKey;
      setPhaseCaption(ui['phase-caption'], status === 'paused' ? `${label} · paused` : label,
        Math.min(420, snapshot.phaseDurationMs * .6 || 420));

      ui.practice.dataset.state = status;
      applyPhaseMotion({ visual: ui['breathing-visual'], stage: ui['exercise-stage'], track: ui['phase-track'],
        orb: ui['breathing-orb'], fill: ui['hold-fill'] }, snapshot);

      for (const step of ui['phase-track'].children) {
        if (active && step.dataset.phase === phase) step.setAttribute('aria-current', 'step');
        else step.removeAttribute('aria-current');
      }
    }

    // Keep an initial fractional duration until its first whole-second boundary.
    const remainingSeconds = Math.min(snapshot.phaseDurationMs / 1000, Math.ceil(snapshot.phaseRemainingMs / 1000));
    setPhaseCount(ui['phase-count'], active ? remainingSeconds : inhale);
    const announcementKey = active ? visualKey : 'idle';
    if (announcementKey !== this.#lastAnnouncementKey) {
      this.#lastAnnouncementKey = announcementKey;
      ui['phase-announcement'].textContent = active
        ? `${status === 'paused' ? 'paused. ' : ''}${label} for ${spokenDuration(remainingSeconds)}.`
        : '';
    }
  }
}
