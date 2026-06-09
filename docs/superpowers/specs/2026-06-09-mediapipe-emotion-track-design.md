# MediaPipe-Derived Emotion Track — Design

**Date:** 2026-06-09
**Status:** Approved (design), pending implementation plan

## Overview

Add a second, independent labeled-emotion track derived **entirely from MediaPipe
blendshape coefficients the app already collects** — no pixels, no TensorFlow. It
runs server-side, emits the **same 7-class shape** as the existing DeepFace track,
and is shown **side-by-side** with DeepFace in the report so the two can be
compared. The existing DeepFace track and all raw MediaPipe metrics are left
completely untouched; this is purely additive.

The 7 classes match DeepFace's FER model: `angry, disgust, fear, happy, sad,
surprise, neutral` (`EMOTION_CLASSES` in [`backend/emotion.py`](../../../backend/emotion.py)).

## Goals

- A labeled-emotion timeline + per-question + overall distribution from blendshapes.
- Rendered **next to** the DeepFace track, not replacing it (side-by-side comparison).
- Zero new dependencies; no face pixels leave the client for this track.
- Transparent, tunable mapping (constants in the style of the existing thresholds).
- Honest framing: an *inferred, supplementary* signal — never presented as ground truth.

## Non-Goals

- Removing or modifying the DeepFace track or any existing MediaPipe metric.
- A trained/ML classifier (see Future Work — requires labeled data we don't have).
- Using emotion for candidate **scoring** (see Risks — legally restricted).
- Micro-expressions, valence/arousal dimensional model, or per-frame UI overlay.

## Architecture & Data Flow

```
MediaPipe (browser)
  frames[].bs  ──▶  analysis.emotion_from_blendshapes(frames)   [NEW]
  (blendshape           │  per-frame EMFACS scoring → shot records
   coefficients,        ▼
   no pixels)        aggregate_emotions(shots)   [REUSED, emotion.py]
                        │
                        ▼
                  summary["emotion_mediapipe"]   [NEW key]

DeepFace track (unchanged)
  face crops ──▶ /api/emotion ──▶ DeepFace ──▶ summary["emotion"]
```

Both emotion summaries share the identical dict shape produced by
`aggregate_emotions()`:

```
{ "available": bool,
  "dominant": str,
  "overall_distribution": {class: 0-100},
  "per_question": [{turn, dominant, distribution}],
  "timeline": [{t, turn, dominant, scores}] }
```

This shape-compatibility is the key design lever: the new track reuses the
existing aggregator, chart builder, and report-card rendering with minimal new
code.

## The Mapping (`emotion_from_blendshapes`)

MediaPipe's 52 blendshapes are ARKit-style Action Unit (AU) proxies. Ekman's
EMFACS defines which AU combinations signal each basic emotion. For each face
frame we compute a raw score per expressive emotion as a weighted sum of its
diagnostic blendshapes, derive neutral from low overall activation, then
normalize the 7 raw scores into a distribution summing to 100. The dominant
emotion is the argmax.

| Emotion  | Diagnostic blendshapes (AU proxy)                                   |
|----------|---------------------------------------------------------------------|
| Happy    | `mouthSmile` + `cheekSquint`  (AU6+12)                               |
| Sad      | `mouthFrown` + `browInnerUp` + `browDown`  (AU1+4+15)                |
| Angry    | `browDown` + `mouthPress` (lip press) + `eyeSquint`  (AU4+7+23)      |
| Surprise | `browInnerUp` + `browOuterUp` + `eyeWide` + `jawOpen`  (AU1+2+5+26)  |
| Fear     | surprise combo **+ `browDown` + `mouthStretch`**  (AU1+2+4+5+20+26)  |
| Disgust  | `noseSneer` + `mouthUpperUp`  (AU9+10)                               |
| Neutral  | low total activation across all of the above                        |

Rules:
- Left/right blendshape pairs are averaged (e.g. `mouthSmileLeft`/`Right`).
- Weights live as a module constant table (`EMOTION_WEIGHTS`), tuned like the
  existing `SMILE_THRESHOLD` / `GAZE_MAX` block in `analysis.py`.
- Neutral score = a base value minus total expressive activation (clamped ≥ 0),
  so a relaxed face resolves to neutral.
- Normalize the 7 raw values to sum to 100 → `scores`; `dominant = argmax`.
- Per-frame output `{dominant, scores}` → shot record `{t, turn, dominant, scores}`
  (turn taken from `frame["turn"]`) → list passed to `aggregate_emotions()`.

**Known accuracy limits (stated, not hidden):** fear vs surprise and disgust are
the least reliable — they hinge on `browDown` / `mouthStretch` / `noseSneer`
separating otherwise-similar AU patterns. This is a heuristic; the UI labels it
as inferred. (DeepFace shares the same weakness on these classes.)

## Components & Changes (file by file)

### `frontend/config.js` — forward the missing blendshapes (prerequisite)
`app.js` forwards only the blendshapes listed in `CONFIG.BLENDSHAPES`
([`app.js:110-112`](../../../frontend/app.js)). Add the emotion-critical ones
MediaPipe produces but we currently drop:
`cheekSquintLeft`, `cheekSquintRight`, `mouthUpperUpLeft`, `mouthUpperUpRight`,
`eyeWideLeft`, `eyeWideRight`, `mouthStretchLeft`, `mouthStretchRight`.
No other frontend logic changes — `pickBlendshapes` picks them up automatically.
Sessions recorded before this change degrade gracefully (those signals read 0).

### `backend/analysis.py` — new mapping function
- Add `EMOTION_WEIGHTS` constant table (per the mapping above).
- Add `emotion_from_blendshapes(frames: list[dict]) -> dict`:
  - Iterate face frames with a `bs` dict; compute per-frame 7-class distribution.
  - Build shot records; call `aggregate_emotions()` (imported from `backend.emotion`).
  - Return `{"available": False}` when there are no usable face frames.
- Keep it a pure function (no I/O) so it's trivially unit-testable, matching the
  style of `expression_detail` / `composite_scores`.

### `backend/main.py` — wire the new track
In `/api/session`, after computing `summary`:
```python
summary["emotion_mediapipe"] = emotion_from_blendshapes(req.frames)
```
`summary["emotion"]` (DeepFace) is unchanged. Return a second chart URL:
```python
emotion_mp_chart_url = (f"/sessions/{session_id}/emotion_mediapipe.png"
                        if summary["emotion_mediapipe"].get("available") else None)
