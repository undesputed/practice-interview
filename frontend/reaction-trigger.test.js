import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReactionTrigger } from './reaction-trigger.js';

// classify stub: the sample's bs already carries { emotion, value }.
const stub = { classify: (bs) => bs };
const happy = { emotion: 'happy', value: 80 };

test('emotion fires only after SUSTAIN_FRAMES above threshold', () => {
  const trig = createReactionTrigger(stub);
  assert.deepEqual(trig.feed({ bs: happy, t: 0 }), []);   // 1
  assert.deepEqual(trig.feed({ bs: happy, t: 10 }), []);  // 2
  assert.deepEqual(trig.feed({ bs: happy, t: 20 }), ['😄']); // 3 -> fire
});

test('neutral never fires', () => {
  const trig = createReactionTrigger(stub);
  const neutral = { emotion: 'neutral', value: 100 };
  for (let i = 0; i < 5; i++) assert.deepEqual(trig.feed({ bs: neutral, t: i * 10 }), []);
});

test('below-threshold emotion never fires', () => {
  const trig = createReactionTrigger(stub);
  const weak = { emotion: 'happy', value: 40 };
  for (let i = 0; i < 5; i++) assert.deepEqual(trig.feed({ bs: weak, t: i * 10 }), []);
});

test('emotion respects cooldown', () => {
  const trig = createReactionTrigger(stub);
  trig.feed({ bs: happy, t: 0 }); trig.feed({ bs: happy, t: 10 });
  assert.deepEqual(trig.feed({ bs: happy, t: 20 }), ['😄']);        // fires
  // must re-sustain AND clear cooldown; still within 2500ms -> no fire
  trig.feed({ bs: happy, t: 30 }); trig.feed({ bs: happy, t: 40 });
  assert.deepEqual(trig.feed({ bs: happy, t: 50 }), []);
  // after cooldown, a fresh sustained streak fires again
  trig.feed({ bs: happy, t: 2600 }); trig.feed({ bs: happy, t: 2610 });
  assert.deepEqual(trig.feed({ bs: happy, t: 2620 }), ['😄']);
});

test('gesture fires once on onset, not while held', () => {
  const trig = createReactionTrigger(stub);
  assert.deepEqual(trig.feed({ gestures: ['Thumb_Up'], t: 0 }), ['👍']);
  assert.deepEqual(trig.feed({ gestures: ['Thumb_Up'], t: 16 }), []);  // held
  assert.deepEqual(trig.feed({ gestures: [], t: 32 }), []);            // released
});

test('gesture re-onset blocked within cooldown, allowed after', () => {
  const trig = createReactionTrigger(stub);
  trig.feed({ gestures: ['Victory'], t: 0 });          // fires
  trig.feed({ gestures: [], t: 16 });                  // released
  assert.deepEqual(trig.feed({ gestures: ['Victory'], t: 500 }), []);    // within 1500ms
  trig.feed({ gestures: [], t: 516 });
  assert.deepEqual(trig.feed({ gestures: ['Victory'], t: 1600 }), ['✌️']); // after cooldown
});

test('undefined gestures does not reset the active set', () => {
  const trig = createReactionTrigger(stub);
  assert.deepEqual(trig.feed({ gestures: ['Open_Palm'], t: 0 }), ['✋']); // onset
  assert.deepEqual(trig.feed({ t: 10 }), []);                            // throttled frame, no gesture info
  assert.deepEqual(trig.feed({ gestures: ['Open_Palm'], t: 20 }), []);  // still held -> no re-fire
});

test('None gesture is ignored', () => {
  const trig = createReactionTrigger(stub);
  assert.deepEqual(trig.feed({ gestures: ['None'], t: 0 }), []);
});

test('a continuously held gesture never re-fires, even past its cooldown', () => {
  const trig = createReactionTrigger(stub);
  assert.deepEqual(trig.feed({ gestures: ['Thumb_Up'], t: 0 }), ['👍']); // onset fires
  assert.deepEqual(trig.feed({ gestures: ['Thumb_Up'], t: 800 }), []);
  assert.deepEqual(trig.feed({ gestures: ['Thumb_Up'], t: 1600 }), []); // past 1500ms cooldown, still held
  assert.deepEqual(trig.feed({ gestures: ['Thumb_Up'], t: 3000 }), []);
});

test('emotion and gesture can fire together', () => {
  const trig = createReactionTrigger(stub);
  trig.feed({ bs: happy, t: 0 }); trig.feed({ bs: happy, t: 10 });
  const out = trig.feed({ bs: happy, gestures: ['Thumb_Up'], t: 20 });
  assert.deepEqual(out.sort(), ['👍', '😄'].sort());
});
