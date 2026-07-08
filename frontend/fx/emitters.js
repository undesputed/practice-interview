// frontend/fx/emitters.js
// One emitter per emotion (custom Canvas-2D art) + the gesture callout layer.
// Each emitter: { update(anchors, dt), draw(ctx), clear(), count() }.
// Visual constants are tuned for clear, bold effects over the live video.
import { createParticle, stepParticle, lifeProgress } from './particles.js';

const REDUCED = typeof matchMedia === 'function'
  && matchMedia('(prefers-reduced-motion: reduce)').matches;
const MAX_PER_EMITTER = 280;
// Effects intensify the longer an expression is held: the per-emitter spawn rate ramps from
// 1x up to RAMP_MAX over RAMP_MS, then plateaus — so icons keep multiplying while you hold the
// expression. Resets to 1x when the expression ends so the next one starts fresh.
const RAMP_MAX = 3.5;
const RAMP_MS = 2500;

// Global size dial. The canvas backing store is DPR-scaled, so raw pixel sizes render at
// ~half-size on retina and read as faint specks — S scales every effect up so it stands
// out over the camera image. Turn this one number up/down for overall bigness.
const S = 6;

// A dark outline + soft shadow makes bright shapes and text pop against a busy video frame.
function glow(ctx, blur) { ctx.shadowColor = 'rgba(0,0,0,0.6)'; ctx.shadowBlur = blur; }
function clearGlow(ctx) { ctx.shadowBlur = 0; ctx.shadowColor = 'transparent'; }

// Draw text with a dark outline so it stays legible over any background.
function outlinedText(ctx, text, x, y, px, fill) {
  ctx.font = `bold ${Math.round(px)}px sans-serif`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.lineJoin = 'round';
  ctx.lineWidth = Math.max(2, px * 0.16); ctx.strokeStyle = 'rgba(15,14,12,0.9)';
  ctx.strokeText(text, x, y);
  ctx.fillStyle = fill; ctx.fillText(text, x, y);
}

// Spawn/step/cull helper shared by particle emitters.
function baseEmitter(spawn, render) {
  const parts = [];
  let acc = 0;    // fractional spawn accumulator
  let holdMs = 0; // how long the expression has been continuously held (drives the ramp)
  return {
    update(anchors, dt) {
      if (anchors) {
        holdMs += dt;
        const ramp = 1 + Math.min(1, holdMs / RAMP_MS) * (RAMP_MAX - 1); // 1x -> RAMP_MAX over RAMP_MS
        acc = spawn(parts, anchors, dt, acc, ramp);
      } else {
        holdMs = 0; // expression ended — the next hold ramps from the start
      }
      for (let i = parts.length - 1; i >= 0; i--) if (!stepParticle(parts[i], dt)) parts.splice(i, 1);
      if (parts.length > MAX_PER_EMITTER) parts.splice(0, parts.length - MAX_PER_EMITTER);
    },
    draw(ctx) { render(ctx, parts); },
    clear() { parts.length = 0; acc = 0; holdMs = 0; },
    count() { return parts.length; },
  };
}
function rate(dt, perSec, acc) { return acc + (dt / 1000) * (REDUCED ? perSec * 0.4 : perSec); }

// ── Sad: fat blue teardrops welling under the eyes and falling ──
export function createTearsEmitter() {
  return baseEmitter(
    (parts, a, dt, acc, ramp) => {
      acc = rate(dt, 9 * ramp, acc);
      while (acc >= 1) {
        acc -= 1;
        const eye = Math.random() < 0.5 ? a.leftEye : a.rightEye;
        parts.push(createParticle({
          x: eye.x + (Math.random() * 10 - 5) * a.scale, y: eye.y + 8 * a.scale,
          vy: 24 * a.scale, ay: 160 * a.scale, life: 1300, size: 5.5 * S * a.scale, color: '#6bb8ff',
        }));
      }
      return acc;
    },
    (ctx, parts) => {
      for (const p of parts) {
        const k = lifeProgress(p);
        ctx.globalAlpha = (1 - k) * 0.95;
        ctx.fillStyle = p.color;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2); ctx.fill();
        ctx.lineWidth = Math.max(1.5, p.size * 0.16); ctx.strokeStyle = 'rgba(12,40,80,0.65)'; ctx.stroke();
        // bright highlight for a wet look
        ctx.globalAlpha = (1 - k) * 0.9; ctx.fillStyle = '#eaf6ff';
        ctx.beginPath(); ctx.arc(p.x - p.size * 0.3, p.y - p.size * 0.3, p.size * 0.32, 0, Math.PI * 2); ctx.fill();
      }
      ctx.globalAlpha = 1;
    });
}

