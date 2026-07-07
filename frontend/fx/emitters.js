// frontend/fx/emitters.js
// One emitter per emotion (custom Canvas-2D art) + the gesture callout layer.
// Each emitter: { update(anchors, dt), draw(ctx), clear(), count() }.
// Visual constants are intentionally simple starting points — tune in-browser.
import { createParticle, stepParticle, lifeProgress } from './particles.js';

const REDUCED = typeof matchMedia === 'function'
  && matchMedia('(prefers-reduced-motion: reduce)').matches;
const MAX_PER_EMITTER = 120;

// Spawn/step/cull helper shared by particle emitters.
function baseEmitter(spawn, render) {
  const parts = [];
  let acc = 0; // fractional spawn accumulator
  return {
    _parts: parts,
    update(anchors, dt) {
      if (anchors) acc = spawn(parts, anchors, dt, acc);
      for (let i = parts.length - 1; i >= 0; i--) if (!stepParticle(parts[i], dt)) parts.splice(i, 1);
      if (parts.length > MAX_PER_EMITTER) parts.splice(0, parts.length - MAX_PER_EMITTER);
    },
    draw(ctx) { render(ctx, parts); },
    clear() { parts.length = 0; acc = 0; },
    count() { return parts.length; },
  };
}
function rate(dt, perSec, acc) { return acc + (dt / 1000) * (REDUCED ? perSec * 0.4 : perSec); }

// ── Sad: blue teardrops welling under the eyes and falling ──
export function createTearsEmitter() {
  return baseEmitter(
    (parts, a, dt, acc) => {
      acc = rate(dt, 8, acc);
      while (acc >= 1) {
        acc -= 1;
        const eye = Math.random() < 0.5 ? a.leftEye : a.rightEye;
        parts.push(createParticle({
          x: eye.x + (Math.random() * 6 - 3), y: eye.y + 6 * a.scale,
          vy: 18 * a.scale, ay: 130 * a.scale, life: 1300, size: 3.2 * a.scale, color: '#7fc7ff',
        }));
      }
      return acc;
    },
    (ctx, parts) => {
      for (const p of parts) {
        const k = lifeProgress(p);
        ctx.globalAlpha = (1 - k) * 0.85;
        ctx.fillStyle = p.color;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2); ctx.fill();
      }
      ctx.globalAlpha = 1;
    });
}

// ── Angry: flames rising above the forehead (color by life), additive ──
export function createFireEmitter() {
  return baseEmitter(
    (parts, a, dt, acc) => {
      acc = rate(dt, 26, acc);
      while (acc >= 1) {
        acc -= 1;
        parts.push(createParticle({
          x: a.foreheadTop.x + (Math.random() * 40 - 20) * a.scale,
          y: a.foreheadTop.y - 6 * a.scale,
          vx: (Math.random() * 24 - 12) * a.scale, vy: -(70 + Math.random() * 50) * a.scale,
          ay: -30 * a.scale, life: 620 + Math.random() * 260, size: (10 + Math.random() * 8) * a.scale,
        }));
      }
      return acc;
    },
    (ctx, parts) => {
      ctx.globalCompositeOperation = 'lighter';
      for (const p of parts) {
        const k = lifeProgress(p);
        // yellow -> orange -> red -> fade
        const r = 255, g = Math.round(200 * (1 - k)), b = Math.round(40 * (1 - k));
        ctx.globalAlpha = (1 - k) * 0.5;
        ctx.fillStyle = `rgb(${r},${g},${b})`;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.size * (1 - k * 0.5), 0, Math.PI * 2); ctx.fill();
      }
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    });
}

// ── Confused: three "?" glyphs bobbing/orbiting above the head ──
export function createConfusedEmitter() {
  const glyphs = []; // persistent while the face is present
  let phase = 0;
  return {
    update(anchors, dt) {
      if (!anchors) { glyphs.length = 0; return; } // drop when the face is gone
      if (glyphs.length === 0)
        for (let i = 0; i < 3; i++) glyphs.push({ base: (i - 1), size: 20 * anchors.scale });
      phase += (REDUCED ? 0 : dt / 1000);
      for (const g of glyphs) {
        g.x = anchors.foreheadTop.x + g.base * 28 * anchors.scale + Math.sin(phase * 2 + g.base) * 6;
        g.y = anchors.foreheadTop.y - 24 * anchors.scale + Math.cos(phase * 2 + g.base) * 6;
        g.size = 20 * anchors.scale;
      }
    },
    draw(ctx) {
      ctx.fillStyle = '#ffd54a';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      for (const g of glyphs) {
        ctx.font = `bold ${Math.round(g.size)}px sans-serif`;
        ctx.fillText('?', g.x, g.y);
      }
    },
    clear() { glyphs.length = 0; phase = 0; },
    count() { return glyphs.length; },
  };
}
