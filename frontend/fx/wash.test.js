import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWash, EMOTION_WASH } from './wash.js';

test('EMOTION_WASH has the 7 emotions', () => {
  assert.deepEqual(Object.keys(EMOTION_WASH).sort(),
    ['angry', 'confused', 'disgust', 'fear', 'happy', 'sad', 'surprise']);
});

test('intensity rises toward base while an emotion is set', () => {
  const w = createWash();
  assert.equal(w.intensity(), 0);
  w.setEmotion('angry');
  for (let i = 0; i < 80; i++) w.update(16);
  assert.ok(w.intensity() > 0.3, `expected > 0.3, got ${w.intensity()}`);
});

test('intensity decays to ~0 after the emotion clears', () => {
  const w = createWash();
  w.setEmotion('angry');
  for (let i = 0; i < 80; i++) w.update(16);
  w.setEmotion(null);
  for (let i = 0; i < 120; i++) w.update(16);
  assert.ok(w.intensity() < 0.03, `expected < 0.03, got ${w.intensity()}`);
});

test('a pulse decays and is removed', () => {
  const w = createWash();
  w.pulse('#ff0000');
  assert.equal(w.pulseCount(), 1);
  for (let i = 0; i < 40; i++) w.update(16); // 640ms > 500ms life
  assert.equal(w.pulseCount(), 0);
});

test('an unknown emotion produces no wash', () => {
  const w = createWash();
  w.setEmotion('neutral');
  for (let i = 0; i < 80; i++) w.update(16);
  assert.equal(w.intensity(), 0);
});
