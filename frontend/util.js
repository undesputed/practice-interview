// Shared frontend helpers.

// Escape a value for safe interpolation into an innerHTML string.
// Use this on ANY dynamic/user-controlled value before putting it in HTML.
export function esc(value){
  return String(value).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}
