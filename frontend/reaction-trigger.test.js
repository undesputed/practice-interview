import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReactionTrigger, confusedScore } from './reaction-trigger.js';
import { emotionScores, emotionRawMax } from './emotion.js';

// Inject scores directly: the sample's bs IS the score object; confused comes from bs.confused.
// Bypass raw-strength with a high default so state-machine tests stay score-driven.
const opts = {
  scores: (bs) => bs,
  confusedScore: (bs) => bs.confused || 0,
  rawStrength: (bs) => (bs._raw == null ? 1 : bs._raw),
};
const S = (o) => ({ happy: 0, sad: 0, surprise: 0, angry: 0, disgust: 0, fear: 0, confused: 0, ...o });
const SUSTAIN = 9;

function feedSustain(t, bs, t0 = 0) {
  let r;
  for (let i = 0; i < SUSTAIN; i++) r = t.feed({ bs, t: t0 + i * 10 });
  return r;
}

// ── emotion state machine ──
test('emotion activates only after SUSTAIN_FRAMES >= enter', () => {
  const t = createReactionTrigger(opts);
  for (let i = 0; i < SUSTAIN - 1; i++)
    assert.equal(t.feed({ bs: S({ sad: 80 }), t: i * 10 }).activeEmotion, null);
  assert.equal(t.feed({ bs: S({ sad: 80 }), t: (SUSTAIN - 1) * 10 }).activeEmotion, 'sad');
});

test('emotion holds through hysteresis, exits below exit', () => {
  const t = createReactionTrigger(opts);
  feedSustain(t, S({ sad: 80 }));
  assert.equal(t.feed({ bs: S({ sad: 40 }), t: 200 }).activeEmotion, 'sad');
  assert.equal(t.feed({ bs: S({ sad: 30 }), t: 210 }).activeEmotion, null);
});

test('confused is selected when strongest and no rival classifier', () => {
  const t = createReactionTrigger(opts);
  assert.equal(feedSustain(t, S({ confused: 70 })).activeEmotion, 'confused');
});

test('confused is suppressed when angry is clearly present', () => {
  const t = createReactionTrigger(opts);
  assert.equal(feedSustain(t, S({ angry: 74, confused: 99 })).activeEmotion, 'angry');
});

test('confusedScore ignores brow-only anger-like faces', () => {
  // High brow + press + eye squint → looks like anger, not confused.
  assert.equal(confusedScore({
    browDownLeft: 0.7, browDownRight: 0.7,
    mouthPressLeft: 0.5, mouthPressRight: 0.5,
    eyeSquintLeft: 0.5, eyeSquintRight: 0.5,
  }), 0);
  // Mild furrow + press, calm eyes → confused.
  assert.ok(confusedScore({
    browDownLeft: 0.55, browDownRight: 0.5,
    mouthPressLeft: 0.25, mouthPressRight: 0.2,
    eyeSquintLeft: 0.05, eyeSquintRight: 0.05,
  }) >= 35);
});

test('low raw strength blocks activation even with high normalized score', () => {
  const t = createReactionTrigger(opts);
  assert.equal(feedSustain(t, S({ happy: 95, _raw: 0.12 })).activeEmotion, null);
});

test('small lead over runner-up blocks activation', () => {
  const t = createReactionTrigger(opts);
  // happy 60 vs sad 55 — lead only 5 < LEAD_MARGIN 12
  assert.equal(feedSustain(t, S({ happy: 60, sad: 55 })).activeEmotion, null);
});

test('re-arm cooldown blocks immediate re-acquire after exit', () => {
  const t = createReactionTrigger(opts);
  feedSustain(t, S({ sad: 80 }), 0);
  assert.equal(t.feed({ bs: S({ sad: 20 }), t: 200 }).activeEmotion, null); // exit
  // Strong again immediately — still within re-arm window
  assert.equal(feedSustain(t, S({ sad: 80 }), 210).activeEmotion, null);
  // After re-arm cooldown (900ms)
  assert.equal(feedSustain(t, S({ sad: 80 }), 1200).activeEmotion, 'sad');
});

