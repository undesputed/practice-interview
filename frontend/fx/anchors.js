// frontend/fx/anchors.js
// Map MediaPipe face landmarks (normalized [0,1]) into canvas pixel anchor points for
// the reaction effects. X is mirrored to match the selfie-mirrored video canvas
// (.fa-stage canvas { transform: scaleX(-1) }). Pure — unit-tested.
//
// Indices are MediaPipe Face Mesh (468/478). STARTING VALUES — verify/tune in-browser
// (see the plan's calibration step); they are exported so tuning is a one-line change.
export const FACE_IDX = {
  underEyeL: 145, underEyeR: 374, foreheadTop: 10,
  templeL: 234, templeR: 454, mouth: 13,
};

export function mapPoint(norm, w, h) {
  return { x: (1 - norm.x) * w, y: norm.y * h };
}

export function extractAnchors(landmarks, w, h) {
  if (!landmarks || landmarks.length < 468) return null;
  const P = (i) => mapPoint(landmarks[i], w, h);
  let minX = 1, minY = 1, maxX = 0, maxY = 0;
  for (const p of landmarks) {
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
  }
  const faceH = (maxY - minY) * h;
  return {
    leftEye: P(FACE_IDX.underEyeL), rightEye: P(FACE_IDX.underEyeR),
    foreheadTop: P(FACE_IDX.foreheadTop),
    leftTemple: P(FACE_IDX.templeL), rightTemple: P(FACE_IDX.templeR),
    mouth: P(FACE_IDX.mouth),
    // Mirror flips the X extents, so the display-left edge is (1-maxX).
    faceBox: { x: (1 - maxX) * w, y: minY * h, w: (maxX - minX) * w, h: faceH },
    scale: Math.max(0.4, Math.min(2.5, faceH / (h * 0.5))),
  };
}
