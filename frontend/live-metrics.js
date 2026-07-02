// frontend/live-metrics.js
// JS port of backend/analysis.py metric computation for the live panel.
// ALL formulas below MUST stay in sync with backend/analysis.py — the live panel
// reads from these, the final report reads from Python on the same frame data.

const GAZE_MAX = 0.5;
const BLINK_THRESHOLD = 0.5;
const STEADINESS_K = 4.0;
const FRAME_ASPECT = 16.0 / 9.0;
const UPRIGHT_RATIO = 0.35;
const BODY_FIDGET_SCALE = 2000;
const FACE_TOUCH_RADIUS = 0.6;

function clamp(x){ return Math.max(0, Math.min(100, x)); }

function matrixToEuler(m){
  // row-major 4x4: element at row i, col j is m[i*4+j]  (mirrors matrix_to_euler in analysis.py)
  const R = (i, j) => m[i * 4 + j];
  return [
    Math.atan2(R(2, 1), R(2, 2)) * 180 / Math.PI,
    Math.atan2(-R(2, 0), Math.sqrt(R(2, 1) ** 2 + R(2, 2) ** 2)) * 180 / Math.PI,
    Math.atan2(R(1, 0), R(0, 0)) * 180 / Math.PI,
  ];
}

// Compute live presence + voice metrics from all frames collected so far.
// Returns null if there are too few frames. Uses the entire session buffer so the
// numbers converge toward the post-session report values as the interview goes on.
export function computeLiveMetrics(frames, segments){
  const total = frames.length;
  if (total < 5) return null;

  // ── gaze_eye_contact_pct ──────────────────────────────────────────────────
  let gazeOn = 0;
  for (const f of frames){
    if (!f.face) continue;
    const bs = f.bs || {};
    const horiz = Math.max(bs.eyeLookOutLeft || 0, bs.eyeLookOutRight || 0,
                           bs.eyeLookInLeft  || 0, bs.eyeLookInRight  || 0);
    const vert  = Math.max(bs.eyeLookUpLeft  || 0, bs.eyeLookUpRight  || 0,
                           bs.eyeLookDownLeft || 0, bs.eyeLookDownRight || 0);
    if (horiz < GAZE_MAX && vert < GAZE_MAX) gazeOn++;
  }
  const gaze = 100 * gazeOn / total;

  // ── steadiness_score (head) ───────────────────────────────────────────────
  const eulers = [];
  for (const f of frames){
    if (f.face && f.m) eulers.push(matrixToEuler(f.m));
  }
  let headMovement = 0;
  if (eulers.length >= 2){
    let d = 0;
    for (let i = 1; i < eulers.length; i++)
      d += Math.abs(eulers[i][0] - eulers[i-1][0])
         + Math.abs(eulers[i][1] - eulers[i-1][1])
         + Math.abs(eulers[i][2] - eulers[i-1][2]);
    headMovement = d / (eulers.length - 1);
  }
  const head = Math.max(0, Math.min(100, 100 - STEADINESS_K * headMovement));

  // ── face_presence_pct ─────────────────────────────────────────────────────
  const presence = 100 * frames.filter(f => f.face).length / total;

  // ── pose: upright_pct + body_steadiness ──────────────────────────────────
  const poseFrames = frames.filter(f => f.pose);
  let upright = 0, body = 0;
  if (poseFrames.length > 0){
    let uprightCount = 0;
    const centers = [];
    for (const f of poseFrames){
      const p = f.pose;
      const midY  = (p.leftShoulder.y + p.rightShoulder.y) / 2;
      const width = Math.abs(p.leftShoulder.x - p.rightShoulder.x) || 1e-6;
      if (((midY - p.nose.y) / FRAME_ASPECT) / width > UPRIGHT_RATIO) uprightCount++;
      centers.push([(p.leftShoulder.x + p.rightShoulder.x) / 2, midY, p.nose.x, p.nose.y]);
    }
    upright = 100 * uprightCount / poseFrames.length;
    let bodyMov = 0;
    if (centers.length >= 2){
      let d = 0;
      for (let i = 1; i < centers.length; i++)
        d += Math.abs(centers[i][0] - centers[i-1][0])
           + Math.abs(centers[i][1] - centers[i-1][1])
           + Math.abs(centers[i][2] - centers[i-1][2])
           + Math.abs(centers[i][3] - centers[i-1][3]);
      bodyMov = d / (centers.length - 1);
    }
    body = Math.max(0, Math.min(100, 100 - BODY_FIDGET_SCALE * bodyMov / 100));
  }

  // ── blink_count / blinks_per_min ─────────────────────────────────────────
  let blinkCount = 0, prevClosed = false;
  for (const f of frames){
    const bs  = f.bs || {};
    const val = Math.max(bs.eyeBlinkLeft || 0, bs.eyeBlinkRight || 0);
    const closed = val >= BLINK_THRESHOLD;
    if (closed && !prevClosed) blinkCount++;
    prevClosed = closed;
  }
  const durationMin = total >= 2 ? (frames[total - 1].t - frames[0].t) / 60000 : 0;
  const bpm = durationMin > 0 ? blinkCount / durationMin : 0;

  // ── hand_fidget + face_touch_count ────────────────────────────────────────
  const handFrames = frames.filter(f => f.hands != null);
  const wrists = handFrames.filter(f => f.hands.length > 0).map(f => f.hands[0].wrist);
  let fidget = 0;
  if (wrists.length >= 2){
    let d = 0;
    for (let i = 1; i < wrists.length; i++)
      d += Math.abs(wrists[i].x - wrists[i-1].x) + Math.abs(wrists[i].y - wrists[i-1].y);
    fidget = d / (wrists.length - 1);
  }
  let touches = 0, prevTouch = false;
  for (const f of handFrames){
    const hands = f.hands || [];
    let touching = false;
    if (hands.length > 0 && f.pose){
      const nose = f.pose.nose;
      const ls = f.pose.leftShoulder, rs = f.pose.rightShoulder;
      const radius = FACE_TOUCH_RADIUS * (Math.abs(ls.x - rs.x) || 1e-6);
      outer: for (const h of hands)
        for (const key of ['wrist', 'indexTip', 'middleTip']){
          const pt = h[key];
          if (pt && Math.hypot(pt.x - nose.x, pt.y - nose.y) <= radius){ touching = true; break outer; }
        }
    }
    if (touching && !prevTouch) touches++;
    prevTouch = touching;
  }

  // ── facial_tension (eye_squint + lip_press + brow_down) ──────────────────
  const faceFrames = frames.filter(f => f.face && f.bs);
  let eyeSquint = 0, lipPress = 0, browDown = 0;
  if (faceFrames.length > 0){
    for (const f of faceFrames){
      const bs = f.bs;
      eyeSquint += Math.max(bs.eyeSquintLeft || 0, bs.eyeSquintRight || 0);
      lipPress  += Math.max(bs.mouthPressLeft || 0, bs.mouthPressRight || 0);
      browDown  += Math.max(bs.browDownLeft || 0, bs.browDownRight || 0);
    }
    const n = faceFrames.length;
    eyeSquint /= n; lipPress /= n; browDown /= n;
  }
  const tension = 100 * (eyeSquint + lipPress + browDown) / 3;

  // ── composite_scores — mirrors backend/analysis.py exactly ───────────────
  const attention   = clamp(0.5 * gaze + 0.3 * head + 0.2 * presence);
  const confidence  = clamp(0.5 * upright + 0.5 * body);
  const nervousness = clamp(
    0.25 * Math.min(100, bpm * 5)
    + 0.25 * (100 - gaze)
    + 0.2  * Math.min(100, touches * 20)
    + 0.15 * Math.min(100, fidget * 2000)
    + 0.15 * tension
  );
  const composure = clamp((head + body) / 2);

  // ── WPM estimate from transcript ──────────────────────────────────────────
  // The final report uses Deepgram audio analysis for WPM; here we estimate from
  // the live transcript. Divided by total session time (not speaking time), so it
  // underestimates slightly when the interviewer talks — still real data.
  let wpm = null;
  if (segments && segments.length >= 2){
    const candSegs = segments.filter(s => s.speaker === 'candidate');
    if (candSegs.length > 0){
      const words = candSegs.reduce((n, s) => n + (s.text || '').trim().split(/\s+/).filter(Boolean).length, 0);
      const elapsedMin = (segments[segments.length - 1].t - segments[0].t) / 60000;
      if (elapsedMin > 0.1) wpm = Math.round(words / elapsedMin);
    }
  }

  return {
    attention:   Math.round(attention),
    confidence:  Math.round(confidence),
    nervousness: Math.round(nervousness),
    composure:   Math.round(composure),
    eyeContact:  Math.round(gaze),
    wpm,
  };
}
