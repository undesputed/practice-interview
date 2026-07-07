import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapPoint, extractAnchors, FACE_IDX } from './anchors.js';

test('mapPoint scales and mirrors X', () => {
  assert.deepEqual(mapPoint({ x: 0.25, y: 0.5 }, 1000, 400), { x: 750, y: 200 }); // (1-0.25)*1000
  assert.deepEqual(mapPoint({ x: 0, y: 0 }, 1000, 400), { x: 1000, y: 0 });
});

test('extractAnchors returns null for too few landmarks', () => {
  assert.equal(extractAnchors(null, 100, 100), null);
  assert.equal(extractAnchors([{ x: 0.5, y: 0.5 }], 100, 100), null);
});

test('extractAnchors maps named indices and computes a positive scale', () => {
  // Build 468 landmarks all at center, then set a few named ones + spread for the box.
  const lm = Array.from({ length: 468 }, () => ({ x: 0.5, y: 0.5 }));
  lm[FACE_IDX.foreheadTop] = { x: 0.5, y: 0.2 };
  lm[0] = { x: 0.4, y: 0.3 };   // contributes to face box bounds
  lm[1] = { x: 0.6, y: 0.7 };
  const a = extractAnchors(lm, 1000, 400);
  assert.ok(a && a.foreheadTop);
  assert.equal(a.foreheadTop.y, 80);          // 0.2 * 400
  assert.equal(a.foreheadTop.x, 500);         // (1-0.5)*1000
  assert.ok(a.scale > 0 && a.scale <= 2.5);
  assert.ok(a.faceBox.w > 0 && a.faceBox.h > 0);
});
