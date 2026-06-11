// Live blendshape -> emotion scorer. Mirrors backend/analysis.py (the FACS Action-Unit
// prototype model) so the live "dominant emotion" matches the report's MediaPipe track.
// KEEP IN SYNC with backend/analysis.py if the AU prototypes / gates / weights change.

export const EMOTION_CLASSES = ['angry', 'disgust', 'fear', 'happy', 'sad', 'surprise', 'neutral'];

// FACS Action Unit -> blendshape base name (Left/Right averaged by bsAvg).
const AU = {
  AU1: 'browInnerUp', AU2: 'browOuterUp', AU4: 'browDown', AU5: 'eyeWide',
  AU6: 'cheekSquint', AU7: 'eyeSquint', AU9: 'noseSneer', AU10: 'mouthUpperUp',
  AU12: 'mouthSmile', AU15: 'mouthFrown', AU20: 'mouthStretch', AU23: 'mouthPress', AU26: 'jawOpen',
};
// EMFACS emotion prototypes: match = MEAN activation of these AUs.
const PROTOTYPES = {
  happy:    ['AU6', 'AU12'],
  sad:      ['AU1', 'AU4', 'AU15'],
  surprise: ['AU1', 'AU2', 'AU5', 'AU26'],
  fear:     ['AU1', 'AU2', 'AU4', 'AU5', 'AU7', 'AU20', 'AU26'],
  angry:    ['AU4', 'AU5', 'AU7', 'AU23'],
  disgust:  ['AU9', 'AU10', 'AU15'],
};
// Distinguishing AU(s) each emotion REQUIRES (soft product-gate): fear needs brow-lower
// + lip-stretch (or surprise wins); disgust needs the nose-wrinkle (or anger wins).
const GATES = { fear: ['AU4', 'AU20'], disgust: ['AU9'] };
// AUs that CONTRADICT an emotion (subtracted, weighted).
const CONFLICTS = { surprise: ['AU4'], happy: ['AU4', 'AU15'] };
const GATE_T = 0.35, CONFLICT_W = 0.5, NEUTRAL_BASE = 0.12;

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

// 7-class 0-100 distribution for one frame's blendshapes, via FACS-AU prototypes.
export function emotionScores(bs){
  bs = bs || {};
  const au = {};
  for (const k in AU) au[k] = bsAvg(bs, AU[k]);
  const raw = {};
  let maxExpressive = 0;
  for (const emo in PROTOTYPES){
    const proto = PROTOTYPES[emo];
    let match = proto.reduce((s, a) => s + au[a], 0) / proto.length;          // mean prototype activation
    for (const a of (CONFLICTS[emo] || [])) match -= CONFLICT_W * au[a];       // subtract conflicting AUs
    for (const a of (GATES[emo] || [])) match *= Math.min(1, au[a] / GATE_T);  // require distinguishing AU(s)
    raw[emo] = Math.max(0, match);
    if (raw[emo] > maxExpressive) maxExpressive = raw[emo];
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