// ── Angry: big flames rising above the forehead (color by life), additive ──
export function createFireEmitter() {
  return baseEmitter(
    (parts, a, dt, acc, ramp) => {
      acc = rate(dt, 34 * ramp, acc);
      while (acc >= 1) {
        acc -= 1;
        parts.push(createParticle({
          x: a.foreheadTop.x + (Math.random() * 60 - 30) * a.scale,
          y: a.foreheadTop.y - 8 * a.scale,
          vx: (Math.random() * 30 - 15) * a.scale, vy: -(90 + Math.random() * 60) * a.scale,
          ay: -30 * a.scale, life: 640 + Math.random() * 280, size: (10 + Math.random() * 8) * S * a.scale,
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
        ctx.globalAlpha = (1 - k) * 0.72;
        ctx.fillStyle = `rgb(${r},${g},${b})`;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.size * (1 - k * 0.5), 0, Math.PI * 2); ctx.fill();
      }
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    });
}

// ── Confused: "?" glyphs above the head that keep piling up the longer you stay confused ──
const CONFUSED_MAX = 9;
const CONFUSED_SPAWN_MS = 340; // add one more "?" this often while confusion is held
export function createConfusedEmitter() {
  const glyphs = [];
  let phase = 0, holdMs = 0;
  return {
    update(anchors, dt) {
      if (!anchors) { glyphs.length = 0; holdMs = 0; return; } // drop when the face is gone
      holdMs += dt;
      phase += (REDUCED ? 0 : dt / 1000);
      // Accumulate more "?" the longer confusion is held (1 -> CONFUSED_MAX).
      const target = Math.min(CONFUSED_MAX, 1 + Math.floor(holdMs / CONFUSED_SPAWN_MS));
      while (glyphs.length < target) glyphs.push({ off: Math.random() * 6, spin: 1 + Math.random() });
      const gs = 26 * S * anchors.scale;
      const n = glyphs.length;
      glyphs.forEach((g, i) => {
        const spread = n > 1 ? (i / (n - 1) - 0.5) : 0; // fan out across an arc as more appear
        g.x = anchors.foreheadTop.x + spread * gs * Math.min(n, 8) * 0.55 + Math.sin(phase * g.spin + g.off) * gs * 0.12;
        g.y = anchors.foreheadTop.y - gs * (0.95 + (i % 2) * 0.5) + Math.cos(phase * g.spin + g.off) * gs * 0.12;
        g.size = gs;
      });
    },
    draw(ctx) {
      glow(ctx, 8);
      for (const g of glyphs) outlinedText(ctx, '?', g.x, g.y, g.size, '#ffd54a');
      clearGlow(ctx);
    },
    clear() { glyphs.length = 0; phase = 0; holdMs = 0; },
    count() { return glyphs.length; },
  };
}

// ── Happy: big twinkling sparkles scattered around the face box ──
export function createSparkleEmitter() {
  return baseEmitter(
    (parts, a, dt, acc, ramp) => {
      acc = rate(dt, 16 * ramp, acc);
      while (acc >= 1) {
        acc -= 1;
        const b = a.faceBox;
        parts.push(createParticle({
          x: b.x + Math.random() * b.w, y: b.y + Math.random() * b.h,
          life: 700 + Math.random() * 400, size: (6 + Math.random() * 5) * S * a.scale,
          color: '#fff3b0', vr: Math.random() * 4 - 2, rot: Math.random() * Math.PI,
        }));
      }
      return acc;
    },
    (ctx, parts) => {
      glow(ctx, 10);
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
      ctx.globalAlpha = 1; clearGlow(ctx);
    });
}

// ── Surprise: a big bobbing "!" plus expanding rings above the head ──
export function createSurpriseEmitter() {
  return baseEmitter(
    (parts, a, dt, acc, ramp) => {
      acc = rate(dt, 4 * ramp, acc); // slow ring cadence
      while (acc >= 1) {
        acc -= 1;
        parts.push(createParticle({ x: a.foreheadTop.x, y: a.foreheadTop.y - 13 * S * a.scale,
          life: 720, size: 8 * S * a.scale, color: '#ffd54a', data: 'ring' }));
      }
      return acc;
    },
    (ctx, parts) => {
      for (const p of parts) {
        const k = lifeProgress(p);
        ctx.globalAlpha = (1 - k) * 0.85; ctx.strokeStyle = p.color; ctx.lineWidth = 7;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.size + k * 90, 0, Math.PI * 2); ctx.stroke();
      }
      ctx.globalAlpha = 1;
      // The "!" itself: anchored, drawn once (rings imply anchors are present).
      if (parts.length) {
        const p = parts[parts.length - 1];
        glow(ctx, 8);
        outlinedText(ctx, '!', p.x, p.y, p.size * 2.8, '#ffd54a');
        clearGlow(ctx);
      }
    });
}

// ── Disgust: greenish wavy blobs drifting sideways near the mouth ──
export function createDisgustEmitter() {
  return baseEmitter(
    (parts, a, dt, acc, ramp) => {
      acc = rate(dt, 12 * ramp, acc);
      while (acc >= 1) {
        acc -= 1;
        const dir = Math.random() < 0.5 ? -1 : 1;
        parts.push(createParticle({ x: a.mouth.x, y: a.mouth.y + 8 * a.scale,
          vx: dir * 30 * a.scale, vy: -8 * a.scale, life: 950, size: (6 + Math.random() * 5) * S * a.scale,
          color: '#8bd44f', rot: Math.random() * Math.PI }));
      }
      return acc;
    },
    (ctx, parts) => {
      for (const p of parts) {
        const k = lifeProgress(p);
        ctx.globalAlpha = (1 - k) * 0.85; ctx.fillStyle = p.color;
        ctx.beginPath(); ctx.ellipse(p.x, p.y, p.size, p.size * 0.6, p.rot, 0, Math.PI * 2); ctx.fill();
        ctx.lineWidth = Math.max(1.5, p.size * 0.14); ctx.strokeStyle = 'rgba(20,60,15,0.6)'; ctx.stroke();
      }
      ctx.globalAlpha = 1;
    });
}

// ── Fear: cold-sweat droplets sliding down from the temples ──
export function createFearEmitter() {
  return baseEmitter(
    (parts, a, dt, acc, ramp) => {
      acc = rate(dt, 6 * ramp, acc);
      while (acc >= 1) {
        acc -= 1;
        const t = Math.random() < 0.5 ? a.leftTemple : a.rightTemple;
        parts.push(createParticle({ x: t.x, y: t.y, vy: 34 * a.scale, ay: 90 * a.scale,
          vx: (Math.random() * 6 - 3) * a.scale, life: 1150, size: 5 * S * a.scale, color: '#bfe6ff' }));
      }
      return acc;
    },
    (ctx, parts) => {
      for (const p of parts) {
        const k = lifeProgress(p);
        ctx.globalAlpha = (1 - k) * 0.95; ctx.fillStyle = p.color;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2); ctx.fill();
        ctx.lineWidth = Math.max(1.5, p.size * 0.16); ctx.strokeStyle = 'rgba(12,40,80,0.6)'; ctx.stroke();
      }
      ctx.globalAlpha = 1;
    });
}

