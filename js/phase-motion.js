/** Apply one phase to the shared visual; callers own captions, controls and active timing cards. */
export function applyPhaseMotion({ visual, stage, track, orb, fill }, snapshot) {
  visual.dataset.state = snapshot.status;
  visual.dataset.phase = snapshot.phase ?? 'inhale';
  for (const node of [visual, stage]) {
    node?.style.setProperty('--phase-duration', `${snapshot.phaseDurationMs}ms`);
    node?.style.setProperty('--phase-delay', `${-snapshot.phaseElapsedMs}ms`);
  }
  const animated = [orb, fill, fill.parentElement];
  for (const node of animated) node.style.animationName = 'none';
  track.style.setProperty('--timing-animation-name', 'none');
  // Restart both the orb and timing fill at the snapshot's elapsed offset.
  void visual.offsetWidth;
  for (const node of animated) node.style.animationName = '';
  track.style.setProperty('--timing-animation-name', 'hold-fill');
}
