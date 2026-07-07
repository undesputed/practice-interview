import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createParticle, stepParticle, lifeProgress } from './particles.js';

test('integrates position from velocity over dt', () => {
  const p = createParticle({ x: 0, y: 0, vx: 100, vy: 0, life: 1000 }); // 100 px/s
  stepParticle(p, 100); // 0.1s
  assert.ok(Math.abs(p.x - 10) < 1e-9);
});

test('gravity (ay) increases downward velocity', () => {
  const p = createParticle({ x: 0, y: 0, vy: 0, ay: 200, life: 1000 });
  stepParticle(p, 500); // 0.5s
  assert.ok(p.vy > 0 && Math.abs(p.vy - 100) < 1e-9);
});

test('expires at end of life', () => {
  const p = createParticle({ x: 0, y: 0, life: 100 });
  assert.equal(stepParticle(p, 50), true);
  assert.equal(stepParticle(p, 60), false); // age 110 >= 100
});

test('lifeProgress goes 0 -> 1 and clamps', () => {
  const p = createParticle({ x: 0, y: 0, life: 100 });
  assert.equal(lifeProgress(p), 0);
  stepParticle(p, 50);
  assert.ok(Math.abs(lifeProgress(p) - 0.5) < 1e-9);
  stepParticle(p, 999);
  assert.equal(lifeProgress(p), 1);
});
