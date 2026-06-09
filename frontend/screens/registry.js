import { placeholder } from './placeholder.js';
import { dashboard } from './dashboard.js';
import { history } from './history.js';
import { report } from './report.js';
import { facial } from './facial.js';

// Route pattern -> render(params) => htmlString. Phase 1 = placeholders.
export const screens = [
  ['/',            dashboard],
  ['/history',     history],
  ['/progress',    placeholder('Progress', 'Trends across all sessions.')],
  ['/new',         placeholder('New interview', 'Camera/mic check and role pick.')],
  ['/live',        placeholder('Live interview', 'The recording screen.')],
  ['/session/:id', report],
  ['/facial',      facial],
  ['/audio',       placeholder('Audio & Transcript Analysis', 'Live Deepgram instrument.')],
  ['/settings',    placeholder('Settings', 'Toggles and preferences.')],
  ['/library',     placeholder('Role & question library', 'Manage interview roles and questions.')],
];
