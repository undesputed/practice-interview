import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReactionTrigger, confusedScore } from './reaction-trigger.js';

// Inject scores directly: the sample's bs IS the score object; confused comes from bs.confused.
const opts = { scores: (bs) => bs, confusedScore: (bs) => bs.confused || 0 };
const S = (o) => ({ happy: 0, sad: 0, surprise: 0, angry: 0, disgust: 0, fear: 0, confused: 0, ...o });

// ── emotion state machine ──
test('emotion activates only after SUSTAIN_FRAMES >= enter', () => {
  const t = createReactionTrigger(opts);
  assert.equal(t.feed({ bs: S({ sad: 80 }), t: 0 }).activeEmotion, null);
  assert.equal(t.feed({ bs: S({ sad: 80 }), t: 10 }).activeEmotion, 'sad');
});

test('emotion holds through hysteresis, exits below exit', () => {
  const t = createReactionTrigger(opts);
  for (const ts of [0, 10]) t.feed({ bs: S({ sad: 80 }), t: ts });
  assert.equal(t.feed({ bs: S({ sad: 25 }), t: 20 }).activeEmotion, 'sad');
  assert.equal(t.feed({ bs: S({ sad: 15 }), t: 30 }).activeEmotion, null);
});

test('confused is selected when strongest and no rival classifier', () => {
  const t = createReactionTrigger(opts);
  assert.equal(t.feed({ bs: S({ confused: 70 }), t: 0 }).activeEmotion, null);
  assert.equal(t.feed({ bs: S({ confused: 70 }), t: 10 }).activeEmotion, 'confused');
});

test('confused is suppressed when angry is clearly present', () => {
  const t = createReactionTrigger(opts);
  for (const ts of [0, 10]) t.feed({ bs: S({ angry: 74, confused: 99 }), t: ts });
  assert.equal(t.feed({ bs: S({ angry: 74, confused: 99 }), t: 20 }).activeEmotion, 'angry');
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
  t.feed({ bs: S({ sad: 80 }), t: 0 });
  const r = t.feed({ bs: S({ sad: 80 }), gestures: ['Thumb_Up'], t: 10 });
  assert.equal(r.activeEmotion, 'sad');
  assert.deepEqual(r.gestureOnsets, [{ gesture: 'Thumb_Up', hand: 0 }]);
});

test('switches to a stronger different emotion after SUSTAIN_FRAMES', () => {
  const t = createReactionTrigger(opts);
  for (const ts of [0, 10]) t.feed({ bs: S({ sad: 80 }), t: ts }); // active = sad
  assert.equal(t.feed({ bs: S({ sad: 30, angry: 80 }), t: 20 }).activeEmotion, 'sad');
  assert.equal(t.feed({ bs: S({ sad: 30, angry: 80 }), t: 30 }).activeEmotion, 'angry');
});

test('neutral / below-enter never activates', () => {
  const t = createReactionTrigger(opts);
  for (let i = 0; i < 5; i++)
    assert.equal(t.feed({ bs: S({ happy: 25 }), t: i * 10 }).activeEmotion, null);
});
