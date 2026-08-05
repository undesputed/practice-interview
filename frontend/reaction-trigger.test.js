import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReactionTrigger, confusedScore } from './reaction-trigger.js';
import { emotionScores, emotionRawMax } from './emotion.js';

// Inject scores directly: the sample's bs IS the score object; confused comes from bs.confused.
// Bypass raw-strength with a high default so state-machine tests stay score-driven.
const HOLD = 120;
const opts = {
  scores: (bs) => bs,
  confusedScore: (bs) => bs.confused || 0,
  rawStrength: (bs) => (bs._raw == null ? 1 : bs._raw),
  holdMs: HOLD,
};

const S = (o) => ({ happy: 0, sad: 0, surprise: 0, angry: 0, disgust: 0, fear: 0, confused: 0, ...o });

// Feed the same emotion from t0 through t0+holdMs (inclusive of the fire frame).
function holdUntil(t, bs, t0 = 0) {
  let r;
  for (let ms = 0; ms <= HOLD; ms += 20) r = t.feed({ bs, t: t0 + ms });
  return r;
}

// ── emotion state machine (hold-to-fire) ──
test('emotion activates only after HOLD_MS of continuous presence', () => {
  const t = createReactionTrigger(opts);
  assert.equal(t.feed({ bs: S({ sad: 80 }), t: 0 }).activeEmotion, null);
  assert.equal(t.feed({ bs: S({ sad: 80 }), t: 100 }).activeEmotion, null);
  assert.equal(t.feed({ bs: S({ sad: 80 }), t: 119 }).activeEmotion, null);
  assert.equal(t.feed({ bs: S({ sad: 80 }), t: 120 }).activeEmotion, 'sad');
});

test('breaking the hold before HOLD_MS resets the timer', () => {
  const t = createReactionTrigger(opts);
  t.feed({ bs: S({ sad: 80 }), t: 0 });
  t.feed({ bs: S({ sad: 80 }), t: 60 });
  t.feed({ bs: S({ sad: 10 }), t: 70 }); // drop — reset
  assert.equal(t.feed({ bs: S({ sad: 80 }), t: 80 }).activeEmotion, null);
  assert.equal(t.feed({ bs: S({ sad: 80 }), t: 180 }).activeEmotion, null); // 100ms into new hold
  assert.equal(t.feed({ bs: S({ sad: 80 }), t: 200 }).activeEmotion, 'sad');
});

test('emotion holds through hysteresis, exits below exit', () => {
  const t = createReactionTrigger(opts);
  holdUntil(t, S({ sad: 80 }));
  assert.equal(t.feed({ bs: S({ sad: 30 }), t: 200 }).activeEmotion, 'sad');
  assert.equal(t.feed({ bs: S({ sad: 20 }), t: 210 }).activeEmotion, null);
});

test('confused is selected when strongest and no rival classifier', () => {
  const t = createReactionTrigger(opts);
  assert.equal(holdUntil(t, S({ confused: 70 })).activeEmotion, 'confused');
});

test('confused is suppressed when angry is clearly present', () => {
  const t = createReactionTrigger(opts);
  assert.equal(holdUntil(t, S({ angry: 74, confused: 99 })).activeEmotion, 'angry');
});

test('confusedScore ignores brow-only anger-like faces', () => {
  assert.equal(confusedScore({
    browDownLeft: 0.7, browDownRight: 0.7,
    mouthPressLeft: 0.5, mouthPressRight: 0.5,
    eyeSquintLeft: 0.5, eyeSquintRight: 0.5,
  }), 0);
  assert.ok(confusedScore({
    browDownLeft: 0.55, browDownRight: 0.5,
    mouthPressLeft: 0.25, mouthPressRight: 0.2,
    eyeSquintLeft: 0.05, eyeSquintRight: 0.05,
  }) >= 35);
});

test('low raw strength blocks activation even when held', () => {
  const t = createReactionTrigger(opts);
  assert.equal(holdUntil(t, S({ happy: 95, _raw: 0.10 })).activeEmotion, null);
});

test('small lead over runner-up blocks activation', () => {
  const t = createReactionTrigger(opts);
  // lead 3 < LEAD_MARGIN 6
  assert.equal(holdUntil(t, S({ happy: 50, sad: 47 })).activeEmotion, null);
});

test('brief dip during hold does not reset the timer', () => {
  const t = createReactionTrigger({ ...opts, holdGraceMs: 60 });
  t.feed({ bs: S({ sad: 80 }), t: 0 });
  t.feed({ bs: S({ sad: 80 }), t: 50 });
  t.feed({ bs: S({ sad: 30 }), t: 80 }); // still above exit — grace
  assert.equal(t.feed({ bs: S({ sad: 80 }), t: 120 }).activeEmotion, 'sad');
});

