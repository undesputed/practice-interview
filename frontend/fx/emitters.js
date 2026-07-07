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

// ── Happy: twinkling sparkles scattered around the face box ──
export function createSparkleEmitter() {
  return baseEmitter(
    (parts, a, dt, acc) => {
      acc = rate(dt, 14, acc);
      while (acc >= 1) {
        acc -= 1;
        const b = a.faceBox;
        parts.push(createParticle({
          x: b.x + Math.random() * b.w, y: b.y + Math.random() * b.h,
          life: 700 + Math.random() * 400, size: (4 + Math.random() * 4) * a.scale,
          color: '#fff3b0', vr: Math.random() * 4 - 2, rot: Math.random() * Math.PI,
        }));
      }
      return acc;
    },
    (ctx, parts) => {
      for (const p of parts) {
        const k = lifeProgress(p);
        const s = p.size * Math.sin(k * Math.PI); // scale in then out (twinkle)
        ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot);
        ctx.globalAlpha = Math.sin(k * Math.PI); ctx.fillStyle = p.color;
        ctx.beginPath();
        for (let i = 0; i < 8; i++) { const r = i % 2 ? s * 0.4 : s; const ang = (i / 8) * Math.PI * 2;
          const fn = i ? 'lineTo' : 'moveTo'; ctx[fn](Math.cos(ang) * r, Math.sin(ang) * r); }
        ctx.closePath(); ctx.fill(); ctx.restore();
      }
      ctx.globalAlpha = 1;
    });
}

// ── Surprise: a bobbing "!" plus expanding rings above the head ──
export function createSurpriseEmitter() {
  return baseEmitter(
    (parts, a, dt, acc) => {
      acc = rate(dt, 3, acc); // slow ring cadence
      while (acc >= 1) {
        acc -= 1;
        parts.push(createParticle({ x: a.foreheadTop.x, y: a.foreheadTop.y - 26 * a.scale,
          life: 700, size: 6 * a.scale, color: '#ffd54a', data: 'ring' }));
      }
      return acc;
    },
    (ctx, parts) => {
      for (const p of parts) {
        const k = lifeProgress(p);
        ctx.globalAlpha = (1 - k) * 0.8; ctx.strokeStyle = p.color; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.size + k * 26, 0, Math.PI * 2); ctx.stroke();
      }
      ctx.globalAlpha = 1;
      // The "!" itself: anchored, drawn once, only when there are anchors (rings imply anchors).
      if (parts.length) {
        const p = parts[parts.length - 1];
        ctx.fillStyle = '#ffd54a'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.font = `bold ${Math.round(p.size * 4)}px sans-serif`; ctx.fillText('!', p.x, p.y);
      }
    });
}

// ── Disgust: greenish wavy particles drifting sideways near the mouth ──
export function createDisgustEmitter() {
  return baseEmitter(
    (parts, a, dt, acc) => {
      acc = rate(dt, 10, acc);
      while (acc >= 1) {
        acc -= 1;
        const dir = Math.random() < 0.5 ? -1 : 1;
        parts.push(createParticle({ x: a.mouth.x, y: a.mouth.y + 6 * a.scale,
          vx: dir * 26 * a.scale, vy: -6 * a.scale, life: 900, size: (5 + Math.random() * 4) * a.scale,
          color: '#8bd44f', rot: Math.random() * Math.PI }));
      }
      return acc;
    },
    (ctx, parts) => {
      for (const p of parts) {
        const k = lifeProgress(p);
        ctx.globalAlpha = (1 - k) * 0.6; ctx.fillStyle = p.color;
        ctx.beginPath(); ctx.ellipse(p.x, p.y, p.size, p.size * 0.6, p.rot, 0, Math.PI * 2); ctx.fill();
      }
      ctx.globalAlpha = 1;
    });
}

// ── Fear: cold-sweat droplets sliding down from the temples ──
export function createFearEmitter() {
  return baseEmitter(
    (parts, a, dt, acc) => {
      acc = rate(dt, 5, acc);
      while (acc >= 1) {
        acc -= 1;
        const t = Math.random() < 0.5 ? a.leftTemple : a.rightTemple;
        parts.push(createParticle({ x: t.x, y: t.y, vy: 30 * a.scale, ay: 90 * a.scale,
          vx: (Math.random() * 6 - 3), life: 1100, size: 3 * a.scale, color: '#bfe6ff' }));
      }
      return acc;
    },
    (ctx, parts) => {
      for (const p of parts) {
        const k = lifeProgress(p);
        ctx.globalAlpha = (1 - k) * 0.8; ctx.fillStyle = p.color;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2); ctx.fill();
      }
      ctx.globalAlpha = 1;
    });
}

// ── Gesture callouts: transient labeled badges (scale-in -> hold -> fade) ──
const CALLOUT_LIFE = 1000;
export function createCalloutLayer() {
  const items = [];
  return {
    spawn(text, color, anchor, w, h) {
      const x = anchor ? anchor.x : w / 2;
      const y = anchor ? anchor.y - 30 : h * 0.18;
      items.push({ text, color, x, y, age: 0 });
    },
    update(dt) {
      for (let i = items.length - 1; i >= 0; i--) { items[i].age += dt; if (items[i].age >= CALLOUT_LIFE) items.splice(i, 1); }
    },
    draw(ctx) {
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      for (const it of items) {
        const k = it.age / CALLOUT_LIFE;
        const scale = k < 0.2 ? k / 0.2 : 1;          // scale-in over first 20%
        const alpha = k > 0.7 ? (1 - k) / 0.3 : 1;    // fade-out over last 30%
        ctx.save(); ctx.translate(it.x, it.y); ctx.scale(scale, scale); ctx.globalAlpha = alpha;
        ctx.font = 'bold 26px sans-serif';
        const wpx = ctx.measureText(it.text).width + 24;
        ctx.fillStyle = 'rgba(20,18,16,0.72)';
        ctx.beginPath(); ctx.roundRect(-wpx / 2, -20, wpx, 40, 12); ctx.fill();
        ctx.fillStyle = it.color; ctx.fillText(it.text, 0, 1);
        ctx.restore();
      }
      ctx.globalAlpha = 1;
    },
    clear() { items.length = 0; },
    count() { return items.length; },
  };
}

export const EMOTION_EMITTERS = {
  happy: createSparkleEmitter, sad: createTearsEmitter, surprise: createSurpriseEmitter,
  angry: createFireEmitter, disgust: createDisgustEmitter, fear: createFearEmitter,
  confused: createConfusedEmitter,
};

export const GESTURE_CALLOUTS = {
  Thumb_Up: { text: 'OK!', color: '#3ddc84' },
  Thumb_Down: { text: 'Nope', color: '#ff5c5c' },
  Victory: { text: 'Nice!', color: '#ffd54a' },
  Open_Palm: { text: 'Hi!', color: '#7fc7ff' },
  Closed_Fist: { text: 'Strong!', color: '#ff9f43' },
  Pointing_Up: { text: 'Idea! 💡', color: '#ffe08a' },
  ILoveYou: { text: 'Love! 💜', color: '#c98bff' },
};
