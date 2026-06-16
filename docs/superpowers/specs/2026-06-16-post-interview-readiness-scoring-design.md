# Post-Interview Readiness Scoring — Design

- **Date:** 2026-06-16
- **Status:** Approved (design); pending implementation plan
- **Topic:** When a live interview ends, process the whole interview (facial via MediaPipe + FACS, voice/audio, and transcript), produce a readiness verdict with explanations, and show it on the results page reached from the progress page.

## 1. Problem & Context

The new "Clean Studio" live interview screen ([frontend/screens/live.js](../../../frontend/screens/live.js) + [frontend/interview-engine.js](../../../frontend/interview-engine.js)) renders the transcript and detected actions to the DOM and **discards everything when the interview stops**. It never buffers frames, never keeps the transcript, and never calls a backend, so **no session or report is ever created** from the new flow.

Meanwhile, most of a scoring pipeline already exists and is reachable only from the older `app.js` / `legacy.html` flow:

- `POST /api/session` ([backend/main.py](../../../backend/main.py)) — accepts frames + transcript + events, computes metrics, generates a report, persists to the filesystem ([backend/sessions_store.py](../../../backend/sessions_store.py)).
- [backend/analysis.py](../../../backend/analysis.py) — composite scores **Attention, Confidence, Nervousness, Composure** (0–100) + per-question metrics + EMFACS 7-class emotion from MediaPipe blendshapes (FACS Action Units).
- [backend/emotion.py](../../../backend/emotion.py) — optional HSEmotion (AffectNet) emotion from face crops.
- [backend/anthropic_coach.py](../../../backend/anthropic_coach.py) — Claude reads the transcript → `{summary, strengths, improvements, score 1–10, rationale}`.
- [frontend/screens/report.js](../../../frontend/screens/report.js) — full results page at `#/session/:id`.

**So this work is mostly reuse + wiring, plus one genuinely new piece: voice (audio prosody) analysis, and a new fused readiness verdict.**

## 2. Goals

1. When the live interview ends, capture and persist the interview, generating a report (reusing the existing pipeline).
2. Add **voice delivery analysis** (the audio part) modeled on the molave-ai approach.
3. Produce a single **readiness verdict** ("Ready / Almost / Needs work") with a 0–100 score and **plain-language explanations**, fusing voice + face/body + transcript content.
4. Make the verdict reachable from the **progress page** by clicking a session / data point, opening the existing results page.

## 3. Non-Goals

- This is a **self-improvement / practice** tool, not a hiring screen. The verdict is framed as readiness feedback for the person practicing, never a hire/no-hire decision.
- No new database, user accounts, or auth changes. Keep the filesystem session store.
- No change to how the live interview is conducted (the Deepgram voice agent stays as-is).
- No retraining of emotion models; reuse the existing EMFACS + HSEmotion code.

## 4. Decisions (locked during brainstorming)

| # | Decision | Choice |
|---|----------|--------|
| 1 | Intended use / framing | **Practice + readiness verdict** (self-improvement, not screening) |
| 2 | What the verdict weighs | **Delivery & presence first**, content supporting |
| 3 | Audio capture & analysis | **Full molave-style pipeline**: record audio → dedicated Deepgram pre-recorded pass (word timings + fillers) + pitch/energy DSP |
| 4 | Where the result appears | **Progress page links to the existing results page** ([report.js](../../../frontend/screens/report.js)), enhanced with the verdict + voice breakdown |
| 5 | How the verdict is computed | **Hybrid**: explicit numeric criteria per modality → weighted readiness score + band; Claude writes the explanation from the real numbers |

## 5. The Judging Criteria (core deliverable)

**Overall readiness score: 0–100**, mapped to a band:

- **Ready** ≥ 70
- **Almost ready** 50–69
- **Needs work** < 50

**Modality weights (delivery + presence first):**

- **Delivery (voice): 40%**
- **Presence (face/body): 35%**
- **Content: 25%**

### 5.1 Delivery sub-score (0–100)

Five voice metrics, each scored against an **absolute target range** (full marks inside the band, declining outside). We deliberately use absolute target bands rather than molave's self-relative baseline, because a readiness verdict needs "is this good?", not "compared to your own median." (Per-question trends may still be shown for coaching.)

