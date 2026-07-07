import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTearsEmitter, createFireEmitter, createConfusedEmitter,
         createSparkleEmitter, createSurpriseEmitter, createDisgustEmitter, createFearEmitter } from './emitters.js';

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
