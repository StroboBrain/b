import { BreathingApp } from './app.js';

try {
  new BreathingApp();
} catch (error) {
  // A broken build must not leave a silently disabled Start button.
  const message = 'the app could not start. reload the page.';
  document.getElementById('phase-caption')?.replaceChildren(message);
  document.getElementById('phase-announcement')?.replaceChildren(message);
  throw error;
}
