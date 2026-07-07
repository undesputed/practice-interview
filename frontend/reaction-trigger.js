// frontend/reaction-trigger.js
// Pure decision core for the Face Analysis reaction effects. Given per-frame
// { bs, gestures, t } samples, decides which emoji to burst. Emotions fire on
// sustained onset and may re-fire after their cooldown while still held; a held
// gesture fires once on its rising edge and not again while held. No DOM — unit-tested.
import { dominantEmotion } from './emotion.js';

export const EMOTION_EMOJI = {
  happy: '😄', sad: '😢', surprise: '😮', angry: '😠',
  disgust: '🤢', fear: '😨', contempt: '😒',
};
export const GESTURE_EMOJI = {
  Thumb_Up: '👍', Thumb_Down: '👎', Victory: '✌️', Open_Palm: '✋',
  Closed_Fist: '✊', Pointing_Up: '☝️', ILoveYou: '🤟',
};

const EMOTION_MIN_SCORE = 50;
const SUSTAIN_FRAMES = 3;
const EMOTION_COOLDOWN_MS = 2500;
const GESTURE_COOLDOWN_MS = 1500;

export function createReactionTrigger(opts = {}) {
  const classify = opts.classify || dominantEmotion;
  const minScore = opts.emotionMinScore ?? EMOTION_MIN_SCORE;
  const sustain = opts.sustainFrames ?? SUSTAIN_FRAMES;
  const emoCooldown = opts.emotionCooldownMs ?? EMOTION_COOLDOWN_MS;
  const gestCooldown = opts.gestureCooldownMs ?? GESTURE_COOLDOWN_MS;

  let candidate = null;   // emotion currently building a streak
  let streak = 0;
  const lastEmotionAt = {};
  let activeGestures = new Set();
  const lastGestureAt = {};

  return {
    feed({ bs, gestures, t } = {}) {
      const out = [];

      // ── emotion (sustain + cooldown) ──
      if (bs) {
        const dom = classify(bs);
        const emo = dom && dom.emotion;
        if (emo && emo !== 'neutral' && dom.value >= minScore) {
          if (candidate === emo) streak += 1;
          else { candidate = emo; streak = 1; }
          if (streak >= sustain) {
            const last = lastEmotionAt[emo];
            if (last == null || t - last >= emoCooldown) {
              lastEmotionAt[emo] = t;
              if (EMOTION_EMOJI[emo]) out.push(EMOTION_EMOJI[emo]);
            }
            candidate = null; streak = 0;   // must re-sustain before firing again
          }
        } else {
          candidate = null; streak = 0;
        }
      }

      // ── gestures (fire on onset + cooldown) ──
      // undefined = no info this frame (throttled) → leave the active set untouched.
      if (gestures !== undefined) {
        const current = new Set((gestures || []).filter((g) => g && g !== 'None'));
        for (const g of current) {
          if (!activeGestures.has(g)) {
            const last = lastGestureAt[g];
            if (last == null || t - last >= gestCooldown) {
              lastGestureAt[g] = t;
              if (GESTURE_EMOJI[g]) out.push(GESTURE_EMOJI[g]);
            }
          }
        }
        activeGestures = current;
      }

      return out;
    }
  };
}
