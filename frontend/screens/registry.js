import { placeholder } from './placeholder.js';
import { dashboard } from './dashboard.js';
import { history } from './history.js';
import { report } from './report.js';
import { facial } from './facial.js';
import { progress } from './progress.js';
import { newInterview } from './new.js';
import { live } from './live.js';
import { thanks } from './thanks.js';

// Route pattern -> render(params) => htmlString. Phase 1 = placeholders.
export const screens = [
  ['/',            dashboard],
  ['/history',     history],
  ['/progress',    progress],
  ['/new',         newInterview],
  ['/live',        live],
  ['/thanks/:id',  thanks],
  ['/thanks',      thanks],
  ['/session/:id', report],
  ['/facial',      facial],
  ['/audio',       placeholder('Audio & Transcript Analysis', 'Live Deepgram instrument.')],
  ['/settings',    placeholder('Settings', 'Toggles and preferences.')],
  ['/library',     placeholder('Role & question library', 'Manage interview roles and questions.')],
];
