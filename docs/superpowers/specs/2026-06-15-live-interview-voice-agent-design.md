# Live interview — Deepgram voice agent + Claude interviewer

**Date:** 2026-06-15
**Status:** Approved design
**Builds on:** `2026-06-15-live-interview-mediapipe-design.md` (step 1, done)

## Goal

Add the AI interviewer to the `/live` screen: a Deepgram Voice Agent (nova-3 speech-to-text
+ aura-2 text-to-speech) with **Claude (`claude-sonnet-4-6`) as the interviewer brain**. The
interview must follow the settings chosen on the New-interview page (role, focus, difficulty,
question count). MediaPipe analysis keeps running at the same time, but its overlays are
hidden so the candidate sees a clean video.

This is step 2 of three. Step 3 (results page + saving the session) stays out of scope.

## What already exists

- [deepgram.py](../../../backend/deepgram.py) — `build_agent_config(role)` already wires
  Deepgram listen/think/speak with **Anthropic** as the `think` provider. The prompt only
  uses `role`.
- [deepgram-client.js](../../../frontend/deepgram-client.js) — `startVoiceAgent(...)`: a
  clean, reusable browser client (WS, mic PCM out, TTS playback, `onTranscript`). Reuse as-is.
- [main.py](../../../backend/main.py) `POST /api/interview/token` — mints an ephemeral
  Deepgram token and returns the agent config. Request body is `{role}` only.
- [new.js](../../../frontend/screens/new.js) — collects role/focus/difficulty/question count
  but **discards them**; Start just navigates to `#/live`.
- [interview-engine.js](../../../frontend/interview-engine.js) — opens **video-only** and
  draws all overlays; pins `turn = -1`.

## Out of scope

- No results page, no `POST /api/session`, no saving. Transcript + turns are kept in memory
  only, ready for step 3.
- No separate Anthropic API key: the Claude interviewer runs through Deepgram's managed
  Anthropic provider, so it needs a working `DEEPGRAM_API_KEY` with grant permission — same
  prerequisite as the old `app.js`.

## Design

### Settings flow (New interview → Claude prompt)

1. **`frontend/interview-config.js` (new)** — tiny shared store:
   `setInterviewConfig({ role, focus, difficulty, questionCount })` / `getInterviewConfig()`.
   No persistence; just module state passed between screens in one session.
2. **`new.js`** — on "Start interview", read from the DOM: selected role card's title text,
   the `.on` focus button, the `.on` difficulty button, and `#ni-qval`. Store via
   `setInterviewConfig(...)`, then navigate to `#/live`.
3. **`api.js`** — add `interviewToken(settings)` → `POST /api/interview/token`.
4. **`main.py`** — extend `TokenRequest` with `focus="Mixed"`, `difficulty="Realistic"`,
   `question_count=5` (all optional, so direct `/live` visits and old callers still work).
   Pass them to `build_agent_config(...)`.
