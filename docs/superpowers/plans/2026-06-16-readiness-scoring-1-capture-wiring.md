# Readiness Scoring — Plan 1: Capture Wiring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the new live interview ends, capture frames + transcript + action events and POST them to the existing `POST /api/session`, then navigate to the existing results page — so a scored session/report is created from the new "Clean Studio" live flow.

**Architecture:** Reuse the existing backend scoring pipeline unchanged. Add buffering to [frontend/interview-engine.js](../../../frontend/interview-engine.js) (per-frame data) and [frontend/screens/live.js](../../../frontend/screens/live.js) (transcript + actions), an `api.createSession` helper, and a `finishInterview()` path that POSTs and routes to `#/session/{id}`. This mirrors the proven legacy flow in [frontend/app.js](../../../frontend/app.js).

**Tech Stack:** Vanilla ES modules (frontend, no JS test runner), FastAPI + pytest (backend), MediaPipe tasks-vision.

**This is Plan 1 of 4** (build order from the spec): **1 Capture wiring** → 2 Voice analysis → 3 Fused verdict → 4 Progress linking & polish. Each plan produces working, testable software on its own.

> **Note on the earlier camera fix:** A prior change gated pose + object detection on `showOverlay` (off during the live interview) to reduce lag. The report needs pose (posture), hands (fidget/face-touch), and objects (integrity) to compute the Presence signals. Task 3 re-enables that detection for data capture, but keeps it throttled (`POSE_THROTTLE_MS`) and on the GPU delegate, and keeps the duplicate-frame skip + 30fps cap — so the camera stays far smoother than the original (CPU, every-frame, 4-model) state. Only the *drawing* of pose/objects stays gated on `showOverlay`.

---

## File Structure

- **Modify** [frontend/api.js](../../../frontend/api.js) — add `createSession(payload)`.
- **Modify** [frontend/interview-engine.js](../../../frontend/interview-engine.js) — buffer per-frame data into `session.frames`; expose `getFrames()`; re-enable pose/objects detection for capture.
- **Modify** [frontend/screens/live.js](../../../frontend/screens/live.js) — buffer transcript segments + action events; add `finishInterview()`; wire the Stop button and natural agent-close to it; show a "processing…" state.
- **Create** `tests/test_session.py` — pytest contract test for `POST /api/session` that pins the exact frame/transcript/event shape the frontend must send.
- **Unchanged:** [backend/main.py](../../../backend/main.py) and all of `backend/` (reused as-is).

---

## Task 1: Backend contract test for `/api/session`

This test documents and guards the exact JSON shape the frontend must produce. It is the one piece of Phase 1 with an automated test harness (pytest), so we write it first.

**Files:**
- Create: `tests/test_session.py`

- [ ] **Step 1: Write the failing test**

