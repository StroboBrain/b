import { validateTenths } from './breathing-engine.js';

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

/** Compact duration for timing controls; zero disables a hold. */
export function formatDuration(value) {
  const seconds = durationSeconds(value);
  return seconds === 0 ? 'off' : `${seconds}s`;
}

/** Spoken duration; callers describe skipped phases in their own context. */
export function spokenDuration(value) {
  const seconds = durationSeconds(value);
  return seconds === 0 ? 'off' : `${seconds} seconds`;
}

/** Accept the same 0–99 second tenths used by validated breathing configurations. */
function durationSeconds(value) {
  return validateTenths(value, 0, 99, 'A duration');
}
