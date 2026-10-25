import { phaseLabel, spokenDuration } from './phase-labels.js';
import { setPhaseCaption } from './phase-caption.js';

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
    const running = status === 'running';
    const active = status !== 'idle';
    const visualKey = `${status}:${snapshot.phaseStartedAtMs}:${phase}`;
    const label = active ? phaseLabel(phase) : 'inhale';
    if (visualKey !== this.#lastVisualKey) {
      this.#lastVisualKey = visualKey;
      ui['preset-fields'].disabled = active;
      ui['timing-fields'].disabled = active;
      ui['session-button'].disabled = false;
      ui['session-button-label'].textContent = running ? 'stop' : status === 'paused' ? 'resume' : 'start';
      ui['session-button-icon'].className = 'icon-play';
      setPhaseCaption(ui['phase-caption'], status === 'paused' ? `${label} · paused` : label,
        Math.min(420, snapshot.phaseDurationMs * .6 || 420));

      const visual = ui['breathing-visual'];
      visual.dataset.state = status;
      ui.practice.dataset.state = status;
      visual.dataset.phase = phase ?? 'inhale';
      visual.style.setProperty('--phase-duration', `${snapshot.phaseDurationMs}ms`);
      visual.style.setProperty('--phase-delay', `${-snapshot.phaseElapsedMs}ms`);
      ui['exercise-stage']?.style.setProperty('--phase-duration', `${snapshot.phaseDurationMs}ms`);
      ui['exercise-stage']?.style.setProperty('--phase-delay', `${-snapshot.phaseElapsedMs}ms`);
      // Restart the CSS animation at the engine's elapsed offset, including after pause.
      const orb = ui['breathing-orb'];
      const animations = [orb, ui['hold-fill'], ui['hold-fill'].parentElement];
      for (const element of animations) element.style.animationName = 'none';
      ui['phase-track'].style.setProperty('--timing-animation-name', 'none');
      void orb.offsetWidth;
      for (const element of animations) element.style.animationName = '';
      ui['phase-track'].style.setProperty('--timing-animation-name', 'hold-fill');

      for (const step of ui['phase-track'].children) {
        if (active && step.dataset.phase === phase) step.setAttribute('aria-current', 'step');
        else step.removeAttribute('aria-current');
      }
    }

    // Keep an initial fractional duration until its first whole-second boundary.
    const remainingSeconds = Math.min(snapshot.phaseDurationMs / 1000, Math.ceil(snapshot.phaseRemainingMs / 1000));
    const count = active ? String(remainingSeconds) : String(inhale);
    if (ui['phase-count'].textContent !== count) ui['phase-count'].textContent = count;
    const announcementKey = active ? visualKey : 'idle';
    if (announcementKey !== this.#lastAnnouncementKey) {
      this.#lastAnnouncementKey = announcementKey;
      ui['phase-announcement'].textContent = active
        ? `${status === 'paused' ? 'paused. ' : ''}${label} for ${spokenDuration(remainingSeconds)}.`
        : '';
    }
  }
}
