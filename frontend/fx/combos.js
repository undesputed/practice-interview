// frontend/fx/combos.js
// Two-hand gesture combos: pure data (gesture pair -> id/text/color) + a matcher. No DOM.
export const GESTURE_COMBOS = {
  awesome: { gestures: ['Thumb_Up', 'Thumb_Up'], text: 'AWESOME!', color: '#3ddc84' },
  big_no:  { gestures: ['Thumb_Down', 'Thumb_Down'], text: 'BIG NO', color: '#ff5c5c' },
  peace:   { gestures: ['Victory', 'Victory'], text: 'PEACE ✌', color: '#ffd54a' },
  pumped:  { gestures: ['Closed_Fist', 'Closed_Fist'], text: 'PUMPED!', color: '#ff9f43' },
  woo:     { gestures: ['Open_Palm', 'Open_Palm'], text: 'WOO!', color: '#7fc7ff' },
  love:    { gestures: ['ILoveYou', 'ILoveYou'], text: 'LOVE!!', color: '#c98bff' },
  double_point: { gestures: ['Pointing_Up', 'Pointing_Up'], text: 'EUREKA!', color: '#ffd54a' },
  mixed:   { gestures: ['Thumb_Up', 'Thumb_Down'], text: 'MIXED', color: '#ffe08a' },
};

// Order-independent multiset match over the two hands' gestures. Returns a combo id or null.
export function detectCombo(gestures) {
  const active = (gestures || []).filter((g) => g && g !== 'None');
  if (active.length < 2) return null;
  const sorted = [...active].sort();
  for (const id in GESTURE_COMBOS) {
    const want = [...GESTURE_COMBOS[id].gestures].sort();
    if (want.length === sorted.length && want.every((g, i) => g === sorted[i])) return id;
  }
  return null;
}