| Metric | Source | Ideal | Penalized when |
|---|---|---|---|
| Pace (words/min) | Deepgram word timings | ~110–160 wpm | too slow or rushed |
| Filler rate (per 100 words) | Deepgram `filler_words` | < ~3 | more fillers |
| Long pauses (> 1.5 s) | Deepgram word gaps | few | frequent |
| Pitch variation (F0 std) | browser DSP (autocorrelation) | expressive | monotone |
| Loudness / energy (RMS) | browser DSP | steady, audible | very quiet / flat |

Defaults above are starting values and live in one config block so they can be tuned without code changes.

### 5.2 Presence sub-score (0–100)

Reuse the existing composites in [analysis.py](../../../backend/analysis.py):

```
presence = mean(Attention, Confidence, Composure, 100 - Nervousness)
```

These already derive from gaze / head pose / posture / blinks / fidgets. FACS/EMFACS emotion and HSEmotion remain available for display but are not the primary driver of the presence score.

### 5.3 Content sub-score (0–100)

Extend [anthropic_coach.py](../../../backend/anthropic_coach.py) so Claude rates **clarity, structure, specificity, and relevance** of the answers, returned 0–100 (rescaled from today's 1–10), alongside the existing strengths/improvements.

### 5.4 Explanation

The final verdict summary object is **assembled by the backend**, not produced wholesale by Claude:

- The rubric ([verdict.py](../../../backend/verdict.py)) computes `readiness_score` and `verdict_band` — these are authoritative.
- Claude is **given** those numbers + the sub-scores + the transcript, and writes only the **prose fields** to match them.

```json
{
  "verdict_band": "ready | almost | needs_work",   // from rubric
  "readiness_score": 0,                             // from rubric (0–100)
  "headline": "one-sentence verdict",              // from Claude
  "delivery_note": "one line on voice",            // from Claude
  "presence_note": "one line on face/body",        // from Claude
  "content_note": "one line on answers",           // from Claude
  "top_strengths": ["..."],                         // from Claude
  "top_improvements": ["..."],                      // from Claude
  "next_action": "one clear next step"             // from Claude
}
```

This keeps the score deterministic and the explanation readable, and prevents Claude from overriding the numeric verdict.

## 6. Architecture & Data Flow

```
[Live interview]
  interview-engine.js  → buffers per-frame face/pose data (blendshapes, matrix, pose, hands)
  live.js              → buffers transcript lines + action events
  audio-recorder.js    → records candidate mic audio (parallel tap on the existing MediaStream)

[On end]
  browser: compute pitch/energy features from recorded audio (ported from molave acousticFeatures)
  browser: POST /api/session (multipart): meta JSON {role, frames, transcript, events, acoustic_features} + audio blob

[Backend /api/session]
  1. facial/pose metrics  → composite scores → Presence sub-score        (existing analysis.py)
  2. Deepgram pre-recorded on audio → word timings + fillers
     + browser acoustic_features (pitch/energy) → voice metrics → Delivery sub-score  (new voice.py)
  3. Claude on transcript → Content sub-score + strengths/improvements    (extended anthropic_coach.py)
  4. fuse (40/35/25) → readiness_score + band; Claude writes explanation  (new verdict.py)
  5. delete raw audio; persist summary.json
  6. return { session_id, summary (incl. verdict) }

[After]
  browser navigates to #/session/{id}
  report.js renders verdict header + voice section + existing breakdowns

[Progress page]
  progress.js: clicking a session / data point → #/session/{id}
```

### 6.1 Audio capture

The mic `MediaStream` already exists (`engine.getStream()`), and Web Audio allows multiple consumers, so we tap it in parallel with the Deepgram voice agent and record with `MediaRecorder` (webm/opus). No change to the live agent connection.

### 6.2 `/api/session` shape

Extend the endpoint to accept a **multipart** request (mirroring the existing `/api/emotion` pattern): a `meta` JSON part (today's `SessionRequest` fields plus `acoustic_features`) and an optional `audio` file part. Keep the existing JSON body path working so the legacy `app.js` flow does not break (branch on content type).

### 6.3 Why browser DSP + backend Deepgram (split)

- The browser can decode and analyze audio natively (Web Audio), so pitch/energy DSP is cheapest there and reuses molave's existing JS — no new server-side audio-decoding dependency (ffmpeg/librosa).
- The Deepgram pre-recorded call needs the server's API key, so word timings + filler words are computed on the backend.

## 7. New / Changed Components

**Frontend**

- [interview-engine.js](../../../frontend/interview-engine.js) — buffer per-frame data during a run; expose `getFrames()` (and optional face crops for HSEmotion, reusing `EMOTION_THROTTLE_MS`).
- `frontend/audio-recorder.js` *(new)* — record candidate mic audio to a Blob; start/stop with the interview.
- `frontend/acoustic-features.js` *(new)* — pitch (autocorrelation) + energy (RMS) features, ported from molave `acousticFeatures.ts`.
- [live.js](../../../frontend/screens/live.js) — keep transcript + action buffers; on end, gather everything, compute acoustic features, POST to `/api/session`, show a "processing…" state, then navigate to `#/session/{id}`.
- [api.js](../../../frontend/api.js) — `createSession(meta, audioBlob)` multipart helper.
- [progress.js](../../../frontend/screens/progress.js) — make session rows / chart data points clickable → `#/session/{id}`.
- [report.js](../../../frontend/screens/report.js) — add a readiness verdict header (band + score + explanation) and a Voice/Delivery section.

**Backend**

- [main.py](../../../backend/main.py) — extend `/api/session` (multipart + audio; orchestrate voice + verdict).
- `backend/voice.py` *(new)* — Deepgram pre-recorded call (nova-2 with `diarize`/`filler_words`/`utterances`) + prosody metrics + Delivery sub-score.
- `backend/verdict.py` *(new)* — fused readiness rubric (weights, bands, sub-score combination).
- [anthropic_coach.py](../../../backend/anthropic_coach.py) — add the content sub-score and the structured explanation output.

Dependencies: `numpy` is already installed; Deepgram is reached via `httpx` as today; `python-multipart` is already used by `/api/emotion`. No new heavy dependency is required for the recommended split.

## 8. Error Handling & Degradation

- **No mic / audio failed** → skip Delivery; reweight Presence/Content to fill 100%; report labels voice "not analyzed."
- **Deepgram pre-recorded fails** → partial Delivery from pitch/energy only (no pace/fillers); note the gap.
- **No `ANTHROPIC_API_KEY`** → skip Content; reweight; use a templated (non-LLM) explanation.
- **Empty/short transcript or no frames** → produce whatever sub-scores are available; never crash; the report shows which signals are missing.
- The verdict always states which signals contributed, so a reweighted score is never silently presented as a full one.

## 9. Privacy

- Today the app discards audio/video ("video stays on your device," nothing saved). Recording + uploading the candidate's audio is new.
- **Default:** the raw audio is uploaded only to derive metrics and is **deleted after analysis**; only the derived numbers persist (alongside the existing `transcript.txt`). The report states "audio analyzed, not stored."

## 10. Honesty Caveat

Because the verdict leans on facial signals (the chosen weighting), the results page shows a one-line caveat that facial-expression emotion inference is approximate and should be read as communication feedback, not a clinical or hiring judgment.

## 11. Build Order (for the implementation plan)

1. **Capture wiring** — buffer frames/transcript/actions in the new live screen, POST to the existing `/api/session`, navigate to the report. (Gets face + content working end-to-end with no new backend logic.)
2. **Voice** — record + upload audio; `voice.py` (Deepgram pre-recorded + prosody); Delivery sub-score.
3. **Verdict** — `verdict.py` fused rubric + Claude explanation; render on `report.js`.
4. **Progress linking + polish** — clickable progress entries; privacy delete; honesty caveat.

## 12. References

- molave-ai audio pipeline (reference for voice metrics & scoring): `src/lib/recordings/acousticFeatures.ts`, `voiceMetrics.ts`, `deepgramClient.ts`, `analysisPrompt.ts`; `src/lib/practice/weights.ts`.
- Current scoring & report: [analysis.py](../../../backend/analysis.py), [anthropic_coach.py](../../../backend/anthropic_coach.py), [report.js](../../../frontend/screens/report.js), [main.py](../../../backend/main.py).
- Live capture engine: [interview-engine.js](../../../frontend/interview-engine.js), [live.js](../../../frontend/screens/live.js).
