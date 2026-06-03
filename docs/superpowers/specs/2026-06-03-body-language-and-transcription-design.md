# Body-Language Signals + Transcription Quality — Design

**Date:** 2026-06-03
**Status:** Approved (pending spec review)
**Builds on:** the web AI voice-interview app (`2026-06-03-web-ai-voice-interview-mediapipe-design.md`)

## 1. Purpose

Extend the interview app with (Phase 0) better candidate speech-to-text and (Phase 1)
richer **body-language** signals from MediaPipe — posture, fidgeting, face-touching, and
gaze-based eye contact — surfaced as new per-question + overall report metrics. All new
MediaPipe models run client-side in the existing render loop (approach A); all new metrics
are computed server-side in `analysis.py` with unit tests, matching the current pattern.

## 2. Core decisions (from brainstorming)

| Decision | Choice |
|----------|--------|
| Transcription fix depth | Quick wins: sample-rate auto-match + nova-3 keyterms (no AudioWorklet) |
| New metrics | Posture & lean, fidget/steadiness, face-touching, gaze eye-contact |
| Model architecture | **A** — keep FaceLandmarker every frame; add Pose + Hand landmarkers |
| Performance | Throttle Pose + Hand to ~8/sec; Face every frame |
| Metrics location | Server-side (`analysis.py`), unit-tested (raw landmarks sent from browser) |
| Eye contact | **Gaze** (from `eyeLook*` blendshapes) becomes the primary eye-contact metric |

## 3. Phase 0 — Transcription quick wins

### 3.1 Sample-rate auto-match
The agent config hardcodes `audio.input.sample_rate = 48000`, but a browser `AudioContext`
may actually run at 44.1 kHz; mislabeled PCM garbles STT. **Fix (frontend):** after creating
the input `AudioContext`, set `tokenResp.config.audio.input.sample_rate = inCtx.sampleRate`
before passing the config to `startVoiceAgent` (which sends `Settings`). Also `console.log`
the actual rate.

### 3.2 Keyterms
Add a `keyterms` array to the nova-3 `listen` provider in `build_agent_config` (`deepgram.py`):
the role title plus a small generic interview set, e.g. `["STAR", "behavioral", "<role>"]`.
Kept as a tunable constant/list.

## 4. Phase 1 — Models & throttling (client)

- **FaceLandmarker** (existing) — every frame. Now also captures the 8 `eyeLook*` blendshapes.
- **PoseLandmarker** (new, `pose_landmarker_lite.task`) — throttled to ~8/sec (run only when
  `now - lastPoseTs >= POSE_THROTTLE_MS`, default 120 ms; otherwise reuse last result).
- **HandLandmarker** (new, `hand_landmarker.task`, `numHands: 2`) — throttled to ~8/sec.
- All three share one `FilesetResolver` (vision WASM); each created with `runningMode: "VIDEO"`.
- Throttle constant `POSE_THROTTLE_MS` (and reuse for hands) in `config.js`.

## 5. Data contract — `Frame` additions

Existing: `{t, turn, face, bs, m}`. Additions:
- `bs` gains: `eyeLookInLeft, eyeLookInRight, eyeLookOutLeft, eyeLookOutRight,
  eyeLookUpLeft, eyeLookUpRight, eyeLookDownLeft, eyeLookDownRight`.
- `pose` — present only on pose-frames, else omitted/`null`. Normalized image-space points
  (each `{x, y}`, plus `visibility`): `nose, leftShoulder, rightShoulder, leftEar, rightEar,
  leftHip, rightHip`.
- `hands` — present only on hand-frames, else omitted/`null`. A list (0–2) of
  `{handedness, wrist:{x,y}, indexTip:{x,y}, middleTip:{x,y}}`.

Pose, hands, and face all share the same normalized image coordinate space, so hand↔face
proximity is computed against pose landmarks (no separate face bbox needed).

## 6. New metrics (server-side, per-question + overall)

All thresholds are named tunable constants at the top of `analysis.py`. Each metric is a
pure function over the frame list; per-question segmentation reuses the existing `turn` grouping.

