# Web AI Voice-Interview with MediaPipe Facial Analysis — Design

**Date:** 2026-06-03
**Status:** Approved (pending spec review)

## 1. Purpose

A web app for **mock-interview practice**. The user has a live, spoken interview with an
AI interviewer in the browser. MediaPipe Face Landmarker runs on the webcam throughout the
session, capturing facial data. When the interview ends, the user receives a performance
**report**: per-question and overall facial metrics (eye contact, composure, positivity,
blink/nervousness) **plus AI coaching** from Claude on the interview transcript.

The interview mechanism is **ported** from the existing `ai-interview-v2` project
(Deepgram Voice Agent), re-implemented in a lightweight stack rather than copied wholesale.

## 2. Core decisions (from brainstorming)

| Decision | Choice |
|----------|--------|
| Platform / language | Web app; Python backend + vanilla-JS frontend |
| MediaPipe feature | Face Landmarker — blendshapes + facial transformation matrix |
| Where MediaPipe runs | **Browser** (MediaPipe Tasks for Web, JS/WASM) — hybrid architecture |
| Interview type | **Live spoken** AI interview (Deepgram Voice Agent), not scripted questions |
| Agent "brain" (LLM) | **Anthropic Claude** (Deepgram Voice Agent "think" provider) |
| End-of-session output | **Facial report + AI coaching** (Claude on transcript) |
| Report granularity | **Per-question + overall** (segmented by interviewer turns) |
| Metrics | Eye contact, composure/steadiness, positivity/warmth, blink/nervousness |
| UI | Web, 3 screens (Start → Interview → Results) |
| Stack reuse | **Port** Deepgram flow into our FastAPI + vanilla-JS stack (not adopt their Next/NestJS monorepo) |
| Deployment | **Local-first** dev; EC2 is a later, optional deploy target |

## 3. Architecture

```
Browser (client)                                  Local backend (FastAPI) — later: EC2
┌─────────────────────────────────┐               ┌────────────────────────────────┐
│ camera + mic (getUserMedia)      │  POST token   │ POST /api/interview/token        │
│ MediaPipe FaceLandmarker (JS)    │ ────────────▶ │   → mint Deepgram ephemeral tok  │
│   → per-frame blendshapes+matrix │ ◀──config──── │   → build agent config + prompt  │
│                                  │               │                                  │
│ WebSocket ───▶ Deepgram Voice Agent (direct, browser ↔ Deepgram)                    │
│   mic PCM out · TTS audio in · ConversationText JSON                                │
│                                  │  POST session │ POST /api/session                │
│ 3 screens, live transcript       │ ────────────▶ │   → compute facial metrics       │
│ on end: send frames + transcript │ ◀──report──── │   → Claude coaching              │
│ render report                    │               │   → charts (matplotlib) + save   │
└─────────────────────────────────┘               └────────────────────────────────┘
```

**Key property:** audio streams **browser ↔ Deepgram directly**. Our backend only mints a
short-lived token and computes the report, so it stays lightweight (no audio proxying).

## 4. Stack

- **Frontend:** plain HTML/CSS/JS, **no build step**. `@mediapipe/tasks-vision` from CDN;
  raw `WebSocket` for the Deepgram Voice Agent (audio pipeline ported from `ai-interview-v2`'s
  `InCall.tsx`).
- **Backend:** **FastAPI + uvicorn**. `anthropic` SDK (Claude coaching), `httpx` (Deepgram
  token grant), `matplotlib` (charts). Pure-Python analysis kept testable.
- **Storage:** flat files under `sessions/<timestamp>/`. No database.

## 5. Interview mechanics (ported from ai-interview-v2)

- Backend mints a Deepgram **ephemeral token** via `POST https://api.deepgram.com/v1/auth/grant`.
  The long-lived `DEEPGRAM_API_KEY` **never reaches the browser**.
- Browser opens `wss://agent.deepgram.com/v1/agent/converse` with `['token', <ephemeral>]`
  subprotocols, sends the agent **Settings** JSON, then streams mic audio.
- Agent config (adapted from their `agent-config.ts` / `interview-prompt.ts`):
  - **Listen:** Deepgram `nova-3` STT (en-US)
  - **Think:** Anthropic Claude (interviewer persona prompt + greeting; interview role/topic configurable)
  - **Speak:** Deepgram `aura-2` TTS
- Audio formats: input 48 kHz mono linear16 PCM (browser → Deepgram); output 24 kHz mono
  linear16 PCM (Deepgram → browser), played via `AudioContext`.
- Live transcript built from `ConversationText` messages (`role` = interviewer/candidate).
- **Per-question segmentation:** each **interviewer turn** starts a new segment; the
  candidate's facial frames (by timestamp) until the next interviewer turn belong to that
  segment.

> Implementation note: confirm the current Deepgram Voice Agent config schema and how the
> Anthropic "think" provider key is supplied (Deepgram BYO-key field vs Deepgram-managed)
> against live Deepgram docs during planning.

## 6. Data captured (browser → backend, per frame)

