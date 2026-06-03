// frontend/landmarks.js
// Extract the small set of pose/hand keypoints we send to the backend (normalized image coords).
const POSE_IDX = { nose: 0, leftEar: 7, rightEar: 8, leftShoulder: 11, rightShoulder: 12,
                   leftHip: 23, rightHip: 24 };
const HAND_IDX = { wrist: 0, indexTip: 8, middleTip: 12 };

export function pickPose(result) {
  const lm = result && result.landmarks && result.landmarks[0];
  if (!lm) return null;
  const pt = (i) => ({ x: lm[i].x, y: lm[i].y, visibility: lm[i].visibility ?? 0 });
  const out = {};
  for (const [name, i] of Object.entries(POSE_IDX)) out[name] = pt(i);
  return out;
}

export function pickHands(result) {
  const hands = (result && result.landmarks) || [];
  const labels = (result && result.handednesses) || [];
  return hands.map((lm, h) => {
    const pt = (i) => ({ x: lm[i].x, y: lm[i].y });
    return {
      handedness: (labels[h] && labels[h][0] && labels[h][0].categoryName) || "",
      wrist: pt(HAND_IDX.wrist), indexTip: pt(HAND_IDX.indexTip), middleTip: pt(HAND_IDX.middleTip),
    };
  });
}
