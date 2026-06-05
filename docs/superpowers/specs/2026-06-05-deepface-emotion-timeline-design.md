# DeepFace Emotion Timeline — Design

**Date:** 2026-06-05
**Status:** Approved (brainstorming) — pending implementation plan
**Feature:** Add a DeepFace-powered labeled-emotion timeline to the interview report, alongside
the existing MediaPipe analysis. First of three candidate DeepFace features (emotion, identity
verification, liveness); see [docs/features/mediapipe-vs-deepface.md](../../features/mediapipe-vs-deepface.md).

---

## 1. Overview

The current report derives facial *signals* from MediaPipe blendshapes (smile, brow, gaze, etc.)
but has **no labeled emotion** — a long-standing gap noted in
[mediapipe-limitations.md](../../features/mediapipe-limitations.md). This feature samples face
crops during the interview, runs DeepFace emotion classification on the backend after the
interview ends, and adds a **new, additive** emotion section to the results page. Nothing in the
existing layout, metrics, or pipeline changes.

## 2. Goals / Non-goals

**Goals**
- Per-question and over-time labeled emotion (7 classes: angry, disgust, fear, happy, sad,
  surprise, neutral) with confidence scores.
- Purely additive: zero regression to the MediaPipe report or interview UX.
- Optional and gracefully degrading: the app runs and reports generate normally when DeepFace is
  disabled, not installed, or produced no data.
- Privacy-preserving: face images are scored in memory and immediately discarded.

**Non-goals (this phase)**
- Identity verification and liveness/anti-spoofing (future DeepFace phases).
- Live/real-time emotion during the interview (this is batch-at-end).
- Persisting face images or any biometric raw data.
- Using emotion for candidate scoring — it is a supplementary, transparently-labeled signal only.

## 3. Locked decisions

| Decision | Choice |
|---|---|
| Feature | Emotion timeline |
| Processing model | Batch at end of interview |
| Sampling | ~1 face crop / 3s, hard-capped at 200 shots |
| Detection | Client-side crop using the MediaPipe face box; DeepFace `detector_backend='skip'` |
| Transport | New `POST /api/emotion` (multipart), result echoed into `/api/session` body |
| Image retention | Discard after analysis — never written to disk |
| Dependency | DeepFace + TF in a **separate** `backend/requirements-emotion.txt`; lazy import |
| Enablement | Env `EMOTION_ANALYSIS=1` **and** successful DeepFace import |
| UI | Additive: new emotion card + `emotion.png` chart + one per-question column |

## 4. Architecture & data flow

**Module boundaries (each independently testable):**
- `backend/emotion.py` — (a) `score_emotions(images)` thin DeepFace wrapper (lazy import);
  (b) `aggregate_emotions(shots, questions)` pure aggregation, no ML dependency.
- `POST /api/emotion` in `backend/main.py` — multipart upload of face crops.
- Frontend capture helper + results rendering in `frontend/`.

**Flow:**
1. **During interview** (`renderLoop` in `app.js`): when a face is present, on a ~3s throttle,
   crop the face region from the video (bounding box derived from `faceLandmarks`), scale to a
   ~112px JPEG, push `{t, turn, blob}` into an `emotionShots` buffer (capped at 200).
2. **On End interview** (`endInterview`): before the existing `/api/session` POST, upload the
   buffered crops to `/api/emotion` as multipart — `images[]` + a JSON `meta` array of
   `{t, turn}` aligned by index.
3. **Backend `/api/emotion`**: if enabled and DeepFace importable, run
   `DeepFace.analyze(actions=['emotion'], detector_backend='skip', enforce_detection=False)` per
   crop → dominant emotion + 7 class scores. **Images held in memory only; never persisted.**
   Returns the aggregated emotion summary.
4. **Client** includes the returned `emotion` object in the existing `/api/session` JSON body
   (like `events` today). Backend merges it into `summary["emotion"]`; `save_session` persists
   only derived numbers and renders `emotion.png`.
5. **Graceful degradation**: disabled / not installed / no crops → `/api/emotion` returns
   `{available: false}`; results page shows "Emotion analysis not available". Interview and the
   rest of the report are unaffected.

**Why a separate endpoint:** keeps `/api/session` JSON-only and unchanged, isolates the one
heavy/slow/optional operation behind its own endpoint and failure mode, and mirrors how `events`
are computed out-of-band and passed into the session.

## 5. Frontend capture

- **Config** (`frontend/config.js`): `EMOTION_THROTTLE_MS: 3000`, `EMOTION_CROP_PX: 112`,
  `EMOTION_MAX_SHOTS: 200`.
- **Bounding box**: derive from `faceLandmarks` min/max x,y (normalized), pad ~20%, clamp to
  frame, convert to pixels. Small pure helper.
