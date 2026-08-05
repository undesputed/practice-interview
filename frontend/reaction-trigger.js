// frontend/reaction-trigger.js
// Pure decision core for the Face Analysis reaction effects. Tracks the single
// active emotion with enter/exit hysteresis (so effects don't flicker) and reports
// gesture onsets (debounced by a cooldown). No DOM — unit-tested.
import { emotionScores, emotionRawMax } from './emotion.js';
import { detectCombo } from './fx/combos.js';

// Hold-to-fire: the emotion must stay clearly present for HOLD_MS before effects
// start (and again to switch). Detection thresholds are moderate — duration is the
// main anti-flicker / anti-accidental control, not an ultra-high score bar.
const EMOTION_ENTER_SCORE = 45;
const EMOTION_EXIT_SCORE = 25;
const HOLD_MS = 1500;             // 1.5s in the 1–2s range
const HOLD_GRACE_MS = 280;        // brief score dips (angry↔sad) don't reset the hold
const MIN_RAW_STRENGTH = 0.18;    // ignore tiny AU noise; still allow deliberate holds
const LEAD_MARGIN = 6;
const REARM_COOLDOWN_MS = 600;
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

// Real angry faces rarely raise eyeWide (AU5 in the FACS prototype), so the shared
// rawMax often undershoots. Gate anger on brow + squint + press instead.
export function angryIntensity(bs) {
  bs = bs || {};
  const brow = Math.max(bs.browDownLeft || 0, bs.browDownRight || 0);
  const squint = Math.max(bs.eyeSquintLeft || 0, bs.eyeSquintRight || 0);
  const press = Math.max(bs.mouthPressLeft || 0, bs.mouthPressRight || 0);
  return brow * 0.5 + squint * 0.25 + press * 0.25;
}

export function createReactionTrigger(opts = {}) {
  const scoresFn = opts.scores || emotionScores;
  const confusedFn = opts.confusedScore || confusedScore;
  const rawFn = opts.rawStrength || emotionRawMax;
  const enter = opts.enterScore ?? EMOTION_ENTER_SCORE;
  const exit = opts.exitScore ?? EMOTION_EXIT_SCORE;
  const holdMs = opts.holdMs ?? HOLD_MS;
  const graceMs = opts.holdGraceMs ?? HOLD_GRACE_MS;
  const minRaw = opts.minRawStrength ?? MIN_RAW_STRENGTH;
  const leadMargin = opts.leadMargin ?? LEAD_MARGIN;
  const rearmMs = opts.rearmCooldownMs ?? REARM_COOLDOWN_MS;
  const gestCooldown = opts.gestureCooldownMs ?? GESTURE_COOLDOWN_MS;
  const comboCooldown = opts.comboCooldownMs ?? GESTURE_COMBO_COOLDOWN_MS;

  let active = null;                 // currently-active emotion, or null
  let candidate = null;              // emotion being held toward acquire/switch
  let candidateSince = null;         // timestamp when that hold started
  let lastStrongAt = null;           // last time the candidate was "strong"
  let endedAt = null;                // timestamp when the last emotion effect cleared
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
    // Suppress as soon as a rival is meaningfully present (not only above enter),
    // so mid-hold angry scores can't lose to confused on a soft frame.
    if (rivalMax >= exit) out.confused = 0;
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
  // Angry uses max(angryIntensity, rawMax): real faces often lack eyeWide so rawMax alone
  // undershoots; score-injection tests still pass via rawFn.
  function strengthOk(bs, scores, emotion) {
    if (emotion === 'confused') return (scores.confused || 0) / 100 >= minRaw;
    if (emotion === 'angry') return Math.max(angryIntensity(bs), rawFn(bs)) >= minRaw;
    return rawFn(bs) >= minRaw;
  }
  function resetCandidate() {
    candidate = null;
    candidateSince = null;
    lastStrongAt = null;
  }
  function clearActive(t) {
    active = null;
    resetCandidate();
    endedAt = t;
  }
  // Count continuous hold time for the current candidate emotion.
  function noteHold(emotion, t) {
    if (candidate === emotion && candidateSince != null) {
      lastStrongAt = t == null ? lastStrongAt : t;
      return;
    }
    candidate = emotion;
    candidateSince = t == null ? 0 : t;
    lastStrongAt = candidateSince;
  }
  function heldLongEnough(t) {
    if (candidateSince == null) return false;
    if (t == null) return false;
    return (t - candidateSince) >= holdMs;
  }
  function withinGrace(scores, t) {
    if (!candidate || candidateSince == null || lastStrongAt == null || t == null) return false;
    if ((t - lastStrongAt) > graceMs) return false;
    // Still some signal of the emotion we're holding — don't keep a dead hold alive.
    return (scores[candidate] || 0) >= exit;
  }

  return {
    feed({ bs, gestures, t } = {}) {
      if (bs) {
        const scores = combined(bs);
        // Phase A: fade the active emotion out first (hysteresis: exit < enter).
        if (active && scores[active] < exit) clearActive(t);
        // Phase B: acquire (from null) or switch after HOLD_MS of a different emotion.
        const tp = top(scores);
        const lead = tp.value - runnerUp(scores, tp.emotion);
        const rearmed = endedAt == null || t == null || (t - endedAt) >= rearmMs;
        const strong = tp.value >= enter
          && lead >= leadMargin
          && strengthOk(bs, scores, tp.emotion)
          && (active || rearmed);
        if (active) {
          if (strong && tp.emotion !== active) {
            noteHold(tp.emotion, t);
            if (heldLongEnough(t)) { active = tp.emotion; resetCandidate(); }
          } else if (strong && tp.emotion === active) {
            resetCandidate(); // settled back on active — drop switch attempt
          } else if (withinGrace(scores, t)) {
            // Brief dip while switching — keep the switch hold alive.
            if (heldLongEnough(t)) { active = candidate; resetCandidate(); }
          } else {
            resetCandidate();
          }
        } else if (strong) {
          noteHold(tp.emotion, t);
          if (heldLongEnough(t)) { active = tp.emotion; resetCandidate(); endedAt = null; }
        } else if (withinGrace(scores, t)) {
          // Brief dip during acquire — wall-clock hold continues.
          if (heldLongEnough(t)) { active = candidate; resetCandidate(); endedAt = null; }
        } else {
          resetCandidate();
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
