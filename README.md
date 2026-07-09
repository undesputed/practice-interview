# molave.ai — AI Mock Interview Studio

A browser-based mock interview tool. You talk to an AI interviewer by voice while your
webcam runs in-browser computer vision. When the interview ends, the app builds a report
that scores how you came across — what you said, how you sounded, and how you presented
yourself on camera — and gives you coaching.

Nothing about the video stream leaves your machine as video: the camera is analyzed
locally in the browser with [MediaPipe](https://ai.google.dev/edge/mediapipe), and only
small numeric measurements (and, optionally, a few face crops for emotion) are sent to the
server.

---

## What it does

- **Live voice interview.** An AI interviewer asks questions out loud and listens to your
  answers in real time. This runs on the [Deepgram Voice Agent](https://developers.deepgram.com/docs/voice-agent),
  which uses Claude as the "think" model and Deepgram Aura for the voice.
- **Tailored questions.** You pick a role, focus (behavioral / technical / mixed),
  difficulty, question count, and tone. Claude generates a question set that drives the
  interview.
- **In-browser presence tracking.** MediaPipe measures your face, head pose, gaze, hands,
  posture, and objects in frame — turning them into metrics like eye contact, composure,
  nervousness, facial tension, posture, and fidgeting.
- **Voice delivery analysis.** After the interview, the recorded audio is scored for pace,
  pauses, and filler words (via a Deepgram pre-recorded pass) plus pitch/energy, producing
  a Delivery score.
- **Optional facial emotion.** When enabled, face crops are scored with HSEmotion
  (AffectNet, via ONNX Runtime) for a per-question emotion track.
- **Reaction effects (Face Analysis screen).** On the Face Analysis page, a toggle-on
  canvas overlay draws effects pinned to your face and following it in real time: tears
  under the eyes when you look sad, fire above your head when angry, question marks when
  confused, plus sparkles (happy), a surprise pop, and disgust/fear cues — one at a time,
  fading as your expression changes. Hand gestures add a labeled callout near your hand
  ("OK!" for 👍, "Nope" for 👎, and so on for ✌️ ✋ ✊ ☝️ 🤟). Two hands make combos — both 👍
  → "AWESOME!", 👍 + 👎 → "MIXED" — and the whole frame washes with the emotion's color (red
  when angry, gold when happy, blue when sad, …) as you emote. On by default; turn it off with
  the "Reaction effects" control in the left rail. Purely visual, computed in the browser —
  no network calls, and it changes no analysis or scoring.
- **Fused readiness verdict.** The report combines three signals — Delivery (voice),
  Presence (face/body), and Content (transcript, scored by Claude) — into one readiness
  score and band, with written coaching.
- **Saved history.** Every session is stored on disk with its metrics, charts, and
  transcript, and is browsable from the app.

---

## How it works

```
Browser (frontend/)                         Server (backend/, FastAPI)
─────────────────────                       ──────────────────────────
camera ──> MediaPipe (face/pose/hands)
mic ─────> Deepgram Voice Agent  <───────── /api/interview/token  (mints ephemeral token,
              (Claude think + Aura TTS)         builds the agent config from role/tone/etc.)

on "End":
  metrics + transcript + audio  ──POST──>   /api/session   ──> presence metrics  (analysis.py)
                                                            ──> voice delivery    (voice.py)
                                                            ──> emotion (opt-in)  (emotion.py)
                                                            ──> coaching + verdict (anthropic_coach.py)
                                                            ──> save report + charts (report.py)
                                            <── report JSON + chart URLs
```

The FastAPI server also serves the static frontend, so one process runs the whole app.

---

## Tech stack

| Layer      | Tech |
|------------|------|
| Backend    | Python 3.9+, [FastAPI](https://fastapi.tiangolo.com/), Uvicorn |
| Vision     | MediaPipe Tasks (loaded in the browser from a CDN) |
| Voice      | Deepgram Voice Agent (live) + Deepgram pre-recorded (delivery scoring) |
| LLM        | Anthropic Claude (interviewer "think" model, question generation, coaching, verdict) |
| Emotion    | HSEmotion / ONNX Runtime (optional, opt-in) |
| Charts     | matplotlib (headless) |
| Frontend   | Vanilla JavaScript ES modules — **no build step, no npm** |

---

## Project structure

```
backend/                  FastAPI app
  main.py                 routes; also serves the frontend
  analysis.py             presence metrics from MediaPipe frames
  deepgram.py             voice-agent config + ephemeral token grant + pre-recorded transcribe
  anthropic_coach.py      coaching + readiness explanation (Claude)
  questions.py            tailored question generation (Claude)
  emotion.py              HSEmotion/ONNX emotion scoring (optional)
  voice.py                prosody + Delivery score
  verdict.py              fuses Delivery + Presence + Content into a readiness score
  report.py               saves session JSON/CSV + renders charts
  sessions_store.py       list / load / delete / rename saved sessions
  requirements.txt        core dependencies
  requirements-emotion.txt  optional emotion dependencies
  .env.example            environment template

frontend/                 served as static files
  index.html  + main.js   the current "Clean Studio" SPA (shell + hash router + screens)
  screens/                dashboard, history, progress, new, live, report, facial, thanks
  legacy.html + app.js    the original single-page interview flow (kept for reference)
  config.js               MediaPipe model URLs and tuning constants
  styles/clean-studio.css the studio theme

deploy/
  DEPLOY.md               EC2 + nginx (self-signed TLS) guide
  ECS.md                  AWS ECS/ECR + ALB guide
  nginx.conf              reverse-proxy config for the EC2 path

docs/features/            metric definitions, scoring criteria, MediaPipe notes
tests/                    pytest suite (analysis, coaching, deepgram)
Dockerfile                container build (emotion stack optional via build arg)
sessions/                 saved interview reports (created at runtime)
```

> The app has two frontends. `index.html` → `main.js` is the active SPA. `legacy.html`
> → `app.js` is the earlier all-in-one interview screen, kept for reference.

---

## Prerequisites

- **Python 3.9 or newer.**
- A **Deepgram API key** with Voice Agent access. Two important details:
  - The key's project must have **Voice Agent managed-LLM (billing) access**, or the live
    interview's "think" step fails.
  - For a real deployment, the key must be able to **mint ephemeral tokens**
    (`/v1/auth/grant`). For local dev only, you can fall back to sending the key to the
    browser (see `DEEPGRAM_ALLOW_BROWSER_KEY` below).
- An **Anthropic API key** (used for the interviewer think model, question generation,
  coaching, and the verdict).
- A modern browser with camera + microphone permission.

---

## Setup and run (local)

```bash
# 1. Create a virtual environment and install dependencies
python3 -m venv .venv
source .venv/bin/activate            # Windows: . .venv/Scripts/activate
pip install -r backend/requirements.txt

# 2. Configure secrets
cp backend/.env.example backend/.env
# edit backend/.env and fill in DEEPGRAM_API_KEY and ANTHROPIC_API_KEY

# 3. Run the server (serves both the API and the frontend)
uvicorn backend.main:app --reload --port 8000
```

Open **http://localhost:8000** and start an interview.

> `localhost` is treated as a secure context, so the camera and microphone work over
> plain HTTP in local dev. Any **remote** host needs HTTPS — browsers block camera/mic
> over plain HTTP. See [deploy/DEPLOY.md](deploy/DEPLOY.md).

---

## Environment variables

Set these in `backend/.env` (template: [backend/.env.example](backend/.env.example)).

| Variable | Required | Purpose |
|----------|----------|---------|
| `DEEPGRAM_API_KEY` | Yes | Stays server-side; used to mint ephemeral tokens and run the pre-recorded voice pass. |
| `ANTHROPIC_API_KEY` | Yes | Interviewer think model, question generation, coaching, verdict. |
| `DEEPGRAM_ALLOW_BROWSER_KEY` | No | **Local dev only.** Set to `1` to send the long-lived key to the browser when your key can't mint ephemeral tokens. **Never set this on a deployed server** — it exposes the key. |
| `EMOTION_ANALYSIS` | No | Set to `1` to enable facial emotion scoring (requires the optional install below). |
| `HSEMOTION_MODEL` | No | Emotion model variant. Defaults to `enet_b2_8` (most accurate); use a lighter variant if scoring feels slow. |

Most features degrade gracefully: if a key is missing or a service is unavailable, that
part of the report is simply marked unavailable instead of failing the whole session.

---

## Optional: facial emotion analysis

Emotion analysis is **off by default**. It uses HSEmotion (AffectNet) via ONNX Runtime.
The model (~30 MB) downloads on first use.

```bash
pip install -r backend/requirements-emotion.txt   # hsemotion-onnx + opencv
```

Then add `EMOTION_ANALYSIS=1` to `backend/.env`. Face crops are scored in memory and are
**never written to disk**.

---

## API endpoints

All under the same server that hosts the frontend.

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/api/interview/token` | Mint a Deepgram token and build the voice-agent config from role/focus/difficulty/tone/questions. |
| `POST` | `/api/questions` | Generate a tailored question set (Claude). |
| `POST` | `/api/emotion` | Batch-score buffered face crops (opt-in). |
| `POST` | `/api/emotion/frame` | Score one face crop for the live Facial screen (opt-in). |
| `POST` | `/api/voice` | Score recorded audio for delivery (pace, pauses, fillers, pitch/energy). |
| `POST` | `/api/session` | Compute the full report from frames + transcript, save it, return metrics + chart URLs. |
| `GET` | `/api/sessions` | List saved sessions. |
| `GET` | `/api/sessions/{id}` | Load one saved session. |
| `DELETE` | `/api/sessions/{id}` | Delete a session. |
| `PATCH` | `/api/sessions/{id}` | Rename a session (set its label). |
| `GET` | `/sessions/...` | Static: saved report files and chart images. |
| `GET` | `/` | The frontend. |

---

## Tests

```bash
pytest
```

The suite lives in [tests/](tests/) (presence analysis, coaching, and Deepgram config).

---

## Deployment

The server speaks plain HTTP; TLS is terminated upstream (nginx or a load balancer)
because browsers require HTTPS for camera/mic on any remote host.

- **Docker** — see the [Dockerfile](Dockerfile). The emotion stack is excluded by default
  to keep the image small (~250 MB). To bake it in:
  ```bash
  docker build --build-arg INCLUDE_EMOTION=true -t interview .
  docker run -p 8000:8000 --env-file backend/.env interview
  ```
- **EC2 + nginx** — see [deploy/DEPLOY.md](deploy/DEPLOY.md).
- **AWS ECS + ECR (ALB for TLS)** — see [deploy/ECS.md](deploy/ECS.md).

> On a container/ECS deployment, `sessions/` is ephemeral. Mount persistent storage at
> `/app/sessions` if you need saved reports to survive restarts.

---

## Privacy

- The webcam video is analyzed **in the browser**. Only numeric metrics are sent to the
  server — never the video.
- When emotion analysis is enabled, a small number of face crops are sent for scoring;
  they are processed in memory and **not stored**.
- Recorded interview audio is sent once for delivery scoring and is **not stored**.
- Per-session metrics, charts, and transcripts are saved under `sessions/` on the server.