```python
# tests/test_session.py
"""Contract test for POST /api/session.

Pins the frame / transcript / event shape the frontend (interview-engine.js +
live.js) must send. If this passes, the new live flow's payload will score.
"""
import shutil
import os

from fastapi.testclient import TestClient

from backend.main import app, SESSIONS_DIR
from backend import sessions_store

client = TestClient(app)

# The full blendshape set the frontend sends (mirrors frontend/config.js BLENDSHAPES).
BLENDSHAPES = [
    "mouthSmileLeft", "mouthSmileRight", "eyeBlinkLeft", "eyeBlinkRight", "browInnerUp",
    "eyeLookInLeft", "eyeLookInRight", "eyeLookOutLeft", "eyeLookOutRight",
    "eyeLookUpLeft", "eyeLookUpRight", "eyeLookDownLeft", "eyeLookDownRight",
    "jawOpen", "browOuterUpLeft", "browOuterUpRight",
    "eyeSquintLeft", "eyeSquintRight", "mouthPressLeft", "mouthPressRight",
    "browDownLeft", "browDownRight", "jawLeft", "jawRight",
    "noseSneerLeft", "noseSneerRight", "mouthFrownLeft", "mouthFrownRight",
    "cheekSquintLeft", "cheekSquintRight", "mouthUpperUpLeft", "mouthUpperUpRight",
    "eyeWideLeft", "eyeWideRight", "mouthStretchLeft", "mouthStretchRight",
]
IDENTITY_M = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]


def _bs(value=0.0):
    return {k: value for k in BLENDSHAPES}


def _make_payload():
    # Two questions' worth of frames; turn advances as the interviewer speaks.
    frames = []
    for i in range(60):
        turn = 0 if i < 30 else 1
        frame = {
            "t": float(i * 33),
            "turn": turn,
            "face": True,
            "face_count": 1,
            "bs": _bs(0.1),
            "m": IDENTITY_M,
        }
        # Heavy detectors attach only on "throttled" frames (every ~4th here).
        if i % 4 == 0:
            frame["pose"] = None
            frame["hands"] = None
            frame["objects"] = None
        frames.append(frame)

    segments = [
        {"speaker": "interviewer", "text": "Tell me about yourself.", "t": 0.0},
        {"speaker": "candidate", "text": "I am a software engineer with five years of experience.", "t": 2000.0},
        {"speaker": "interviewer", "text": "Describe a hard problem you solved.", "t": 10000.0},
        {"speaker": "candidate", "text": "I optimized a slow data pipeline and cut its runtime in half.", "t": 12000.0},
    ]
    full_text = "\n".join(
        ("INTERVIEWER: " if s["speaker"] == "interviewer" else "CANDIDATE: ") + s["text"]
        for s in segments
    )
    return {
        "role": "Software Engineer",
        "frames": frames,
        "transcript": {"full_text": full_text, "segments": segments},
        "events": [],
        "emotion": None,
    }


def test_session_creates_report_with_expected_shape():
    payload = _make_payload()
    res = client.post("/api/session", json=payload)
    assert res.status_code == 200, res.text
    body = res.json()
    session_id = body["session_id"]
    try:
        assert "summary" in body
        summary = body["summary"]
        for key in ("overall", "per_question", "timing", "integrity", "actions", "emotion_mediapipe"):
            assert key in summary, f"missing summary key: {key}"
        assert body["charts_url"].endswith("/charts.png")
    finally:
        sessions_store.delete_session(SESSIONS_DIR, session_id)


def test_session_rejects_empty_frames():
    payload = _make_payload()
    payload["frames"] = []
    res = client.post("/api/session", json=payload)
    assert res.status_code == 400
```

- [ ] **Step 2: Run the test to verify it passes (the endpoint already exists)**

Run: `cd /Users/carrieyu/Desktop/Hipe/mediapipe-test && python -m pytest tests/test_session.py -v`
Expected: both tests PASS. If `test_session_creates_report_with_expected_shape` fails with a `KeyError` or missing-summary-key error, the failure message names the exact field the real `compute_metrics`/`save_session` needs — adjust the payload builder to include it, then re-run. (This is the point of the test: discovering the real contract.)

> This test "passes on first write" because `/api/session` already exists — it is a *characterization* test that locks the contract the rest of Phase 1 depends on. Treat any failure as a discovery about the required shape, not a bug to implement.

- [ ] **Step 3: Commit**

```bash
git add tests/test_session.py
git commit -m "test(session): pin /api/session frame+transcript contract"
```

---

## Task 2: `api.createSession` helper

**Files:**
- Modify: [frontend/api.js](../../../frontend/api.js)

- [ ] **Step 1: Add the helper**

In [frontend/api.js](../../../frontend/api.js), inside the `export const api = { ... }` object, add a `createSession` entry next to `interviewToken` (after line 24):

```javascript
  // POST a finished interview (frames + transcript + events) and get back the
  // session id + scored summary. Phase 1 is JSON; audio is added in a later plan.
  createSession: (payload) => request('POST', '/api/session', payload),
```

- [ ] **Step 2: Verify it parses**

Run: `cd /Users/carrieyu/Desktop/Hipe/mediapipe-test && node --input-type=module --check < frontend/api.js && echo SYNTAX_OK`
Expected: `SYNTAX_OK`

- [ ] **Step 3: Commit**

```bash
git add frontend/api.js
git commit -m "feat(api): add createSession for posting a finished interview"
```

---

## Task 3: Buffer per-frame data in the engine

