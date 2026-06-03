# Integrity Signals + Facial Tension + Live Actions Feed — Design

**Date:** 2026-06-03
**Status:** Approved (pending spec review)
**Builds on:** the detailed review page + gesture overlay.

## 1. Purpose

Add tier-2 MediaPipe capabilities to the interview app:
- **A. Multi-face integrity** — detect a second person in frame.
- **B. Object detection** — detect prominent objects (flagging device-type ones: phone, laptop, etc.).
- **C. Richer expression** — capture more blendshapes and derive a "facial tension" signal.
- **D. Live actions feed** — a transcript-like timeline of discrete actions (gestures, facial
  expressions, head nod/shake), shown live during the interview and recorded for the report.

Integrity items are **signals, not proof of cheating**, and are presented as such.

## 2. Core decisions (from brainstorming)

| Decision | Choice |
|----------|--------|
| Objects flagged | Report **any** prominent object above threshold; flag the device subset as concerns |
| Expression depth | **Both** a derived `facial_tension` composite and the raw new signals |
| Multi-face | `numFaces: 2`; flag when a 2nd face appears |
| Actions logged | Gestures + key expressions + head nod/shake |
| Actions shown | **Live panel during interview + report timeline & counts** |

## 3. Models / capture (frontend)

- **Face Landmarker → `numFaces: 2`.** `Frame.face_count` = number of faces this frame; draw the mesh on all detected faces.
- **Object Detector (new)** — `efficientdet_lite0.tflite`, `runningMode: "VIDEO"`, `scoreThreshold: 0.4`, run on the existing throttle gate (~8/sec). `Frame.objects` (only on throttled frames) = `[{label, score}]`. Draw detection boxes + labels on the canvas.
- **Richer blendshapes** added to `CONFIG.BLENDSHAPES` (no new model): `eyeSquintLeft/Right`,
  `mouthPressLeft/Right`, `browDownLeft/Right`, `jawLeft`, `jawRight`, `noseSneerLeft/Right`,
  `mouthFrownLeft/Right`.

## 4. Data contract additions

- **`Frame`**: `face_count` (int); `objects` (list of `{label, score}`, only on throttled frames; absent otherwise); new blendshapes flow through `bs`.
- **`/api/session` payload**: new top-level `events` array — `[{t, turn, kind, label, icon}]`
  (`kind` ∈ `gesture | expression | head`). `SessionRequest` gains `events: list[dict] = []`.
- **`summary`** gains `integrity` and `actions` (top-level); `MetricBlock` gains the tension fields.

## 5. New server-side metrics (`backend/analysis.py`, pure + TDD)

- **`integrity_metrics(frames)` → dict** (session-level, set as `summary["integrity"]`):
  - `multi_face_pct` = % frames with `face_count > 1`; `another_person_detected` (bool).
  - `objects_seen` = list of `{label, pct}` (pct over frames that ran object detection) for every
    label seen; sorted by pct desc.
  - `device_in_frame_pct` + `device_detected` (bool) over the concern set
    `CONCERN_OBJECTS = {"cell phone","laptop","tv","book","remote","keyboard"}`.
- **Facial tension** — extend `expression_detail(frames)` with raw means `eye_squint`, `lip_press`,
  `brow_down`, `jaw_shift`, `nose_sneer`, `mouth_frown` (each = mean over face frames of the
  max of its left/right pair), and composite `facial_tension` = `round(100*(eye_squint+lip_press+brow_down)/3, 1)`.
- **`summarize_actions(events)` → dict** (set as `summary["actions"]`): `counts` (per-label tally),
  `total` (int). The raw `events` list is also carried in `summary["actions"]["events"]`.

## 6. Live actions detection (frontend `frontend/actions.js`, new)

A stateful `createActionDetector()` returning `{ feed(frame, gestureResult, headPose) -> Event[] }`
that converts continuous signals into debounced discrete events. Tunable constants live here.