test('real brow-furrow angry face fires after HOLD_MS', () => {
  // Typical camera anger: brow down, little eyeWide (FACS AU5) — previously failed rawMax.
  const angry = {
    browDownLeft: 0.55, browDownRight: 0.5,
    eyeSquintLeft: 0.2, eyeSquintRight: 0.18,
    eyeWideLeft: 0.05, eyeWideRight: 0.04,
    mouthPressLeft: 0.22, mouthPressRight: 0.2,
    browInnerUp: 0.05, mouthFrownLeft: 0.1, mouthFrownRight: 0.08,
    jawOpen: 0.04, mouthSmileLeft: 0, mouthSmileRight: 0,
    cheekSquintLeft: 0.05, cheekSquintRight: 0.05,
    browOuterUpLeft: 0, browOuterUpRight: 0,
    noseSneerLeft: 0, noseSneerRight: 0,
    mouthUpperUpLeft: 0, mouthUpperUpRight: 0,
    mouthLowerDownLeft: 0, mouthLowerDownRight: 0,
    mouthShrugUpper: 0.05, mouthShrugLower: 0.05,
    mouthStretchLeft: 0, mouthStretchRight: 0,
    mouthClose: 0.1, mouthDimpleLeft: 0, mouthDimpleRight: 0,
  };
  assert.ok(emotionScores(angry).angry >= 45, 'angry should dominate');
  const t = createReactionTrigger();
  assert.equal(holdUntil(t, angry, 0).activeEmotion, 'angry');
});

test('re-arm cooldown blocks immediate re-acquire after exit', () => {
  const t = createReactionTrigger(opts);
  holdUntil(t, S({ sad: 80 }), 0);
  assert.equal(t.feed({ bs: S({ sad: 10 }), t: 200 }).activeEmotion, null); // exit, endedAt=200
  // Holding again inside the 600ms re-arm window must not fire
  assert.equal(holdUntil(t, S({ sad: 80 }), 250).activeEmotion, null);
  // Drop, then after re-arm a fresh full hold can fire
  t.feed({ bs: S({ sad: 10 }), t: 1000 });
  assert.equal(holdUntil(t, S({ sad: 80 }), 1100).activeEmotion, 'sad');
});

// ── individual (per-hand) gesture onsets ──
test('single gesture fires once per-hand and respects cooldown', () => {
  const t = createReactionTrigger(opts);
  assert.deepEqual(t.feed({ gestures: ['Thumb_Up'], t: 0 }).gestureOnsets, [{ gesture: 'Thumb_Up', hand: 0 }]);
  assert.deepEqual(t.feed({ gestures: ['Thumb_Up'], t: 16 }).gestureOnsets, []);
  assert.deepEqual(t.feed({ gestures: [], t: 32 }).gestureOnsets, []);
  assert.deepEqual(t.feed({ gestures: ['Thumb_Up'], t: 1000 }).gestureOnsets, []);
  assert.deepEqual(t.feed({ gestures: ['Thumb_Up'], t: 1600 }).gestureOnsets, [{ gesture: 'Thumb_Up', hand: 0 }]);
});

test('two different gestures fire per-hand onsets with correct hand index', () => {
  const t = createReactionTrigger(opts);
  const r = t.feed({ gestures: ['Thumb_Up', 'Victory'], t: 0 });
  assert.deepEqual(r.gestureOnsets, [{ gesture: 'Thumb_Up', hand: 0 }, { gesture: 'Victory', hand: 1 }]);
  assert.deepEqual(r.comboOnsets, []);
});

test('a continuously held gesture never re-fires', () => {
  const t = createReactionTrigger(opts);
  assert.deepEqual(t.feed({ gestures: ['Open_Palm'], t: 0 }).gestureOnsets, [{ gesture: 'Open_Palm', hand: 0 }]);
  assert.deepEqual(t.feed({ gestures: ['Open_Palm'], t: 800 }).gestureOnsets, []);
  assert.deepEqual(t.feed({ gestures: ['Open_Palm'], t: 1600 }).gestureOnsets, []);
});

test('undefined gestures does not reset the active set', () => {
  const t = createReactionTrigger(opts);
  assert.deepEqual(t.feed({ gestures: ['Open_Palm'], t: 0 }).gestureOnsets, [{ gesture: 'Open_Palm', hand: 0 }]);
  assert.deepEqual(t.feed({ t: 10 }).gestureOnsets, []);
  assert.deepEqual(t.feed({ gestures: ['Open_Palm'], t: 20 }).gestureOnsets, []);
});

test('None is ignored', () => {
  const t = createReactionTrigger(opts);
  const r = t.feed({ gestures: ['None'], t: 0 });
  assert.deepEqual(r.gestureOnsets, []);
  assert.deepEqual(r.comboOnsets, []);
});