Mirror the legacy [app.js](../../../frontend/app.js) frame shape (`{t, turn, face, face_count, bs, m}` plus `pose`/`hands`/`objects` on throttled frames). Re-enable pose/objects detection for capture; keep drawing gated on `showOverlay`.

**Files:**
- Modify: [frontend/interview-engine.js](../../../frontend/interview-engine.js)

- [ ] **Step 1: Import the landmark pickers**

In [frontend/interview-engine.js](../../../frontend/interview-engine.js), add this import after the `createActionDetector` import (line 7):

```javascript
import { pickPose, pickHands, pickObjects } from './landmarks.js';
```

- [ ] **Step 2: Add the frame buffer to the session and expose a getter**

In the `session = { ... }` initializer (the object created in `launch`), add `frames: []` to the `lastBodyTs: 0, lastStatsTs: 0, lastVideoTime: -1,` line so it reads:

```javascript
    lastBodyTs: 0, lastStatsTs: 0, lastVideoTime: -1, frames: [],
```

Then add an exported getter next to `getStream` (after the `getStream` function, ~line 51):

```javascript
// The frames captured this run, for posting to /api/session. Call BEFORE stop()
// (stop() releases the session). Returns [] when nothing is running.
export function getFrames(){ return session ? session.frames : []; }
```

- [ ] **Step 3: Build and push a frame each unique frame**

Replace the throttled body-detection block (currently begins with the comment `// Hands/gestures feed the action detector...` and ends at the closing `}` before the overlay drawing) with a version that always detects, attaches picked data to a `frame`, draws only on overlay, and pushes the frame. The full replacement:

```javascript
    // Build the frame record this loop iteration (mirrors the legacy app.js shape
    // the backend /api/session expects). Heavy detectors attach on throttled frames.
    const tRel = now - session.startTs;
    const frame = { t: tRel, turn: session.turn, face: hasFace, face_count: faceCount, bs, m };

    // Pose + hands + objects: detect on a throttle for the report data (posture,
    // fidget, integrity). Cache the raw results so the overlay (when shown) draws
    // smoothly; the candidate's live view runs overlay-off, so nothing is drawn.
    if (now - session.lastBodyTs >= CONFIG.POSE_THROTTLE_MS){
      session.lastBodyTs = now;
      try {
        const pr = tasks.pose.detectForVideo(video, now);
        session.lastPose = pr.landmarks || null;
        frame.pose = pickPose(pr);
        const hr = tasks.gesture.recognizeForVideo(video, now);
        session.lastHand = (hr && hr.landmarks && hr.landmarks.length) ? hr : null;
        frame.hands = pickHands(hr);
        const orr = tasks.objects.detectForVideo(video, now);
        session.lastObjects = (orr && orr.detections && orr.detections.length) ? orr.detections : null;
        frame.objects = pickObjects(orr);
      } catch (e){ /* skip body detect on a bad frame */ }
    }
    session.frames.push(frame);
```

> The existing face block above this (which sets `bs`, `m`, `hasFace`, `faceCount`) is unchanged. The existing gesture-only block from the prior camera fix is fully replaced by the block above — gesture/hand detection is folded back in here.

- [ ] **Step 4: Confirm the action-detector block still has what it needs**

The action-detector block further down already uses `session.lastHand`, `bs`, `m`, `hasFace`, and computes `tRel` — but `tRel` is now declared earlier (Step 3). Find the later line `const tRel = now - session.startTs;` (inside the action block) and **delete that duplicate declaration line** so `tRel` is declared once. The `for (const ev of detector.feed({ t: tRel, ... }))` call stays unchanged.

- [ ] **Step 5: Verify it parses**

Run: `cd /Users/carrieyu/Desktop/Hipe/mediapipe-test && node --input-type=module --check < frontend/interview-engine.js && echo SYNTAX_OK`
Expected: `SYNTAX_OK`

- [ ] **Step 6: Commit**

```bash
git add frontend/interview-engine.js
git commit -m "feat(engine): buffer per-frame data and expose getFrames()"
```

---

## Task 4: Buffer transcript segments and action events in the live screen