- **Gesture events:** from `gestureResult.gestures[h][0].categoryName` (Gesture Recognizer's built-in
  set). Track last gesture per hand; emit when a new non-`None` gesture starts; reset to allow re-fire
  when it returns to `None`/absent. Icon map: `Thumb_Up`👍, `Victory`✌️, `Open_Palm`✋,
  `Closed_Fist`✊, `Pointing_Up`☝️, `Thumb_Down`👎, `ILoveYou`🤟.
- **Expression events** (hysteresis): 🙂 Smile (`mouthSmile` avg > 0.5), ☹️ Frown (`mouthFrown` avg > 0.4),
  🤨 Eyebrow raise (`browInnerUp` or `browOuterUp` > 0.5), 😮 Surprise (`jawOpen` > 0.5). Per-expression
  active flag; emit on false→true; re-arm only after dropping below `threshold − 0.15`.
- **Head nod/shake:** maintain a rolling ~1000 ms buffer of `(t, pitch, yaw)`. Emit 🙆 Nod when pitch
  shows ≥2 direction reversals with amplitude > `NOD_AMP_DEG` (≈6°) within the window; 🙅 Shake likewise
  on yaw. Per-type cooldown ≈1500 ms to avoid repeats.
- Each event: `{t: ms-since-start, turn: current question index, kind, label, icon}`.

## 7. UI

- **Interview screen:** new **`#actions` panel** beside `#transcript`, a scrolling list of
  `mm:ss · <icon> <label>` lines (appended live by `app.js`, DOM-safe).
- **Results page:**
  - `#card-presence` **retitled "Integrity"**: face-present %, **another-person** flag + multi-face %,
    **objects seen** list, **device-in-frame** flag.
  - `#card-expression`: add **Facial tension: N/100** + the raw tension signals.
  - New **Actions section**: `#card-actions` (counts like "👍 ×3 · 🙂 ×5 · 🙆 ×2") and
    `#actions-timeline` (the full timestamped list).
  - One-line note: integrity/object/multi-face are *signals*, not proof.

## 8. Files

- `frontend/config.js` — `OBJECT_MODEL_URL`, new blendshapes.
- `frontend/landmarks.js` — `pickObjects(result)` → `[{label, score}]`.
- `frontend/actions.js` *(new)* — `createActionDetector()` event logic + icon maps + thresholds.
- `frontend/app.js` — `numFaces: 2`; ObjectDetector init + throttled detect; capture `face_count`/`objects`;
  draw object boxes + all-face meshes; run the action detector each frame, append to `events[]` and the
  live `#actions` panel; send `events` in the payload; render Integrity/tension/Actions on results.
- `backend/analysis.py` — `integrity_metrics`, tension in `expression_detail`, `summarize_actions` (TDD).
- `backend/main.py` — `SessionRequest.events`; `summary["integrity"]`, `summary["actions"]`.
- `frontend/index.html` + `style.css` — `#actions` panel (interview), retitle Integrity card, Actions
  section (results) — via `frontend-design`.
- `tests/test_analysis.py`, `tests/test_main.py` — extended.

## 9. Testing

Unit tests (synthetic frames/events) for `integrity_metrics` (multi-face %, objects_seen, device flag),
the tension fields in `expression_detail`, and `summarize_actions` (counts/total). Empty/absent inputs
degrade to zeros/empty. The frontend `actions.js` debounce logic is verified manually (browser); its
pure pieces can get light `node --check`. Existing tests stay green.

## 10. Performance

Now Face (every frame, 2 faces) + Pose + Gesture + **Object** (all throttled). `efficientdet_lite0` is
light; if FPS drops, raise `POSE_THROTTLE_MS`. The action detector runs every frame but is pure arithmetic.

## 11. Planning note

Larger iteration — to keep execution reviewable it will likely be split into **two plans**:
(1) A+B+C (integrity, objects, tension) and (2) D (live actions feed).

## 12. Out of scope

Face *identity*/recognition (multi-face only counts faces); custom-trained gestures; background
segmentation; chart changes; audio/voice analysis.
