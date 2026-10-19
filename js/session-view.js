import { phaseLabel } from './phase-labels.js';

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

  render(snapshot, { inhale, storageWarning }) {
    const ui = this.#elements;
    const { status, phase } = snapshot;
    const running = status === 'running';
    const active = status !== 'idle';
    const visualKey = `${status}:${snapshot.phaseStartedAtMs}:${phase}`;
    const label = active ? phaseLabel(phase) : 'inhale';
    if (visualKey !== this.#lastVisualKey) {
      this.#lastVisualKey = visualKey;
      ui['settings-fields'].disabled = active;
      ui['preset-fields'].disabled = active;
      ui['session-button'].disabled = false;
      ui['session-button-label'].textContent = running ? 'stop' : status === 'paused' ? 'resume' : 'start';
      ui['session-button-icon'].className = running ? 'icon-stop' : 'icon-play';
      ui['phase-caption'].textContent = status === 'paused' ? `${label} · paused` : label;
      ui['settings-note'].textContent = storageWarning ? 'storage unavailable. changes are for this visit.' : '';

      const visual = ui['breathing-visual'];
      visual.dataset.state = status;
      ui.practice.dataset.state = status;
      visual.dataset.phase = phase ?? 'inhale';
      visual.style.setProperty('--phase-duration', `${snapshot.phaseDurationMs}ms`);
      visual.style.setProperty('--phase-delay', `${-snapshot.phaseElapsedMs}ms`);
      // Restart the CSS animation at the engine's elapsed offset, including after pause.
      const orb = ui['breathing-orb'];
      const animations = [orb, ui['hold-fill'], ui['hold-fill'].parentElement];
      for (const element of animations) element.style.animationName = 'none';
      void orb.offsetWidth;
      for (const element of animations) element.style.animationName = '';

      for (const step of ui['phase-track'].children) {
        if (active && step.dataset.phase === phase) step.setAttribute('aria-current', 'step');
        else step.removeAttribute('aria-current');
      }
    }

    const count = active ? String(Math.ceil(snapshot.phaseRemainingMs / 1000)) : String(inhale);
    if (ui['phase-count'].textContent !== count) ui['phase-count'].textContent = count;
    const announcementKey = active ? visualKey : 'idle';
    if (announcementKey !== this.#lastAnnouncementKey) {
      this.#lastAnnouncementKey = announcementKey;
      ui['phase-announcement'].textContent = active
        ? `${status === 'paused' ? 'paused. ' : ''}${label} for ${Math.ceil(snapshot.phaseRemainingMs / 1000)} seconds.`
        : '';
    }
  }
}