// ── Gesture callouts: transient labeled badges (scale-in -> hold -> fade) ──
const CALLOUT_LIFE = 1100;
export function createCalloutLayer() {
  const items = [];
  return {
    spawn(text, color, anchor, w, h, sizeMul = 1) {
      const x = anchor ? anchor.x : w / 2;
      const y = anchor ? anchor.y - 70 : h * 0.14;
      items.push({ text, color, x, y, age: 0, sizeMul });
    },
    update(dt) {
      for (let i = items.length - 1; i >= 0; i--) { items[i].age += dt; if (items[i].age >= CALLOUT_LIFE) items.splice(i, 1); }
    },
    draw(ctx) {
      for (const it of items) {
        const k = it.age / CALLOUT_LIFE;
        const scale = (k < 0.18 ? k / 0.18 : 1) * (it.sizeMul || 1); // scale-in, then combo size boost
        const alpha = k > 0.7 ? (1 - k) / 0.3 : 1;    // fade-out over last 30%
        ctx.save(); ctx.translate(it.x, it.y); ctx.scale(scale, scale); ctx.globalAlpha = alpha;
        ctx.font = 'bold 64px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        const wpx = ctx.measureText(it.text).width + 60;
        ctx.fillStyle = 'rgba(18,16,14,0.82)';
        ctx.beginPath(); ctx.roundRect(-wpx / 2, -48, wpx, 96, 26); ctx.fill();
        ctx.lineWidth = 4; ctx.strokeStyle = it.color; ctx.stroke();
        ctx.lineJoin = 'round'; ctx.lineWidth = 8; ctx.strokeStyle = 'rgba(15,14,12,0.9)';
        ctx.strokeText(it.text, 0, 3);
        ctx.fillStyle = it.color; ctx.fillText(it.text, 0, 3);
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
