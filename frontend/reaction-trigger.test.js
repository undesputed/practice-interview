import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReactionTrigger } from './reaction-trigger.js';

// Inject scores directly: the sample's bs IS the score object; confused comes from bs.confused.
const opts = { scores: (bs) => bs, confusedScore: (bs) => bs.confused || 0 };
const S = (o) => ({ happy: 0, sad: 0, surprise: 0, angry: 0, disgust: 0, fear: 0, confused: 0, ...o });

test('no emotion until a score sustains >= enter for SUSTAIN_FRAMES', () => {
  const t = createReactionTrigger(opts);
  assert.equal(t.feed({ bs: S({ sad: 80 }), t: 0 }).activeEmotion, null);
  assert.equal(t.feed({ bs: S({ sad: 80 }), t: 10 }).activeEmotion, null);
  assert.equal(t.feed({ bs: S({ sad: 80 }), t: 20 }).activeEmotion, 'sad'); // 3rd frame
});

test('stays active through the hysteresis band, exits below exit score', () => {
  const t = createReactionTrigger(opts);
  for (const ts of [0, 10, 20]) t.feed({ bs: S({ sad: 80 }), t: ts }); // active = sad
  assert.equal(t.feed({ bs: S({ sad: 30 }), t: 30 }).activeEmotion, 'sad'); // 30 in [25,45) -> hold
  assert.equal(t.feed({ bs: S({ sad: 20 }), t: 40 }).activeEmotion, null);  // < 25 -> exit
});

test('switches to a stronger different emotion after SUSTAIN_FRAMES', () => {
  const t = createReactionTrigger(opts);
  for (const ts of [0, 10, 20]) t.feed({ bs: S({ sad: 80 }), t: ts }); // active = sad
  // angry now dominant & >= enter; sad still above exit so it holds until the switch commits
  assert.equal(t.feed({ bs: S({ sad: 30, angry: 80 }), t: 30 }).activeEmotion, 'sad');
  assert.equal(t.feed({ bs: S({ sad: 30, angry: 80 }), t: 40 }).activeEmotion, 'sad');
  assert.equal(t.feed({ bs: S({ sad: 30, angry: 80 }), t: 50 }).activeEmotion, 'angry');
});

test('neutral / below-enter never activates', () => {
  const t = createReactionTrigger(opts);
  for (let i = 0; i < 5; i++)
    assert.equal(t.feed({ bs: S({ happy: 30 }), t: i * 10 }).activeEmotion, null); // 30 < 45
});

test('confused is selected when it is the strongest score', () => {
  const t = createReactionTrigger(opts);
  for (const ts of [0, 10, 20])
    assert.equal(t.feed({ bs: S({ confused: 70, angry: 20 }), t: ts }).activeEmotion, ts === 20 ? 'confused' : null);
});

test('gesture fires once on onset and respects cooldown', () => {
  const t = createReactionTrigger(opts);
  assert.deepEqual(t.feed({ gestures: ['Thumb_Up'], t: 0 }).gestureOnsets, ['Thumb_Up']);
  assert.deepEqual(t.feed({ gestures: ['Thumb_Up'], t: 16 }).gestureOnsets, []); // held
  assert.deepEqual(t.feed({ gestures: [], t: 32 }).gestureOnsets, []);
  assert.deepEqual(t.feed({ gestures: ['Thumb_Up'], t: 1000 }).gestureOnsets, []); // within cooldown
  assert.deepEqual(t.feed({ gestures: ['Thumb_Up'], t: 1600 }).gestureOnsets, ['Thumb_Up']); // after
});

test('undefined gestures does not reset the active set', () => {
  const t = createReactionTrigger(opts);
  assert.deepEqual(t.feed({ gestures: ['Open_Palm'], t: 0 }).gestureOnsets, ['Open_Palm']);
  assert.deepEqual(t.feed({ t: 10 }).gestureOnsets, []);                       // throttled frame
  assert.deepEqual(t.feed({ gestures: ['Open_Palm'], t: 20 }).gestureOnsets, []); // still held -> no refire
});

test('None gesture is ignored', () => {
  const t = createReactionTrigger(opts);
  assert.deepEqual(t.feed({ gestures: ['None'], t: 0 }).gestureOnsets, []);
});