**Files:**
- Modify: [frontend/screens/live.js](../../../frontend/screens/live.js)

- [ ] **Step 1: Add module-level buffers and a start timestamp**

Near the top of [frontend/screens/live.js](../../../frontend/screens/live.js), next to the existing `let agent = null;` / counters (after line 10), add:

```javascript
let segments = [];    // { speaker, text, t } transcript lines, in order
let events = [];      // action events (nods, smiles, gestures) from the engine
let startTs = 0;      // performance.now() at interview start, for segment timestamps
let finishing = false; // guard so Stop + agent-close don't double-submit
```

- [ ] **Step 2: Record each transcript line**

In `onTranscript`, after the existing `if (speaker === 'interviewer'){ turn += 1; engine.setTurn(turn); }` line, add:

```javascript
  segments.push({ speaker, text, t: performance.now() - startTs });
```

- [ ] **Step 3: Record each action event**

In `onAction`, after the existing `feedCount++;` line, add:

```javascript
  events.push(ev);
```

- [ ] **Step 4: Reset buffers when an interview starts**

In `startEngine`, change the reset line `feedCount = 0; convoCount = 0; turn = -1;` to also reset the new buffers and stamp the start time:

```javascript
  feedCount = 0; convoCount = 0; turn = -1;
  segments = []; events = []; startTs = performance.now(); finishing = false;
```

- [ ] **Step 5: Verify it parses**

Run: `cd /Users/carrieyu/Desktop/Hipe/mediapipe-test && node --input-type=module --check < frontend/screens/live.js && echo SYNTAX_OK`
Expected: `SYNTAX_OK`

- [ ] **Step 6: Commit**

```bash
git add frontend/screens/live.js
git commit -m "feat(live): buffer transcript segments and action events"
```

---

## Task 5: Finish the interview → POST → open the report

**Files:**
- Modify: [frontend/screens/live.js](../../../frontend/screens/live.js)

- [ ] **Step 1: Add `finishInterview()`**

Add this function in [frontend/screens/live.js](../../../frontend/screens/live.js) after `stopAgent()` (after line 84). It grabs frames BEFORE teardown, builds the payload, POSTs, and routes to the report:

```javascript
// End the interview, score it, and open its report. Grabs frames before teardown
// because engine.stop() releases the session. Idempotent via the `finishing` guard.
async function finishInterview(){
  if (finishing) return;
  finishing = true;
  const frames = engine.getFrames().slice();   // copy before stop() releases it
  stopAgent();
  engine.stop();
  setState('Processing…'); setVoice('Scoring your interview…');
  const live = document.getElementById('lv-live'); if (live) live.classList.remove('on');
  const stopBtn = document.getElementById('lv-stop'); if (stopBtn) stopBtn.style.display = 'none';

  if (!frames.length){
    // Nothing was captured (e.g. camera never started) — go back to a startable state.
    setState('Stopped'); setVoice('Nothing to score');
    const startBtn = document.getElementById('lv-start');
    if (startBtn){ startBtn.style.display = ''; startBtn.textContent = 'Start'; }
    return;
  }

  const full_text = segments
    .map((s) => (s.speaker === 'interviewer' ? 'INTERVIEWER: ' : 'CANDIDATE: ') + s.text)
    .join('\n');
  try {
    const resp = await api.createSession({
      role: getInterviewConfig().role,
      frames,
      transcript: { full_text, segments },
      events,
      emotion: null,
    });
    location.hash = '#/session/' + resp.session_id;   // open the existing report screen
  } catch (e){
    setState('Error'); setVoice('Could not score: ' + (e && e.message ? e.message : e));
    const startBtn = document.getElementById('lv-start');
    if (startBtn){ startBtn.style.display = ''; startBtn.textContent = 'Retry'; }
  }
}
```

- [ ] **Step 2: Point the Stop button at `finishInterview`**

In the `queueMicrotask` block at the bottom of `live()`, change the Stop button wiring from `stopEngine` to `finishInterview`:

```javascript
    if (stopBtn) stopBtn.addEventListener('click', finishInterview);
```

(Leave the Start button wired to `startEngine`.)

- [ ] **Step 3: Finish automatically when the agent ends the call**