5. **`deepgram.py`** — `build_interviewer_prompt(role, focus="Mixed", difficulty="Realistic",
   question_count=5)` and `build_agent_config(role, focus=..., difficulty=...,
   question_count=...)`. `role` stays the first positional arg; the rest are optional, so the
   existing single-arg tests keep passing. The prompt reflects:
   - **Focus** → question types: Behavioral (STAR-style situational), Technical
     (role-specific depth), Mixed (both).
   - **Difficulty** → question hardness + follow-up intensity: Warm-up (gentle, few follow-ups),
     Realistic (occasional probes), Hard (rigorous, pointed follow-ups).
   - **Tone** → interviewer *manner* (separate axis from Difficulty's question hardness):
     Friendly (warm, encouraging), Professional (calm, balanced — default), Stern (cool,
     no-nonsense), Intimidating (tough, high-pressure but never demeaning). Tone also selects
     the spoken Aura-2 voice — Friendly→helena, Professional→thalia (the default), Stern→saturn,
     Intimidating→zeus — falling back to thalia for unknown/missing tone. The interviewer
     persona is no longer given a fixed name, so any voice fits.
   - **Question count** → "Ask exactly N questions… once the candidate has answered all N,
     thank them and end." Greeting stays role-based.

### Voice agent in /live

6. **`interview-engine.js`** — additions, no behavior change to the analysis:
   - `start(canvas, { onStats, onAction, showOverlay = false, audio = true })`.
   - When `audio` is true, open `getUserMedia` with **video + audio** (the same audio
     constraints `app.js` used: 48k mono, echo cancel / noise suppress / auto gain).
   - `getStream()` — returns the active `MediaStream` so the screen can hand the mic to the
     voice agent.
   - `setTurn(n)` — sets the current question index used to tag action events (was hard-pinned
     to -1). Forward-looking for the report; cheap now.
   - `showOverlay = false` (default) — still run face/pose/hand/object **detection** every
     frame (needed for blendshapes, actions, stats), but **skip all draw calls** so only the
     raw video is shown. The candidate sees a clean, mirrored self-view.
7. **`live.js`** — orchestration:
   - Start the engine with `{ showOverlay: false, audio: true }`. If that rejects (mic or
     camera blocked), retry with `{ audio: false }`; on success show "Microphone unavailable —
     running analysis only" and skip the voice agent; only if that also fails show the camera
     error. This keeps analysis alive when only the mic is blocked.
   - Once running with audio, fetch the token via `api.interviewToken({ role, focus,
     difficulty, question_count })` and start `startVoiceAgent({ ...token, micStream:
     engine.getStream(), onTranscript, onError, onClose })`.
   - `onTranscript({ speaker, text })` → append a styled line to the **Conversation** panel;
     on an interviewer line, increment the turn and call `engine.setTurn(turn)` (matches the
     backend's `questions_from_transcript` indexing).
   - A **Voice** status line in the rail: Connecting / Live / Ended / Error / "analysis only".
   - **Teardown order:** Stop button and the navigate-away handler stop the **agent first**,
     then the engine (the engine owns and releases the mic/camera tracks).

### UI

8. Under the video stage, a `.live-cols` two-panel row: **Conversation** (`#lv-convo`,
   interviewer vs candidate lines) and **Live actions** (`#lv-feed`, the existing feed).
   Stacks vertically under 820px. New CSS: `.live-cols`, `.convo .line.interviewer/.candidate`.
   Rail gains the Voice stat line.

## Data flow

```
new.js settings ─> interview-config ─> live.js ─> api.interviewToken()
   ─> POST /api/interview/token ─> build_agent_config(role,focus,difficulty,count)
   ─> {url, token, scheme, config} ─> startVoiceAgent(config, micStream=engine.getStream())
       ├─ mic PCM ─> Deepgram (nova-3 STT ─> Claude think ─> aura-2 TTS) ─> TTS playback
       └─ ConversationText ─> onTranscript ─> Conversation panel + engine.setTurn()
engine: clean video on canvas + face/pose/hand/object detection ─> onStats (rail) / onAction (feed)
```

## Error handling

- **Token / WS failure** (missing or invalid Deepgram key, key lacks grant, network): show the
  error in the Voice status; MediaPipe analysis and the clean video keep running.
- **Mic blocked:** video+audio retry → video-only; "Microphone unavailable — analysis only";
  no voice agent started.
- **Camera blocked:** both attempts fail → show "Camera unavailable: <message>" in the stage,
  Start re-enables for retry.
- A single bad detection frame never kills the loop (existing try/catch).
- Navigating away mid-connect releases the stream (engine supersede guard) and stops the agent.

## Testing

- **Backend:** extend `tests/test_deepgram.py` — keep the existing single-arg calls (defaults);
  add tests that focus/difficulty/question-count wording appears in the prompt (e.g. "exactly
  8", a Hard-difficulty phrase, a Technical-focus phrase). Run `pytest tests/test_deepgram.py
  tests/test_main.py`.
- **Frontend:** `node --check` on changed JS; boot the backend and curl the new module graph
  (200s). The live voice loop itself is manual — it needs a mic and a real Deepgram key.

## Why this shape

- Reuses the proven `deepgram-client.js` + the existing think=Anthropic config, so the risky
  real-time audio path is unchanged; the new work is settings plumbing + UI.
- Keeping the engine the single owner of the camera/mic stream means one permission prompt and
  one teardown path; the screen just borrows the mic for the agent.
- `showOverlay`/`audio`/`setTurn` are small, isolated additions — the engine stays a focused
  capture unit and step 3 (report) can read its turns without more changes.
