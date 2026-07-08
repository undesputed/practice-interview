import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectCombo, GESTURE_COMBOS } from './combos.js';

test('both thumbs up matches awesome', () => {
  assert.equal(detectCombo(['Thumb_Up', 'Thumb_Up']), 'awesome');
});

test('mixed matches order-independently', () => {
  assert.equal(detectCombo(['Thumb_Up', 'Thumb_Down']), 'mixed');
  assert.equal(detectCombo(['Thumb_Down', 'Thumb_Up']), 'mixed');
});

test('a non-combo pair returns null', () => {
  assert.equal(detectCombo(['Thumb_Up', 'Victory']), null);
});

test('fewer than two real gestures returns null', () => {
  assert.equal(detectCombo(['Thumb_Up']), null);
  assert.equal(detectCombo([]), null);
  assert.equal(detectCombo(['Thumb_Up', 'None']), null); // None filtered -> only 1 real
});

test('GESTURE_COMBOS has the 7 ids with exact text/color', () => {
  assert.deepEqual(Object.keys(GESTURE_COMBOS).sort(),
    ['awesome', 'big_no', 'love', 'mixed', 'peace', 'pumped', 'woo']);
  assert.deepEqual(GESTURE_COMBOS.awesome, { gestures: ['Thumb_Up', 'Thumb_Up'], text: 'AWESOME!', color: '#3ddc84' });
  assert.deepEqual(GESTURE_COMBOS.mixed.gestures, ['Thumb_Up', 'Thumb_Down']);
});
