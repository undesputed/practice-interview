import { placeholder } from './placeholder.js';

// Route pattern -> render(params) => htmlString. Phase 1 = placeholders.
export const screens = [
  ['/',            placeholder('Dashboard', 'Overview, headline stats, and recent sessions.')],
  ['/history',     placeholder('History', 'All saved sessions in a sortable table.')],
  ['/progress',    placeholder('Progress', 'Trends across all sessions.')],
  ['/new',         placeholder('New interview', 'Camera/mic check and role pick.')],
  ['/live',        placeholder('Live interview', 'The recording screen.')],
  ['/session/:id', placeholder('Session report', 'A single saved session report.')],
  ['/facial',      placeholder('Facial Analysis', 'Live MediaPipe instrument (Face / Pose / Hands).')],
  ['/audio',       placeholder('Audio & Transcript Analysis', 'Live Deepgram instrument.')],
  ['/settings',    placeholder('Settings', 'Toggles and preferences.')],
  ['/library',     placeholder('Role & question library', 'Manage interview roles and questions.')],
];
