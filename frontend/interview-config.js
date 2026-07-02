// frontend/interview-config.js
// Carries the choices made on the Practice Interview screen over to the Live screen.
// In-memory only (single session) — the user goes /practice-interview -> /live in one page load.
const DEFAULTS = { scenario: 'job', role: 'Software Engineer', focus: 'Mixed', difficulty: 'Realistic', tone: 'Professional', questionCount: 5, questions: [] };

let current = null;

export function setInterviewConfig(cfg){
  current = { ...DEFAULTS, ...(cfg || {}) };
}

// Returns the last chosen config, or sensible defaults if the user landed on /live
// directly (e.g. a refresh or a deep link) without going through /practice-interview.
export function getInterviewConfig(){
  return current || { ...DEFAULTS };
}
