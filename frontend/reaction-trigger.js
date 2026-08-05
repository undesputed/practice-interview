// frontend/reaction-trigger.js
// Pure decision core for the Face Analysis reaction effects. Tracks the single
// active emotion with enter/exit hysteresis (so effects don't flicker) and reports
// gesture onsets (debounced by a cooldown). No DOM — unit-tested.
import { emotionScores, emotionRawMax } from './emotion.js';
import { detectCombo } from './fx/combos.js';

// Tuned deliberately insensitive: normalized emotion % alone is not enough (a mild
// smile can still score happy≈100). Effects also need raw AU strength, a lead over
// the runner-up, sustained frames, and a short re-arm pause after an effect ends.
const EMOTION_ENTER_SCORE = 58;
const EMOTION_EXIT_SCORE = 35;
const SUSTAIN_FRAMES = 9;
const MIN_RAW_STRENGTH = 0.30;
const LEAD_MARGIN = 12;
const REARM_COOLDOWN_MS = 900;
const GESTURE_COOLDOWN_MS = 1500;
const GESTURE_COMBO_COOLDOWN_MS = 1500;
const CONFUSED_BROW_MIN = 0.4;
const CONFUSED_PRESS_MIN = 0.15;
const CONFUSED_SCORE_SCALE = 110;
// Classifier emotions that share brow-down / mouth-press with "confused". When any of
// these is already clear, suppress the synthetic confused score so anger/sad/fear win.
const CONFUSED_RIVALS = ['angry', 'sad', 'fear', 'disgust'];

// The seven emotions that have effects (order = priority for ties). 'confused' is
// synthetic; 'contempt'/'neutral' from the classifier are intentionally excluded.
const EFFECT_EMOTIONS = ['angry', 'disgust', 'fear', 'happy', 'sad', 'surprise', 'confused'];

// Best-effort 'confused' from blendshapes: furrowed brow + some mouth press, without
// a wide/squinted eye pattern that usually means anger or fear.
// Not a real classifier class — approximate and tunable.
export function confusedScore(bs) {
  bs = bs || {};
  const brow = Math.max(bs.browDownLeft || 0, bs.browDownRight || 0);
  if (brow < CONFUSED_BROW_MIN) return 0;
  const press = Math.max(bs.mouthPressLeft || 0, bs.mouthPressRight || 0);
  if (press < CONFUSED_PRESS_MIN) return 0;
  // Anger/fear often raise eye wide or squint; keep confused for the milder furrow.
  const eye = Math.max(
    bs.eyeWideLeft || 0, bs.eyeWideRight || 0,
    bs.eyeSquintLeft || 0, bs.eyeSquintRight || 0,
  );
  if (eye > 0.35) return 0;
  return Math.min(100, (brow * 0.75 + press * 0.35) * CONFUSED_SCORE_SCALE);
}

