// frontend/actions.js
// Detects discrete interview "actions" (gestures, expressions, head nod/shake) from per-frame
// signals, debounced (fire once at onset). Holds detector state across frames.

const GESTURE_ICONS = {
  Thumb_Up: "👍", Victory: "✌️", Open_Palm: "✋", Closed_Fist: "✊",
  Pointing_Up: "☝️", Thumb_Down: "👎", ILoveYou: "🤟",
};
const SMILE_ON = 0.5, FROWN_ON = 0.4, BROW_ON = 0.5, SURPRISE_ON = 0.5, HYS = 0.15;
const NOD_AMP = 6, SHAKE_AMP = 6, HEAD_WINDOW_MS = 1000, HEAD_COOLDOWN_MS = 1500;

function euler(m) {
  const R = (i, j) => m[i * 4 + j];
  const pitch = (Math.atan2(R(2, 1), R(2, 2)) * 180) / Math.PI;
  const yaw = (Math.atan2(-R(2, 0), Math.hypot(R(2, 1), R(2, 2))) * 180) / Math.PI;
  return { pitch, yaw };
}

function reversals(values, amp) {
  let count = 0, dir = 0, last = values[0];
  for (let i = 1; i < values.length; i++) {
    const delta = values[i] - last;
    if (Math.abs(delta) < amp) continue;
    const d = delta > 0 ? 1 : -1;
    if (dir !== 0 && d !== dir) count++;
    dir = d; last = values[i];
  }
  return count;
}

export function createActionDetector() {
  let activeGestures = new Set();
  const expr = { smile: false, frown: false, brow: false, surprise: false };
  let headBuf = [];
  let nodCd = 0, shakeCd = 0;

  function exprEvent(out, t, turn, key, value, onThresh, icon, label) {
    if (!expr[key] && value > onThresh) {
      expr[key] = true;
      out.push({ t, turn, kind: "expression", label, icon });
    } else if (expr[key] && value < onThresh - HYS) {
      expr[key] = false;
    }
  }

  return {
    feed({ t, turn, bs, gestures, m, face }) {
      const out = [];
      const current = new Set((gestures || []).filter((g) => g && g !== "None"));
      for (const g of current) {
        if (!activeGestures.has(g)) {
          out.push({ t, turn, kind: "gesture", label: g.replace(/_/g, " "), icon: GESTURE_ICONS[g] || "🖐" });
        }
      }
      activeGestures = current;

      if (face && bs) {
        const smile = ((bs.mouthSmileLeft || 0) + (bs.mouthSmileRight || 0)) / 2;
        const frown = ((bs.mouthFrownLeft || 0) + (bs.mouthFrownRight || 0)) / 2;
        const brow = Math.max(bs.browInnerUp || 0, bs.browOuterUpLeft || 0, bs.browOuterUpRight || 0);
        const surprise = bs.jawOpen || 0;
        exprEvent(out, t, turn, "smile", smile, SMILE_ON, "🙂", "Smile");
        exprEvent(out, t, turn, "frown", frown, FROWN_ON, "☹️", "Frown");
        exprEvent(out, t, turn, "brow", brow, BROW_ON, "🤨", "Eyebrow raise");
        exprEvent(out, t, turn, "surprise", surprise, SURPRISE_ON, "😮", "Surprise");
      }

      if (face && m) {
        const { pitch, yaw } = euler(m);
        headBuf.push({ t, pitch, yaw });
        headBuf = headBuf.filter((p) => t - p.t <= HEAD_WINDOW_MS);
        if (headBuf.length >= 4) {
          if (t >= nodCd && reversals(headBuf.map((p) => p.pitch), NOD_AMP) >= 2) {
            out.push({ t, turn, kind: "head", label: "Nod", icon: "🙆" });
            nodCd = t + HEAD_COOLDOWN_MS;
          }
          if (t >= shakeCd && reversals(headBuf.map((p) => p.yaw), SHAKE_AMP) >= 2) {
            out.push({ t, turn, kind: "head", label: "Shake", icon: "🙅" });
            shakeCd = t + HEAD_COOLDOWN_MS;
          }
        }
      }
      return out;
    },
  };
}
