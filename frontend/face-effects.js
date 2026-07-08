// frontend/face-effects.js
// Canvas overlay + render loop for the Face Analysis reaction effects. Composes the pure
// trigger (active emotion + per-hand gesture onsets + two-hand combos) with per-effect
// emitters, per-hand/combo callouts, and a full-frame emotion wash. No network, no scoring.
import { createReactionTrigger } from './reaction-trigger.js';
import { EMOTION_EMITTERS, GESTURE_CALLOUTS, createCalloutLayer } from './fx/emitters.js';
import { GESTURE_COMBOS } from './fx/combos.js';
import { createWash } from './fx/wash.js';
import { extractAnchors, mapPoint } from './fx/anchors.js';

export function createFaceEffects(canvas) {
  const ctx = canvas.getContext('2d');
  const trigger = createReactionTrigger();
  const emitters = {};
  for (const name in EMOTION_EMITTERS) emitters[name] = EMOTION_EMITTERS[name]();
  const callouts = createCalloutLayer();
  const wash = createWash();

  let enabled = false, rafId = 0, lastT = 0;
  let activeEmotion = null;
  let latest = null; // last fed sample

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(canvas.clientWidth * dpr));
    canvas.height = Math.max(1, Math.round(canvas.clientHeight * dpr));
  }

  function clearAll() {
    activeEmotion = null;
    for (const k in emitters) emitters[k].clear();
    callouts.clear();
    wash.clear();
    if (canvas.width && canvas.height) ctx.clearRect(0, 0, canvas.width, canvas.height);
  }

  // Wrist (landmark 0) of hand i, mapped + mirrored, or null.
  function handAnchor(handLandmarks, i) {
    if (!handLandmarks || !handLandmarks[i] || !handLandmarks[i].length) return null;
    return mapPoint(handLandmarks[i][0], canvas.width, canvas.height);
  }
  // Midpoint between the two hands' wrists (falls back to whichever hand is present, or null).
  function comboAnchor(handLandmarks) {
    const a = handAnchor(handLandmarks, 0), b = handAnchor(handLandmarks, 1);
    if (a && b) return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    return a || b || null;
  }

  function loop(now) {
    if (!enabled) return;
    const dt = lastT ? Math.min(50, now - lastT) : 16;
    lastT = now;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    // Background wash first (under the particles/callouts).
    wash.setEmotion(activeEmotion);
    wash.update(dt);
    wash.draw(ctx, canvas.width, canvas.height);
    const anchors = latest && latest.faceLandmarks
      ? extractAnchors(latest.faceLandmarks, canvas.width, canvas.height) : null;
    // Only the ACTIVE emitter receives anchors; inactive ones drain and fade.
    for (const name in emitters) {
      emitters[name].update(name === activeEmotion ? anchors : null, dt);
      emitters[name].draw(ctx);
    }
    callouts.update(dt);
    callouts.draw(ctx);
    rafId = requestAnimationFrame(loop);
  }

  return {
    setEnabled(on) {
      on = !!on;
      if (on === enabled) return; // idempotent: never stack a second rAF loop
      enabled = on;
      if (enabled) { resize(); lastT = 0; rafId = requestAnimationFrame(loop); window.addEventListener('resize', resize); }
      else { cancelAnimationFrame(rafId); window.removeEventListener('resize', resize); clearAll(); }
    },
    feed(sample) {
      if (!enabled) return;
      latest = sample;
      const { activeEmotion: ae, gestureOnsets, comboOnsets } = trigger.feed({
        bs: sample.bs, gestures: sample.gestures, t: sample.t,
      });
      activeEmotion = ae;
      // Individual callouts anchored to each hand; also flash the wash.
      for (const o of gestureOnsets) {
        const c = GESTURE_CALLOUTS[o.gesture];
        if (c) {
          callouts.spawn(c.text, c.color, handAnchor(sample.handLandmarks, o.hand), canvas.width, canvas.height);
          wash.pulse(c.color);
        }
      }
      // Combo callouts: bigger, centered between the hands.
      for (const id of comboOnsets) {
        const c = GESTURE_COMBOS[id];
        if (c) {
          callouts.spawn(c.text, c.color, comboAnchor(sample.handLandmarks), canvas.width, canvas.height, 1.6);
          wash.pulse(c.color);
        }
      }
    },
    clear() { clearAll(); },
    destroy() { enabled = false; cancelAnimationFrame(rafId); window.removeEventListener('resize', resize); clearAll(); },
  };
}