export function createReactionTrigger(opts = {}) {
  const scoresFn = opts.scores || emotionScores;
  const confusedFn = opts.confusedScore || confusedScore;
  const rawFn = opts.rawStrength || emotionRawMax;
  const enter = opts.enterScore ?? EMOTION_ENTER_SCORE;
  const exit = opts.exitScore ?? EMOTION_EXIT_SCORE;
  const sustain = opts.sustainFrames ?? SUSTAIN_FRAMES;
  const minRaw = opts.minRawStrength ?? MIN_RAW_STRENGTH;
  const leadMargin = opts.leadMargin ?? LEAD_MARGIN;
  const rearmMs = opts.rearmCooldownMs ?? REARM_COOLDOWN_MS;
  const gestCooldown = opts.gestureCooldownMs ?? GESTURE_COOLDOWN_MS;
  const comboCooldown = opts.comboCooldownMs ?? GESTURE_COMBO_COOLDOWN_MS;

  let active = null;            // currently-active emotion, or null
  let candidate = null, streak = 0;   // building toward acquire/switch
  let endedAt = null;           // timestamp when the last emotion effect cleared
  let activeGestures = new Set();
  const lastGestureAt = {};
  let activeCombo = null;
  const lastComboAt = {};

  // Combined 0-100 scores across the seven effect emotions.
  function combined(bs) {
    const s = scoresFn(bs) || {};
    const out = {
      happy: s.happy || 0, sad: s.sad || 0, surprise: s.surprise || 0,
      angry: s.angry || 0, disgust: s.disgust || 0, fear: s.fear || 0,
      confused: confusedFn(bs),
    };
    // Never let synthetic confused outrank a clear FACS emotion (esp. angry, which
    // shares brow-down + mouth-press and previously stole the fire effect).
    let rivalMax = 0;
    for (const e of CONFUSED_RIVALS) if (out[e] > rivalMax) rivalMax = out[e];
    if (rivalMax >= enter) out.confused = 0;
    else if (rivalMax > 0) out.confused = Math.min(out.confused, Math.max(0, rivalMax - 8));
    return out;
  }
  function top(scores) {
    let best = null, val = -1;
    for (const e of EFFECT_EMOTIONS) { if (scores[e] > val) { val = scores[e]; best = e; } }
    return { emotion: best, value: val };
  }
  function runnerUp(scores, winner) {
    let val = 0;
    for (const e of EFFECT_EMOTIONS) {
      if (e === winner) continue;
      if (scores[e] > val) val = scores[e];
    }
    return val;
  }
  // Raw AU strength (0..1). Confused is synthetic — treat its 0..100 score as strength.
  function strengthOk(bs, scores, emotion) {
    if (emotion === 'confused') return (scores.confused || 0) / 100 >= minRaw;
    return rawFn(bs) >= minRaw;
  }
  function clearActive(t) {
    active = null;
    candidate = null;
    streak = 0;
    endedAt = t;
  }

  return {
    feed({ bs, gestures, t } = {}) {
      if (bs) {
        const scores = combined(bs);
        // Phase A: fade the active emotion out first (hysteresis: exit < enter).
        if (active && scores[active] < exit) clearActive(t);
        // Phase B: acquire (from null) or switch (to a clearly stronger different emotion).
        const tp = top(scores);
        const lead = tp.value - runnerUp(scores, tp.emotion);
        const rearmed = endedAt == null || t == null || (t - endedAt) >= rearmMs;
        const strong = tp.value >= enter
          && lead >= leadMargin
          && strengthOk(bs, scores, tp.emotion)
          && (active || rearmed);
        if (active) {
          if (strong && tp.emotion !== active) {
            if (candidate === tp.emotion) streak++; else { candidate = tp.emotion; streak = 1; }
            if (streak >= sustain) { active = tp.emotion; candidate = null; streak = 0; }
          } else { candidate = null; streak = 0; }
        } else {
          if (strong) {
            if (candidate === tp.emotion) streak++; else { candidate = tp.emotion; streak = 1; }
            if (streak >= sustain) { active = tp.emotion; candidate = null; streak = 0; endedAt = null; }
          } else { candidate = null; streak = 0; }
        }
      }

      const gestureOnsets = []; // [{ gesture, hand }]
      const comboOnsets = [];   // [comboId]
      if (gestures !== undefined) {
        const comboId = detectCombo(gestures);
        const current = new Set((gestures || []).filter((g) => g && g !== 'None'));
        if (comboId) {
          // Fire once per formation (subject to cooldown); suppress individual onsets.
          if (comboId !== activeCombo && (lastComboAt[comboId] == null || t - lastComboAt[comboId] >= comboCooldown)) {
            lastComboAt[comboId] = t; comboOnsets.push(comboId);
          }
          activeCombo = comboId;
          // Mark current gestures as seen so breaking the combo (hands still up) doesn't
          // spuriously fire individuals next frame.
          activeGestures = current;
        } else {
          activeCombo = null;
          for (const g of current) {
            if (!activeGestures.has(g)) {
              const last = lastGestureAt[g];
              if (last == null || t - last >= gestCooldown) {
                lastGestureAt[g] = t;
                gestureOnsets.push({ gesture: g, hand: gestures.indexOf(g) });
                activeGestures.add(g);
              }
            }
          }
          for (const g of activeGestures) { if (!current.has(g)) activeGestures.delete(g); }
        }
      }

      return { activeEmotion: active, gestureOnsets, comboOnsets };
    },
  };
}