// ── two-hand combos ──
test('both thumbs up fires the awesome combo and suppresses individuals', () => {
  const t = createReactionTrigger(opts);
  const r = t.feed({ gestures: ['Thumb_Up', 'Thumb_Up'], t: 0 });
  assert.deepEqual(r.comboOnsets, ['awesome']);
  assert.deepEqual(r.gestureOnsets, []);
});

test('a combo fires once while held and re-arms after cooldown', () => {
  const t = createReactionTrigger(opts);
  assert.deepEqual(t.feed({ gestures: ['Thumb_Up', 'Thumb_Up'], t: 0 }).comboOnsets, ['awesome']);
  assert.deepEqual(t.feed({ gestures: ['Thumb_Up', 'Thumb_Up'], t: 100 }).comboOnsets, []);
  t.feed({ gestures: [], t: 200 });
  assert.deepEqual(t.feed({ gestures: ['Thumb_Up', 'Thumb_Up'], t: 300 }).comboOnsets, []);
  t.feed({ gestures: [], t: 400 });
  assert.deepEqual(t.feed({ gestures: ['Thumb_Up', 'Thumb_Up'], t: 1600 }).comboOnsets, ['awesome']);
});

test('the mixed combo (up + down) suppresses individuals', () => {
  const t = createReactionTrigger(opts);
  const r = t.feed({ gestures: ['Thumb_Up', 'Thumb_Down'], t: 0 });
  assert.deepEqual(r.comboOnsets, ['mixed']);
  assert.deepEqual(r.gestureOnsets, []);
});

test('emotion and gesture fire together', () => {
  const t = createReactionTrigger(opts);
  holdUntil(t, S({ sad: 80 }), 0);
  const r = t.feed({ bs: S({ sad: 80 }), gestures: ['Thumb_Up'], t: 200 });
  assert.equal(r.activeEmotion, 'sad');
  assert.deepEqual(r.gestureOnsets, [{ gesture: 'Thumb_Up', hand: 0 }]);
});

test('switches to a stronger different emotion after HOLD_MS', () => {
  const t = createReactionTrigger(opts);
  holdUntil(t, S({ sad: 80 }), 0);
  assert.equal(t.feed({ bs: S({ sad: 40, angry: 80 }), t: 200 }).activeEmotion, 'sad');
  assert.equal(t.feed({ bs: S({ sad: 40, angry: 80 }), t: 280 }).activeEmotion, 'sad');
  assert.equal(t.feed({ bs: S({ sad: 40, angry: 80 }), t: 320 }).activeEmotion, 'angry');
});

test('below-enter never activates even if held', () => {
  const t = createReactionTrigger(opts);
  assert.equal(holdUntil(t, S({ happy: 30 })).activeEmotion, null);
});

// ── real blendshapes ──
test('brief clear smile under HOLD_MS does not fire', () => {
  const smile = {
    mouthSmileLeft: 0.72, mouthSmileRight: 0.72,
    cheekSquintLeft: 0.55, cheekSquintRight: 0.55,
  };
  const t = createReactionTrigger();
  assert.equal(t.feed({ bs: smile, t: 0 }).activeEmotion, null);
  assert.equal(t.feed({ bs: smile, t: 80 }).activeEmotion, null);
});

test('clear smile held for HOLD_MS activates happy', () => {
  const smile = {
    mouthSmileLeft: 0.72, mouthSmileRight: 0.72,
    cheekSquintLeft: 0.55, cheekSquintRight: 0.55,
    browDownLeft: 0, browDownRight: 0, mouthFrownLeft: 0, mouthFrownRight: 0,
    jawOpen: 0.05, browInnerUp: 0, eyeWideLeft: 0, eyeWideRight: 0,
    browOuterUpLeft: 0, browOuterUpRight: 0, eyeSquintLeft: 0.15, eyeSquintRight: 0.15,
    mouthPressLeft: 0, mouthPressRight: 0, noseSneerLeft: 0, noseSneerRight: 0,
    mouthUpperUpLeft: 0, mouthUpperUpRight: 0, mouthLowerDownLeft: 0, mouthLowerDownRight: 0,
    mouthShrugUpper: 0, mouthShrugLower: 0, mouthStretchLeft: 0, mouthStretchRight: 0,
    mouthClose: 0, mouthDimpleLeft: 0, mouthDimpleRight: 0,
  };
  assert.ok(emotionScores(smile).happy >= 45);
  assert.ok(emotionRawMax(smile) >= 0.18);
  const t = createReactionTrigger();
  assert.equal(holdUntil(t, smile, 0).activeEmotion, 'happy');
});