In `startAgent`, change the `onClose` handler so a natural end also produces a report:

```javascript
      onClose: () => { if (engine.isRunning()) finishInterview(); },
```

- [ ] **Step 4: Keep navigate-away as teardown only (no report)**

Confirm the `hashchange` `leave` handler in `live()` still calls only `stopAgent(); engine.stop();` (no `finishInterview`). Leaving `/live` without pressing Stop should NOT create a session. No change needed if it already reads that way; do not add a finish call there.

- [ ] **Step 5: Verify it parses**

Run: `cd /Users/carrieyu/Desktop/Hipe/mediapipe-test && node --input-type=module --check < frontend/screens/live.js && echo SYNTAX_OK`
Expected: `SYNTAX_OK`

- [ ] **Step 6: Commit**

```bash
git add frontend/screens/live.js
git commit -m "feat(live): finish interview, post session, open report"
```

---

## Task 6: End-to-end manual verification

There is no JS test runner in this repo, so the full flow is verified by running the app. (The backend contract is already covered by Task 1.)

- [ ] **Step 1: Start the backend**

Run: `cd /Users/carrieyu/Desktop/Hipe/mediapipe-test && (cd backend && uvicorn main:app --reload --port 8000)` — or the project's documented run command if different (check [deploy/DEPLOY.md](../../../deploy/DEPLOY.md)). Ensure `DEEPGRAM_API_KEY` (and optionally `ANTHROPIC_API_KEY`) are set in the environment/.env.

- [ ] **Step 2: Run a short interview**

Open `http://localhost:8000`, go to **New interview**, start it, answer one or two questions out loud (camera + mic on), then press **Stop**.

Expected:
- The screen briefly shows "Processing…".
- The browser navigates to `#/session/<timestamp>` and the **results page renders** with the score cards (Attention/Confidence/Nervousness/Composure), the category cards, the per-question table, and — if `ANTHROPIC_API_KEY` is set — the coaching section.
- A new folder appears under `sessions/<timestamp>/` containing `summary.json`, `transcript.txt`, and `charts.png`.

- [ ] **Step 3: Confirm posture/integrity data is present (the camera-fix interaction)**

On the results page, confirm the **Posture** card shows non-empty upright/lean/steadiness values and the **Presence/Integrity** card shows a face-present percentage. (Empty/zero here means pose/objects detection didn't run — revisit Task 3.)

- [ ] **Step 4: Confirm the camera stayed smooth**

During the interview, confirm the FPS stat stayed near 30 and the video wasn't laggy, even though pose/objects detection is back on. (If it lags badly, note it — a later tuning step can lower `POSE_THROTTLE_MS` frequency, but it should be fine on the GPU delegate.)

- [ ] **Step 5: Confirm navigate-away does NOT create a session**

Start another interview, then click a different nav item (don't press Stop). Confirm **no** new `sessions/` folder is created.

---

## Self-Review

**Spec coverage (Plan 1 scope only — capture wiring):**
- Capture frames + transcript + actions on end → Tasks 3, 4, 5. ✓
- POST to existing `/api/session` and open the existing report → Tasks 2, 5; report reuse verified in Task 6. ✓
- Facial + FACS scoring works end-to-end → free from the existing backend once frames flow (emotion_from_blendshapes uses `frame.bs`); verified Task 6. ✓
- Content (Claude coaching) works → free from existing backend when `ANTHROPIC_API_KEY` set; verified Task 6. ✓
- Voice analysis, fused verdict, progress linking → **out of scope for Plan 1** (Plans 2–4).

**Placeholder scan:** No TBD/TODO; every code step shows complete code; commands have expected output. ✓

**Type/name consistency:** `getFrames()` (engine) used by `finishInterview` (live); `createSession(payload)` (api) called with `{role, frames, transcript:{full_text,segments}, events, emotion}` matching `SessionRequest` in [backend/main.py](../../../backend/main.py); `segments`/`events`/`startTs`/`finishing` declared in Task 4 and used in Task 5. ✓

---

## Execution Handoff

After Plan 1 is implemented and verified, the next plan (Plan 2: Voice analysis) will be written using the same structure.
