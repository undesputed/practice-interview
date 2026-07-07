// frontend/face-effects.js
// Canvas overlay + render loop for the Face Analysis reaction effects. Composes the
// pure trigger (which emotion is active + gesture onsets) with per-effect emitters that
// draw custom art anchored to face/hand landmarks. No network, no scoring — cosmetic.
import { createReactionTrigger } from './reaction-trigger.js';
import { EMOTION_EMITTERS, GESTURE_CALLOUTS, createCalloutLayer } from './fx/emitters.js';
import { extractAnchors, mapPoint } from './fx/anchors.js';

export function createFaceEffects(canvas) {
  const ctx = canvas.getContext('2d');
  const trigger = createReactionTrigger();
  const emitters = {};
  for (const name in EMOTION_EMITTERS) emitters[name] = EMOTION_EMITTERS[name]();
  const callouts = createCalloutLayer();

  let enabled = false, rafId = 0, lastT = 0;
  let activeEmotion = null;
  let latest = null; // last fed { faceLandmarks, handLandmarks }

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(canvas.clientWidth * dpr));
    canvas.height = Math.max(1, Math.round(canvas.clientHeight * dpr));
  }

  function clearAll() {
    activeEmotion = null;
    for (const k in emitters) emitters[k].clear();
    callouts.clear();
    if (canvas.width && canvas.height) ctx.clearRect(0, 0, canvas.width, canvas.height);
  }

  function handAnchor(handLandmarks) {
    if (!handLandmarks || !handLandmarks.length || !handLandmarks[0].length) return null;
    return mapPoint(handLandmarks[0][0], canvas.width, canvas.height); // wrist (landmark 0), mirrored
  }

  function loop(now) {
    if (!enabled) return;
    const dt = lastT ? Math.min(50, now - lastT) : 16;
    lastT = now;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const anchors = latest && latest.faceLandmarks
      ? extractAnchors(latest.faceLandmarks, canvas.width, canvas.height) : null;
    // Update/draw every emitter, but only the ACTIVE one receives anchors (spawns). Inactive
    // emitters get null, so they stop spawning and their particles drain and fade out
    // naturally — a smooth exit/switch without an abrupt clear. Idle emitters hold 0 particles.
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
      enabled = !!on;
      if (enabled) { resize(); lastT = 0; rafId = requestAnimationFrame(loop); window.addEventListener('resize', resize); }
      else { cancelAnimationFrame(rafId); window.removeEventListener('resize', resize); clearAll(); }
    },
    feed(sample) {
      if (!enabled) return;
      latest = sample;
      const { activeEmotion: ae, gestureOnsets } = trigger.feed({
        bs: sample.bs, gestures: sample.gestures, t: sample.t,
      });
      activeEmotion = ae; // on change, the previously-active emitter drains itself in the loop
      for (const g of gestureOnsets) {
        const c = GESTURE_CALLOUTS[g];
        if (c) callouts.spawn(c.text, c.color, handAnchor(sample.handLandmarks), canvas.width, canvas.height);
      }
    },
    clear() { clearAll(); },
    destroy() { enabled = false; cancelAnimationFrame(rafId); window.removeEventListener('resize', resize); clearAll(); },
  };
}