`timestamp`, `interviewerTurnIndex` (segment), selected blendshapes
(`mouthSmileLeft/Right`, `eyeBlinkLeft/Right`, `browInnerUp`), and the 16-float facial
transformation matrix. Head pose (pitch/yaw/roll) is decomposed **server-side**.

## 7. Metrics & report

Computed server-side, **per segment + overall**:

- **Eye contact** — % of frames with yaw & pitch within ±15° of center (looking at camera);
  no-face frames count against it.
- **Composure / steadiness** — variance / movement of head pose over time.
- **Positivity / warmth** — smile blendshapes over a threshold; % time + peak.
- **Blink / nervousness** — rising edges of eye-blink blendshapes → blink count → blinks/min.
- **AI coaching** — Claude analyzes the transcript and returns structured verbal feedback /
  scorecard (ported from their practice-coaching prompt).

Thresholds (±15°, smile 0.3, blink 0.5) are named constants for easy tuning.

**Saved to `sessions/<timestamp>/`:** `data.csv`, `data.json`, `summary.json`
(facial metrics + coaching), `transcript.txt`, `charts.png`.

## 8. UI — 3 screens

1. **Start** — title, brief instructions, interview role/topic selector, Start button.
2. **Interview** — webcam feed with mesh overlay (canvas) on the left; live transcript panel
   on the right; HUD strip (elapsed time · current question # · "face detected ✓/✗"); End button.
3. **Results** — overall metrics, per-question table, embedded timeline charts, AI coaching
   text, and the saved-data path. New-Session button.

> The implementation plan MUST direct the UI work through the **`frontend-design`** skill,
> and the Anthropic integration through the **`claude-api`** skill (prompt caching, model choice).

## 9. Code structure

```
backend/
  main.py            FastAPI app: routes, static serving, /api/interview/token, /api/session
  deepgram.py        ephemeral-token grant + agent-config builder + interviewer persona prompt
  anthropic_coach.py Claude coaching on transcript (prompt caching via claude-api skill)
  analysis.py        matrix_to_euler(), compute_metrics()   ← pure, unit-tested
  report.py          charts (matplotlib) + CSV/JSON writers
  requirements.txt
  .env.example
frontend/
  index.html         3 screens
  style.css
  app.js             camera+mic, MediaPipe, Deepgram WS, capture, screen logic, POST
  deepgram-client.js WebSocket audio in/out helpers (PCM encode/decode, playback scheduling)
  config.js          interview settings (role/topic, persona)
deploy/
  nginx.conf         TLS reverse-proxy sample (EC2 only)
  DEPLOY.md          EC2 setup steps
tests/
  test_analysis.py   matrix_to_euler (identity → 0,0,0); compute_metrics (synthetic frames)
sessions/            saved outputs (gitignored)
```

## 10. Running it

### Local development (primary)
- Create venv, `pip install -r backend/requirements.txt`.
- Put `DEEPGRAM_API_KEY` and `ANTHROPIC_API_KEY` in `.env`.
- Run `uvicorn` and open **`http://localhost:8000`**.
- `localhost` is a secure context, so camera **and** mic work over plain HTTP — **no TLS,
  no Nginx needed locally.**

### EC2 deployment (later / optional)
- Same code, hosted on Ubuntu EC2; uvicorn behind **Nginx** with **TLS** (self-signed OK for
  testing — browser shows a one-time warning; or Let's Encrypt with a domain).
- **HTTPS is required on EC2** because browsers need a secure context for camera + mic.
- Security group: open **443** (HTTPS) and **22** (SSH). Steps documented in `DEPLOY.md`.

## 11. Environment variables (`.env` — user provides)

| Variable | Purpose |
|----------|---------|
| `DEEPGRAM_API_KEY` | Server-side; mints ephemeral token + agent config. Never sent to browser. |
| `ANTHROPIC_API_KEY` | Claude: agent "think" provider + post-interview coaching. |
| `APP_SECRET` | *(optional)* only if we sign our own session tokens. |

## 12. Error handling

- Camera/mic permission denied or unavailable → clear message, block start.
- Missing API key → backend returns a clear error; frontend surfaces it.
- Deepgram WebSocket fails/closes early → end session gracefully, still produce a report from
  whatever was captured.
- No face in frame → recorded as a "no-face" frame, surfaced in the report.
- Empty session (no frames) → skip charts, show a notice.

## 13. Testing

- Unit tests for the pure functions in `analysis.py`:
  - `matrix_to_euler(identity)` → (0, 0, 0).
  - `compute_metrics(synthetic_frames)` → known stats.
- Manual end-to-end: run locally, complete a short interview, confirm transcript + report +
  saved files.

## 14. Out of scope (not in this build)

- The source project's auth, Postgres/Prisma, S3 video upload, Rekognition liveness, identity
  upload, accounts, multi-user.
- Multiple faces (`numFaces: 1`).
- Face *recognition* / identity matching (not a MediaPipe capability).
- AI question *generation* as a separate pre-step (the live Voice Agent already drives questions).