```
added to the JSON response alongside the existing `emotion_chart_url`.

### `backend/report.py` — second chart
`_build_emotion_chart()` is already generic over an emotion dict. In `save_session`,
also render `emotion_mediapipe.png` from `summary["emotion_mediapipe"]`, wrapped in
the same try/except so a malformed payload can't lose the session.

### Frontend report rendering (`app.js` / `index.html` / `style.css`)
- Relabel the existing emotion card **"Emotion — DeepFace (pixel-based)"**.
- Add a parallel card/column **"Emotion — MediaPipe (blendshape-derived)"** reading
  `data.summary.emotion_mediapipe` and `data.emotion_mediapipe_chart_url`, reusing
  the existing dominant + chart rendering.
- Both cards show the "inferred, supplementary — not ground truth" disclaimer.
- Privacy notice: state that the MediaPipe track uses **no pixels** (coefficients
  only), so it is strictly more privacy-preserving than the DeepFace track.

## Error Handling & Edge Cases

- No face frames / no blendshapes → `{"available": False}` (same contract as DeepFace).
- Missing blendshape keys → default `0.0` via `bs.get(key, 0.0)` (existing pattern).
- Frames from older sessions lacking the newly-forwarded blendshapes → those
  emotions score lower but the function still runs.
- Chart building stays inside `try/except` (report.py already does this for emotion).

## Testing

New tests in `tests/test_analysis.py` (or extend `tests/test_emotion.py`), mirroring
the synthetic-frame style already used:
- A frame with high `mouthSmile`+`cheekSquint` → dominant `happy`.
- High `browDown`+`mouthPress`+`eyeSquint` → dominant `angry`.
- High `browInnerUp`+`browOuterUp`+`eyeWide`+`jawOpen` → dominant `surprise`.
- High `noseSneer`+`mouthUpperUp` → dominant `disgust`.
- All-low activation → dominant `neutral`.
- No face frames / empty list → `{"available": False}`.
- Frames missing the new blendshape keys → still returns a valid distribution.
- Distribution always sums to ~100 and every class is present.

## Documentation Updates

These docs currently state MediaPipe **cannot** produce labeled emotion; they must
be reframed (not contradicted) to: "no *native* classifier; we add a clearly-labeled
*heuristic EMFACS inference* shown alongside DeepFace."
- [`docs/features/mediapipe-limitations.md`](../../features/mediapipe-limitations.md) —
  Emotion & Expression section.
- [`docs/features/mediapipe-vs-deepface.md`](../../features/mediapipe-vs-deepface.md) —
  the "Labeled basic emotions" row (MediaPipe ❌ → ⚠️ heuristic, added) and §5.

## Risks & Legal

- **Validity:** this is inference on top of inference. It will confidently label
  emotions from ambiguous faces. Surfaced as supplementary, never authoritative.
- **Legal:** emotion recognition in workplace/hiring contexts is effectively
  prohibited under the **EU AI Act** and restricted by **Illinois BIPA**. This
  feature must **not** feed candidate scoring; it is a transparent, comparative
  display only. This constraint is a hard requirement, consistent with the existing
  principle in `mediapipe-limitations.md`.

## Future Work

- **Trained classifier (Approach 2):** once enough sessions accumulate, the
  side-by-side DeepFace column can help label blendshape vectors to train a small
  model (logistic regression / MediaPipe Model Maker) that replaces the hand-tuned
  weights. Out of scope here.

## Summary of File Changes

| File | Change |
|---|---|
| `frontend/config.js` | Extend `BLENDSHAPES` with 8 emotion-relevant coefficients |
| `backend/analysis.py` | `EMOTION_WEIGHTS` table + `emotion_from_blendshapes()` |
| `backend/main.py` | Set `summary["emotion_mediapipe"]`; return 2nd chart URL |
| `backend/report.py` | Render `emotion_mediapipe.png` |
| `frontend/app.js`, `index.html`, `style.css` | Second emotion card, relabels, privacy note |
| `tests/test_analysis.py` | Unit tests for the mapping |
| `docs/features/mediapipe-limitations.md`, `mediapipe-vs-deepface.md` | Reframe emotion claims |
