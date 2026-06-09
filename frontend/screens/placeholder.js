// Builds a Clean Studio placeholder screen. Replaced per-screen in later phases.
import { esc } from '../util.js';

// `title` and `note` are trusted developer literals (from registry.js), so they
// are interpolated as-is. Any DYNAMIC value (like `params.id`) MUST be wrapped in
// esc() before going into an HTML string.
export function placeholder(title, note){
  return (params) => {
    const idSuffix = params && params.id ? ' · ' + esc(params.id) : '';
    return '' +
      '<div class="screen">' +
        '<div class="screen-head"><h1>' + title + idSuffix + '</h1></div>' +
        '<div class="placeholder-card">' +
          '<p>' + note + '</p>' +
          '<p class="muted">Placeholder — this screen is built in a later phase.</p>' +
        '</div>' +
      '</div>';
  };
}