- **`gaze_eye_contact_pct`** — per frame, `horiz = max(eyeLookOut*, eyeLookIn*)`,
  `vert = max(eyeLookUp*, eyeLookDown*)`; **on-camera** when `face` is true and
  `horiz < GAZE_MAX` and `vert < GAZE_MAX` (default 0.5). Percentage over total frames.
  This replaces the head-pose `eye_contact_pct` as the primary eye-contact metric.
- **`upright_pct`** — over pose-frames: `shoulderMidY = (Ls.y+Rs.y)/2`,
  `headRise = shoulderMidY - nose.y` (y grows downward), `width = |Ls.x - Rs.x|`;
  **upright** when `headRise / width > UPRIGHT_RATIO` (default 0.5). Percentage over pose-frames.
- **`lean`** — lateral shoulder tilt: mean of `atan2(Rs.y - Ls.y, Rs.x - Ls.x)` magnitude in
  degrees over pose-frames. (Forward/back lean is unreliable in monocular 2D and is **omitted**.)
- **`body_steadiness`** — mean per-(pose-)frame displacement of `nose` + shoulder midpoint;
  `steadiness = clamp(0,100, 100 - BODY_K * movement)` (same shape as head steadiness).
- **`hand_fidget`** — mean per-(hand-)frame displacement of wrist points; reported as a movement
  value (higher = more fidgeting). `0` if hands rarely detected.
- **`face_touch_count`** — over hand-frames, a "touch" when any hand point (`wrist/indexTip/
  middleTip`) is within `FACE_TOUCH_RADIUS * shoulderWidth` of `nose`; count **rising edges**
  (touch onsets), using the pose data from the same frame.

`MetricBlock` keeps its existing keys and gains: `gaze_eye_contact_pct`, `upright_pct`, `lean`,
`body_steadiness`, `hand_fidget`, `face_touch_count`. The existing head-pose `eye_contact_pct`
is removed in favor of gaze; `head_movement`/`steadiness_score` (head) remain as composure.

## 7. Report / UI / files

- **Results UI** (via the `frontend-design` skill): add the new metrics to `#metrics-overall`;
  the per-question table keeps the most legible set (gaze eye-contact, upright %, body steadiness,
  face-touches); full detail lives in `summary.json`.
- **Charts** (`report.py`): add a third panel — posture (`upright`/lean) and fidget over time.
- **CSV** (`report.py`): add columns for gaze on/off, pose-derived values, hand fidget, and a
  face-touch flag (blank when pose/hands absent that frame).
- **`summary.json`/`data.json`**: carry all new fields.

## 8. File changes

- `frontend/config.js` — `POSE_MODEL_URL`, `HAND_MODEL_URL`, `POSE_THROTTLE_MS`, extended
  `BLENDSHAPES` (add `eyeLook*`).
- `frontend/landmarks.js` *(new)* — small helpers: pick pose/hand key points from MediaPipe
  results into the `Frame` shape (keeps `app.js` focused).
- `frontend/app.js` — init Pose + Hand landmarkers; throttled detect; assemble extended `Frame`;
  the §3.1 sample-rate fix; pass new fields through.
- `backend/deepgram.py` — `keyterms` in the listen config.
- `backend/analysis.py` — new pure metric functions + extended `compute_metrics`/`MetricBlock`
  (TDD); remove head-pose `eye_contact_pct`, add gaze.
- `backend/report.py` — CSV columns + new chart panel.
- `tests/test_analysis.py` — unit tests for each new metric.

## 9. Testing

Unit tests with synthetic frames for: gaze on/off, upright vs slouched, lateral lean,
body steadiness, hand fidget, and face-touch rising-edge counting. Empty/absent pose/hand
frames must be handled (metrics degrade gracefully to 0, never crash). Existing tests updated
for the gaze-based eye-contact change.

## 10. Out of scope

Holistic landmarker; client-side metric computation; precise forward/back lean; gesture
*naming*; virtual background/segmentation; audio/emotion classification; AudioWorklet rewrite
(deferred). No change to the Deepgram interview flow beyond keyterms + sample-rate.
