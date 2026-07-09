// frontend/reaction-trigger.js
// Pure decision core for the Face Analysis reaction effects. Tracks the single
// active emotion with enter/exit hysteresis (so effects don't flicker) and reports
// gesture onsets (debounced by a cooldown). No DOM — unit-tested.
import { emotionScores } from './emotion.js';
import { detectCombo } from './fx/combos.js';

const EMOTION_ENTER_SCORE = 45;
const EMOTION_EXIT_SCORE = 25;
const SUSTAIN_FRAMES = 3;
const GESTURE_COOLDOWN_MS = 1500;
const GESTURE_COMBO_COOLDOWN_MS = 1500;
const CONFUSED_BROW_MIN = 0.35;
const CONFUSED_SCORE_SCALE = 130;

// The seven emotions that have effects (order = priority for ties). 'confused' is
// synthetic; 'contempt'/'neutral' from the classifier are intentionally excluded.
const EFFECT_EMOTIONS = ['angry', 'disgust', 'fear', 'happy', 'sad', 'surprise', 'confused'];

// Best-effort 'confused' from blendshapes: a furrowed brow (with a little mouth press).
// Not a real classifier class — approximate and tunable.
export function confusedScore(bs) {
  bs = bs || {};
  const brow = Math.max(bs.browDownLeft || 0, bs.browDownRight || 0);
  if (brow < CONFUSED_BROW_MIN) return 0;
  const press = Math.max(bs.mouthPressLeft || 0, bs.mouthPressRight || 0);
  return Math.min(100, (brow * 0.8 + press * 0.4) * CONFUSED_SCORE_SCALE);
}

export function createReactionTrigger(opts = {}) {
  const scoresFn = opts.scores || emotionScores;
  const confusedFn = opts.confusedScore || confusedScore;
  const enter = opts.enterScore ?? EMOTION_ENTER_SCORE;
  const exit = opts.exitScore ?? EMOTION_EXIT_SCORE;
  const sustain = opts.sustainFrames ?? SUSTAIN_FRAMES;
  const gestCooldown = opts.gestureCooldownMs ?? GESTURE_COOLDOWN_MS;
  const comboCooldown = opts.comboCooldownMs ?? GESTURE_COMBO_COOLDOWN_MS;

  let active = null;            // currently-active emotion, or null
  let candidate = null, streak = 0;   // building toward acquire/switch
  let activeGestures = new Set();
  const lastGestureAt = {};
  let activeCombo = null;
  const lastComboAt = {};

  // Combined 0-100 scores across the seven effect emotions.
  function combined(bs) {
    const s = scoresFn(bs) || {};
    return {
      happy: s.happy || 0, sad: s.sad || 0, surprise: s.surprise || 0,
      angry: s.angry || 0, disgust: s.disgust || 0, fear: s.fear || 0,
      confused: confusedFn(bs),
    };
  }
  function top(scores) {
    let best = null, val = -1;
    for (const e of EFFECT_EMOTIONS) { if (scores[e] > val) { val = scores[e]; best = e; } }
    return { emotion: best, value: val };
  }

  return {
    feed({ bs, gestures, t } = {}) {
      if (bs) {
        const scores = combined(bs);
        // Phase A: fade the active emotion out first (hysteresis: exit < enter).
        if (active && scores[active] < exit) { active = null; candidate = null; streak = 0; }
        // Phase B: acquire (from null) or switch (to a clearly stronger different emotion).
        const tp = top(scores);
        const strong = tp.value >= enter;
        if (active) {
          if (strong && tp.emotion !== active) {
            if (candidate === tp.emotion) streak++; else { candidate = tp.emotion; streak = 1; }
            if (streak >= sustain) { active = tp.emotion; candidate = null; streak = 0; }
          } else { candidate = null; streak = 0; }
        } else {
          if (strong) {
            if (candidate === tp.emotion) streak++; else { candidate = tp.emotion; streak = 1; }
            if (streak >= sustain) { active = tp.emotion; candidate = null; streak = 0; }
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
