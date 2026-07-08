// Tiny cross-screen payload store: live.js deposits the interview payload here so
// thanks.js can pick it up and fire the scoring POST without keeping the user on the
// camera screen while Claude runs.
let _payload = null;
export function setPendingSession(p) { _payload = p; }
export function takePendingSession() { const p = _payload; _payload = null; return p; }
export function peekPendingSession() { return _payload; }
