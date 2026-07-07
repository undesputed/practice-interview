import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTearsEmitter, createFireEmitter, createConfusedEmitter,
         createSparkleEmitter, createSurpriseEmitter, createDisgustEmitter, createFearEmitter,
         createCalloutLayer, EMOTION_EMITTERS, GESTURE_CALLOUTS } from './emitters.js';

// Minimal Canvas-2D stand-in: records nothing, never throws.
function mockCtx() {
  const grad = { addColorStop() {} };
  return new Proxy({}, {
    get: (_t, k) => {
      if (k === 'createLinearGradient' || k === 'createRadialGradient') return () => grad;
      if (k === 'measureText') return () => ({ width: 10 }); // callout draw reads .width
      return () => {};
    },
    set: () => true,
  });
}
const anchors = {
  leftEye: { x: 100, y: 100 }, rightEye: { x: 200, y: 100 },
  foreheadTop: { x: 150, y: 40 }, leftTemple: { x: 80, y: 90 }, rightTemple: { x: 220, y: 90 },
  mouth: { x: 150, y: 160 }, faceBox: { x: 80, y: 40, w: 140, h: 160 }, scale: 1,
};

for (const [name, make] of [
  ['tears', createTearsEmitter], ['fire', createFireEmitter], ['confused', createConfusedEmitter],
  ['sparkle', createSparkleEmitter], ['surprise', createSurpriseEmitter],
  ['disgust', createDisgustEmitter], ['fear', createFearEmitter],
]) {
  test(`${name}: spawns with an anchor, draws without throwing, drains when anchor is gone`, () => {
    const e = make();
    for (let i = 0; i < 30; i++) e.update(anchors, 16);
    assert.ok(e.count() > 0, `${name} should have live particles`);
    e.draw(mockCtx()); // must not throw
    for (let i = 0; i < 400; i++) e.update(null, 16); // no anchor -> no new spawns, existing expire
    assert.equal(e.count(), 0, `${name} should drain to 0`);
  });
}

test('clear() empties an emitter', () => {
  const e = createFireEmitter();
  for (let i = 0; i < 20; i++) e.update(anchors, 16);
  e.clear();
  assert.equal(e.count(), 0);
});

test('EMOTION_EMITTERS covers all seven emotions with factories', () => {
  const keys = ['happy', 'sad', 'surprise', 'angry', 'disgust', 'fear', 'confused'];
  for (const k of keys) assert.equal(typeof EMOTION_EMITTERS[k], 'function');
  assert.equal(Object.keys(EMOTION_EMITTERS).length, keys.length);
});

test('GESTURE_CALLOUTS maps Thumb_Up to OK! green', () => {
  assert.deepEqual(GESTURE_CALLOUTS.Thumb_Up, { text: 'OK!', color: '#3ddc84' });
  assert.equal(Object.keys(GESTURE_CALLOUTS).length, 7);
});

test('callout spawns, draws, and expires', () => {
  const c = createCalloutLayer();
  c.spawn('OK!', '#3ddc84', { x: 50, y: 50 }, 200, 200);
  assert.equal(c.count(), 1);
  c.draw(mockCtx()); // must not throw
  for (let i = 0; i < 120; i++) c.update(16); // ~1.9s > 1s life
  assert.equal(c.count(), 0);
});

test('callout falls back to top-center when anchor is null', () => {
  const c = createCalloutLayer();
  c.spawn('Hi!', '#7fc7ff', null, 200, 400);
  c.draw(mockCtx()); // must not throw with a null anchor
  assert.equal(c.count(), 1);
});
