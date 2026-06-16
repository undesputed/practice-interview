// frontend/interview-config.js
// Carries the choices made on the New-interview screen over to the Live screen.
// In-memory only (single session) — the user goes /new -> /live in one page load.
const DEFAULTS = { role: 'Software Engineer', focus: 'Mixed', difficulty: 'Realistic', questionCount: 5, questions: [] };

let current = null;

export function setInterviewConfig(cfg){
  current = { ...DEFAULTS, ...(cfg || {}) };
}

// Returns the last chosen config, or sensible defaults if the user landed on /live
// directly (e.g. a refresh or a deep link) without going through /new.
export function getInterviewConfig(){
  return current || { ...DEFAULTS };
}