- **Crop**: offscreen canvas; `drawImage(video, sx,sy,sw,sh, 0,0,112,112)` →
  `toBlob(..., 'image/jpeg', 0.8)`. Only when `hasFace`, throttle elapsed, and under the cap.
  Buffer `{t: frame.t, turn: turnIndex, blob}`; reset in `startInterview` alongside
  `frames`/`events`.
- **Upload** (in `endInterview`, before `/api/session`): `FormData` with each blob as `images`
  and JSON `meta` `[{t,turn},…]` in matching order; `POST /api/emotion`. On success hold the
  returned `emotion`; on any failure set it `null`. Then include `emotion` in the `/api/session`
  body. A failed/empty upload never blocks the report.

## 6. Backend module, dependency & graceful degradation

- `backend/emotion.py`:
  - `score_emotions(images: list[bytes]) -> list[dict]` — lazy `import` of DeepFace inside the
    function. Per image: `DeepFace.analyze(..., actions=['emotion'], detector_backend='skip',
    enforce_detection=False)` → `{dominant, scores}`. Per-shot exceptions skipped and logged.
  - `aggregate_emotions(shots, questions) -> dict` — **pure, no ML import**. The unit-tested core.
- **Feature flag**: gated by env `EMOTION_ANALYSIS=1` and a successful DeepFace import. Off or
  import-fails → `{available: false}`. Mirrors the `if anthropic_key` coaching pattern in
  `backend/main.py`.
- **Dependency packaging**: DeepFace + `tf-keras`/`tensorflow-cpu` in a separate
  `backend/requirements-emotion.txt`, NOT base `requirements.txt`. Base install and CI stay
  light. DEPLOY.md gets an optional "enable emotion analysis" step. First run downloads the small
  (~5 MB) emotion weights; `detector_backend='skip'` avoids detector weights.

## 7. Report & UI integration

- **Aggregation → report**: `summary["emotion"]` carries the aggregate. New
  `_build_emotion_chart(path, emotion)` in `backend/report.py` renders a **separate** `emotion.png`
  — a line per emotion score over time with the same red question-boundary lines, plus a
  dominant-emotion strip. The tested 4-panel `_build_charts` is untouched. `save_session` writes
  `emotion.png` only when `emotion.available`.
- **Results page** (`app.js renderResults` + `index.html`): new `card-emotion` (overall dominant
  + distribution, e.g. `neutral 48% · happy 22% · …`) and a new `<img>` for `emotion.png`. The
  per-question table gets one added **Emotion** column. Existing cards/columns unchanged.
- **Response shape**: `/api/emotion` returns
  `{available, overall_distribution, dominant, per_question, timeline}`; client echoes it into the
  `/api/session` body as `emotion`; `/api/session` returns `emotion_chart_url` (or null) next to
  `charts_url`.

### Data shapes

```jsonc
// POST /api/emotion  (multipart: images[]=jpeg, meta=JSON string)
// meta: [{ "t": 1234.5, "turn": 0 }, ...]   // index-aligned with images[]

// /api/emotion response  (== summary["emotion"])
{
  "available": true,
  "dominant": "neutral",
  "overall_distribution": { "neutral": 48.0, "happy": 22.0, "sad": 10.0, /* ...7 classes... */ },
  "per_question": [
    { "turn": 0, "dominant": "neutral", "distribution": { /* 7 classes, pct */ } }
  ],
  "timeline": [
    { "t": 1234.5, "turn": 0, "dominant": "neutral", "scores": { /* 7 classes, 0-100 */ } }
  ]
}
// available:false  → { "available": false }
```

## 8. Privacy & consent

- One-line start-screen notice: *"This interview analyzes your facial expressions. Face snapshots
  are processed and immediately discarded — only aggregate scores are saved."* (text only).
- Enforced in code: `score_emotions` holds image bytes only for the call; no disk writes; session
  folder stores only derived numbers.
- Emotion framed as supplementary, not ground truth, consistent with mediapipe-limitations.md.

## 9. Testing

- **Pure aggregation** (`aggregate_emotions`): synthetic shot records → overall distribution,
  per-question dominant, timeline ordering, empty/`available:false` path. No TensorFlow.
- **Graceful degradation**: `score_emotions` with DeepFace import patched to fail →
  `{available:false}`; `/api/emotion` endpoint test with `score_emotions` monkeypatched to canned
  scores (no real ML in CI).
- **Report**: `_build_emotion_chart` writes a PNG when data present; skipped when absent.
- **Real DeepFace** stays out of CI (heavy); manual/local smoke check documented in DEPLOY.md.

## 10. Out of scope / future

- Identity verification (needs reference-photo enrollment) — next DeepFace phase, reuses this
  frames→backend pipeline.
- Liveness / anti-spoofing — `DeepFace.extract_faces(anti_spoofing=True)`, reuses this pipeline.
- Live/real-time emotion readout during the interview.
