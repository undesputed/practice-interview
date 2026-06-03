# Detailed Review Page — Design

**Date:** 2026-06-03
**Status:** Approved (pending spec review)
**Builds on:** body-language signals + gesture overlay specs.
**References:** `docs/features/data points` (wish-list) · `docs/features/mediapipe-limitations.md` (what we omit).

## 1. Purpose

Redesign the end-of-interview review page into a **detailed, honest breakdown** of every signal
we can actually produce from MediaPipe, organized into the categories from `docs/features/data
points`, with a **large full-width timeline chart** as its own section. Add several derivable
metrics (expression detail, gaze breakdown, head-pose stats, four heuristic composite scores,
and transcript-derived speaking/timing). Metrics MediaPipe cannot produce are **omitted** (see
the limitations doc), not faked.

## 2. Core decisions (from brainstorming)

| Decision | Choice |
|----------|--------|
| Metric depth | Full detail — surface all existing metrics + add derivable ones |
| Layout | "Chart lower": scores → detail cards → per-question table → big chart → coaching |
| Infeasible items | Omit entirely (documented in `mediapipe-limitations.md`) |
| Charting | Keep matplotlib PNG, rendered bigger/full-width with more series |
| Composites | Heuristic, tunable, clearly labeled supplementary (BIPA/EU-AI-Act caution) |

## 3. New data captured (frontend)

Add to `CONFIG.BLENDSHAPES`: `jawOpen`, `browOuterUpLeft`, `browOuterUpRight`. (`pickBlendshapes`
already forwards whatever's in the list, so `Frame.bs` gains these with no other capture change.)
Eye openness derives from the already-captured `eyeBlink*`. No new models.

## 4. New server-side metrics (`backend/analysis.py`, pure + TDD)

Computed per-question and overall where sensible; all thresholds/weights are named tunable constants.

- **Expression detail** (`expression_detail(frames)`): `eye_openness` (mean `1 − max(eyeBlinkL,eyeBlinkR)`),
  `mouth_open_mean` (mean `jawOpen`), `speaking_pct` (% frames `jawOpen > SPEAKING_OPEN`),
  `eyebrow_raise` (mean of `browInnerUp, browOuterUpLeft, browOuterUpRight`).
- **Gaze breakdown** (`gaze_breakdown(frames)`): % of face-frames in each of center / left / right /
  up / down, from the dominant `eyeLook*` direction (center when all below `GAZE_MAX`).
- **Head-pose stats** (`head_pose_stats(frames)`): mean and (min,max) range of pitch / yaw / roll.
- **Composite scores 0–100** (heuristic, tunable weights):
  - `attention` = `0.5·gaze_eye_contact_pct + 0.3·steadiness_score + 0.2·(100 − no_face_pct)`
  - `confidence` = `0.5·upright_pct + 0.5·body_steadiness`
  - `nervousness` = clamp of `0.3·min(100, blinks_per_min·5) + 0.3·(100 − gaze_eye_contact_pct) + 0.2·min(100, face_touch_count·20) + 0.2·min(100, hand_fidget·2000)`
  - `composure` = `(steadiness_score + body_steadiness) / 2`
- **Transcript-derived** (`transcript_metrics(segments)` — new, takes transcript segments):
  - `speaking_pct` (candidate speaking time ÷ total, from consecutive segment timestamps),
  - `mean_response_sec` (latency from each interviewer line to the next candidate line),
  - `per_question_response_sec` (list aligned to interviewer turns).

`MetricBlock` gains: `eye_openness, mouth_open_mean, speaking_pct, eyebrow_raise,
gaze_breakdown` (sub-dict), `head_pose` (sub-dict: pitch/yaw/roll mean+range), `attention,
confidence, nervousness, composure`. The empty-frames path returns these as zeros/empty. The
transcript metrics live at the top level of `summary` (computed once from segments in `main.py`),
not inside per-question `MetricBlock`s — except `per_question_response_sec`, aligned by turn.

## 5. Bigger chart (`backend/report.py`)

Render a **larger** figure (e.g. `figsize=(14, 11)`, higher dpi) with more stacked series:
smile, gaze on/off, pitch+yaw, posture (upright), mouth-open — with the existing per-question
boundary lines. Saved as `charts.png`; the frontend displays it full-width.

## 6. Results page (`frontend/index.html`, `style.css` via `frontend-design`; `app.js` rendering)

Layout (top→bottom):
1. **Header** + four big **score chips**: Attention, Confidence, Nervousness, Composure.
2. **Detail cards** grouped by category:
   - **Eye & Gaze:** gaze eye-contact %, gaze breakdown (C/L/R/U/D), blink count + /min, eye openness.
   - **Head Pose:** pitch/yaw/roll mean + range, head movement/steadiness.
   - **Expression:** smile mean/peak, eyebrow raise, mouth-open / speaking %.
   - **Posture & Body:** upright %, lateral lean, body steadiness, hand fidget, face-touch count.
   - **Engagement:** speaking vs listening %, mean response time.
   - **Presence:** face-presence % (the one integrity signal we keep).
3. **Per-question table:** Question · Eye contact · Upright · Composure · Response time · Face-touch.
4. **Big full-width chart** section (`#chart-img`).
5. **AI coaching** + saved-data path.
6. A one-line **disclaimer**: signals are supplementary, not objective emotion/identity scoring.

`app.js renderResults` builds the cards/chips/table from the extended summary using safe
`createElement`/`textContent` (no `innerHTML`). Required element IDs preserved/added for binding.

## 7. Files

- `frontend/config.js` — +3 blendshapes.
- `frontend/app.js` — `renderResults` rewritten to populate score chips + category cards + new table columns (DOM-safe).
- `frontend/index.html`, `frontend/style.css` — redesigned results screen (via `frontend-design`), new element IDs.
- `backend/analysis.py` — new pure functions + composites + `MetricBlock` extension (TDD).
- `backend/main.py` — call `transcript_metrics(segments)`, merge into `summary`.
- `backend/report.py` — bigger multi-series chart.
- `tests/test_analysis.py` (+ `tests/test_main.py` if summary shape asserted) — extended.

## 8. Testing

Unit tests (synthetic frames/segments) for: eye/mouth openness, speaking %, eyebrow raise,
gaze breakdown, head-pose stats, each composite score, and transcript timing (speaking %,
response latency). Empty/absent inputs degrade to zeros without crashing. Existing tests stay green.

## 9. Out of scope

Everything in `docs/features/mediapipe-limitations.md` (emotions, micro-expressions, pupil,
identity, liveness, multi-face, age/gender, stress/lip-biting, authenticity); interactive JS
charting (matplotlib PNG only); changes to the live interview flow.
