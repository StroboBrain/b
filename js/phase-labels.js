const DESCRIPTIONS = Object.freeze({
  inhale: 'inhale',
  holdIn: 'hold after inhale',
  exhale: 'exhale',
  holdOut: 'hold after exhale',
});

/** The complete phase name, suitable for controls and spoken instructions. */
export function phaseDescription(phase) {
  if (!Object.hasOwn(DESCRIPTIONS, phase)) throw new RangeError('Choose a supported breathing phase.');
  return DESCRIPTIONS[phase];
}

/** Compact phase name for the orb caption. */
export function phaseLabel(phase) {
  return phaseDescription(phase).startsWith('hold') ? 'hold' : phase;
}
