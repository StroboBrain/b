import { BreathingApp } from './app.js';
import { ViewportLayout } from './viewport-layout.js';
import { PortraitOrientation } from './portrait-orientation.js';

const appShell = document.getElementById('app-shell');

try {
  if (!appShell) throw new Error('index.html is missing required id: app-shell');
  new BreathingApp();
  // Restore settings and render before exposing any default markup. Complete
  // viewport measurement in this same task, before the browser can paint.
  appShell.hidden = false;
  new ViewportLayout();
  new PortraitOrientation();
} catch (error) {
  if (appShell) appShell.hidden = true;
  document.getElementById('startup-error')?.removeAttribute('hidden');
  throw error;
}
