// Live blendshape -> emotion scorer. Ported VERBATIM from backend/analysis.py
// (EMOTION_WEIGHTS / _bs_avg / NEUTRAL_BASE / _frame_emotion_scores) so this
// screen's live "dominant emotion" matches the report's MediaPipe track.
// KEEP IN SYNC with backend/analysis.py if the weights change.

export const EMOTION_CLASSES = ['angry', 'disgust', 'fear', 'happy', 'sad', 'surprise', 'neutral'];

const EMOTION_WEIGHTS = {
  happy:    { mouthSmile: 1.0, cheekSquint: 0.6 },
  sad:      { mouthFrown: 1.0, browInnerUp: 0.6, browDown: 0.3 },
  angry:    { browDown: 1.0, mouthPress: 0.6, eyeSquint: 0.5 },
  surprise: { browInnerUp: 0.7, browOuterUp: 0.7, eyeWide: 0.8, jawOpen: 0.6 },
  fear:     { browInnerUp: 0.6, browOuterUp: 0.6, browDown: 0.5,
              eyeWide: 0.7, mouthStretch: 0.7, jawOpen: 0.4 },
  disgust:  { noseSneer: 1.0, mouthUpperUp: 0.8 },
};
const NEUTRAL_BASE = 0.15;

// Average the Left/Right variants that are present; a one-sided value counts at
// full strength. Falls back to the bare key, then 0.
function bsAvg(bs, name){
  const sides = [];
  const l = bs[name + 'Left'], r = bs[name + 'Right'];
  if (l != null) sides.push(l);
  if (r != null) sides.push(r);
  if (sides.length) return sides.reduce((a, b) => a + b, 0) / sides.length;
  return bs[name] != null ? bs[name] : 0;
}

// 7-class 0-100 distribution for one frame's blendshapes.
export function emotionScores(bs){
  bs = bs || {};
  const raw = {};
  let maxExpressive = 0;
  for (const emo in EMOTION_WEIGHTS){
    let s = 0;
    const w = EMOTION_WEIGHTS[emo];
    for (const name in w) s += w[name] * bsAvg(bs, name);
    raw[emo] = s;
    if (s > maxExpressive) maxExpressive = s;
  }
  raw.neutral = Math.max(0, NEUTRAL_BASE - maxExpressive);
  const total = EMOTION_CLASSES.reduce((a, c) => a + (raw[c] || 0), 0);
  const out = {};
  if (total <= 0){
    for (const c of EMOTION_CLASSES) out[c] = c === 'neutral' ? 100 : 0;
    return out;
  }
  for (const c of EMOTION_CLASSES) out[c] = Math.round(1000 * (raw[c] || 0) / total) / 10;
  return out;
}

// { emotion, value, scores } for the highest-scoring class.
export function dominantEmotion(bs){
  const scores = emotionScores(bs);
  let best = 'neutral', val = -1;
  for (const c of EMOTION_CLASSES){ if (scores[c] > val){ val = scores[c]; best = c; } }
  return { emotion: best, value: val, scores };
}