// ── individual (per-hand) gesture onsets ──
test('single gesture fires once per-hand and respects cooldown', () => {
  const t = createReactionTrigger(opts);
  assert.deepEqual(t.feed({ gestures: ['Thumb_Up'], t: 0 }).gestureOnsets, [{ gesture: 'Thumb_Up', hand: 0 }]);
  assert.deepEqual(t.feed({ gestures: ['Thumb_Up'], t: 16 }).gestureOnsets, []);
  assert.deepEqual(t.feed({ gestures: [], t: 32 }).gestureOnsets, []);
  assert.deepEqual(t.feed({ gestures: ['Thumb_Up'], t: 1000 }).gestureOnsets, []); // within cooldown
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
  assert.deepEqual(t.feed({ gestures: ['Open_Palm'], t: 1600 }).gestureOnsets, []); // held
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
  assert.deepEqual(t.feed({ gestures: ['Thumb_Up', 'Thumb_Up'], t: 100 }).comboOnsets, []); // held
  t.feed({ gestures: [], t: 200 });
  assert.deepEqual(t.feed({ gestures: ['Thumb_Up', 'Thumb_Up'], t: 300 }).comboOnsets, []); // within cooldown
  t.feed({ gestures: [], t: 400 });
  assert.deepEqual(t.feed({ gestures: ['Thumb_Up', 'Thumb_Up'], t: 1600 }).comboOnsets, ['awesome']); // after
});

test('the mixed combo (up + down) suppresses individuals', () => {
  const t = createReactionTrigger(opts);
  const r = t.feed({ gestures: ['Thumb_Up', 'Thumb_Down'], t: 0 });
  assert.deepEqual(r.comboOnsets, ['mixed']);
  assert.deepEqual(r.gestureOnsets, []);
});

test('emotion and gesture fire together', () => {
  const t = createReactionTrigger(opts);
  feedSustain(t, S({ sad: 80 }), 0);
  const r = t.feed({ bs: S({ sad: 80 }), gestures: ['Thumb_Up'], t: 200 });
  assert.equal(r.activeEmotion, 'sad');
  assert.deepEqual(r.gestureOnsets, [{ gesture: 'Thumb_Up', hand: 0 }]);
});

test('switches to a stronger different emotion after SUSTAIN_FRAMES', () => {
  const t = createReactionTrigger(opts);
  feedSustain(t, S({ sad: 80 }), 0); // active = sad
  // sad still above exit (35); angry clearly leads
  for (let i = 0; i < SUSTAIN - 1; i++)
    assert.equal(t.feed({ bs: S({ sad: 40, angry: 80 }), t: 200 + i * 10 }).activeEmotion, 'sad');
  assert.equal(t.feed({ bs: S({ sad: 40, angry: 80 }), t: 200 + (SUSTAIN - 1) * 10 }).activeEmotion, 'angry');
});

test('neutral / below-enter never activates', () => {
  const t = createReactionTrigger(opts);
  for (let i = 0; i < SUSTAIN + 2; i++)
    assert.equal(t.feed({ bs: S({ happy: 40 }), t: i * 10 }).activeEmotion, null);
});

// ── real blendshapes: mild vs clear expressions ──
test('mild smile does not fire effects despite high normalized happy %', () => {
  const mild = {
    mouthSmileLeft: 0.28, mouthSmileRight: 0.28,
    cheekSquintLeft: 0.12, cheekSquintRight: 0.12,
  };
  assert.ok(emotionScores(mild).happy >= 58, 'normalized happy is high');
  assert.ok(emotionRawMax(mild) < 0.30, 'raw strength stays low');
  const t = createReactionTrigger(); // real scorer + raw gate
  for (let i = 0; i < SUSTAIN + 2; i++)
    assert.equal(t.feed({ bs: mild, t: i * 16 }).activeEmotion, null);
});

test('clear smile can activate happy after sustain', () => {
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
  assert.ok(emotionRawMax(smile) >= 0.30);
  const t = createReactionTrigger();
  assert.equal(feedSustain(t, smile, 0).activeEmotion, 'happy');
});
