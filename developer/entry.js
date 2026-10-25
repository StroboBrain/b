import { DeveloperMode } from './developer-mode.js';

// This entry and the entire developer directory are omitted from release builds.
// The preceding module script initializes the app and reports any startup failure.
if (!document.getElementById('app-shell')?.hidden) {
  new DeveloperMode({ document, window });
}
