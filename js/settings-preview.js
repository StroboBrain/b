import { BreathingEngine, DEFAULT_CONFIG, PHASES, configsEqual, validateConfig } from './breathing-engine.js';
import { DEFAULT_PREFERENCES } from './preset-store.js';
import { SessionDriver } from './session-driver.js';
import { formatDuration, phaseLabel } from './phase-labels.js';

/** A silent live sample; it runs only while the separate settings page is visible. */
export class SettingsPreview {
  #document;
  #window;
  #container;
  #visual;
  #orb;
  #fill;
  #track;
  #caption;
  #count;
  #driver;
  #wide;
  #observer;
  #config = { ...DEFAULT_CONFIG };
  #preferences = { ...DEFAULT_PREFERENCES };
  #visible = false;
  #enabled = true;
  #active = false;
  #visualKey = '';
  #listeners = [];

  constructor({ document, window, container } = {}) {
    if (!container?.querySelector || !document?.addEventListener || !window?.matchMedia
      || typeof window.IntersectionObserver !== 'function') {
      throw new TypeError('SettingsPreview requires a document, window and preview container.');
    }
    this.#document = document;
    this.#window = window;
    this.#container = container;
    this.#visual = container.querySelector('.breathing-visual');
    this.#orb = container.querySelector('.breathing-orb');
    this.#fill = container.querySelector('.hold-fill');
    this.#track = container.querySelector('.phase-track');
    this.#caption = container.querySelector('.phase-caption');
    this.#count = container.querySelector('.phase-count');
    if ([this.#visual, this.#orb, this.#fill, this.#track, this.#caption, this.#count].some(node => !node)) {
      throw new Error('The settings preview is missing its breathing controls.');
    }
    this.#driver = new SessionDriver({
      engine: new BreathingEngine({ now: () => window.performance.now() }),
      setTimeout: window.setTimeout.bind(window), clearTimeout: window.clearTimeout.bind(window),
      onChange: snapshot => this.#render(snapshot),
    });
    this.#wide = window.matchMedia('(min-width: 1000px) and (hover: hover) and (pointer: fine)');
    this.#listen(this.#wide, 'change', () => this.#sync());
    this.#listen(document, 'visibilitychange', () => this.#sync());
    this.#listen(window, 'pagehide', () => this.#stop());
    this.#listen(window, 'pageshow', () => this.#sync());
    this.#observer = new window.IntersectionObserver(entries => {
      this.#visible = entries.some(entry => entry.target === container && entry.isIntersecting);
      this.#sync();
    }, { threshold: 0.01 });
    this.#observer.observe(container);
    this.configure(this.#config, this.#preferences);
  }

  configure(config, preferences) {
    const next = validateConfig(config);
    if (!preferences || typeof preferences !== 'object') throw new TypeError('Provide display preferences.');
    const timingChanged = !configsEqual(next, this.#config);
    const preferencesChanged = JSON.stringify(preferences) !== JSON.stringify(this.#preferences);
    this.#config = next;
    this.#preferences = { ...preferences };
    const data = this.#container.dataset;
    data.showText = String(preferences.showBreathText);
    data.showTime = String(preferences.showBreathNumbers);
    data.showTimings = String(preferences.showPhaseTimings);
    data.fadeButtons = String(preferences.fadeButtons);
    this.#visual.dataset.holdFeedback = preferences.holdFeedback;
    for (const guide of this.#container.querySelectorAll('.breath-guide')) guide.hidden = !preferences.showBreathGuides;
    for (const step of this.#track.children) {
      step.querySelector('.phase-time').textContent = formatDuration(next[step.dataset.phase]);
      step.classList.toggle('is-skipped', next[step.dataset.phase] === 0);
    }
    if (timingChanged && this.#active) {
      this.#visualKey = '';
      this.#driver.start(next);
      this.#restartFade();
    } else {
      this.#render(this.#driver.snapshot);
      if (preferencesChanged && this.#active) this.#restartFade();
    }
  }

  setEnabled(enabled) {
    if (typeof enabled !== 'boolean') throw new TypeError('Preview availability must be a boolean.');
    if (this.#enabled === enabled) return;
    this.#enabled = enabled;
    this.#sync();
  }

  dispose() {
    this.#enabled = false;
    this.#stop();
    this.#observer.disconnect();
    for (const remove of this.#listeners) remove();
    this.#listeners = [];
  }

  #listen(target, type, callback) {
    target.addEventListener(type, callback);
    this.#listeners.push(() => target.removeEventListener(type, callback));
  }

  #sync() {
    const run = this.#enabled && this.#visible && !this.#wide.matches && !this.#document.hidden;
    if (run === this.#active) return;
    if (!run) { this.#stop(); return; }
    this.#active = true;
    this.#driver.start(this.#config);
    this.#restartFade();
  }

  #stop() {
    if (!this.#active) return;
    this.#active = false;
    this.#driver.stop();
  }

  #restartFade() {
    const controls = this.#container.querySelectorAll('.orb-copy, .preview-session-button, .phase-timings');
    for (const control of controls) control.style.animationName = 'none';
    void this.#container.offsetWidth;
    for (const control of controls) control.style.animationName = '';
  }

  #render(snapshot) {
    const running = snapshot.status === 'running';
    const phase = snapshot.phase ?? PHASES[0];
    const key = `${snapshot.status}:${snapshot.phaseStartedAtMs}:${phase}`;
    if (key !== this.#visualKey) {
      this.#visualKey = key;
      this.#visual.dataset.state = running ? 'running' : 'idle';
      this.#visual.dataset.phase = phase;
      this.#visual.style.setProperty('--phase-duration', `${snapshot.phaseDurationMs}ms`);
      this.#visual.style.setProperty('--phase-delay', `${-snapshot.phaseElapsedMs}ms`);
      const animated = [this.#orb, this.#fill, this.#fill.parentElement];
      for (const node of animated) node.style.animationName = 'none';
      void this.#orb.offsetWidth;
      for (const node of animated) node.style.animationName = '';
      for (const step of this.#track.children) {
        if (running && step.dataset.phase === phase) step.setAttribute('aria-current', 'step');
        else step.removeAttribute('aria-current');
      }
    }
    this.#caption.textContent = phaseLabel(phase);
    this.#count.textContent = String(running
      ? Math.min(snapshot.phaseDurationMs / 1000, Math.ceil(snapshot.phaseRemainingMs / 1000))
      : this.#config.inhale);
  }
}
