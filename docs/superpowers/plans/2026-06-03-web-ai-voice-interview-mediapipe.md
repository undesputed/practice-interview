# Web AI Voice-Interview with MediaPipe — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local-first web app where a user has a live spoken AI interview (Deepgram Voice Agent + Claude) while MediaPipe captures facial data, then receives a per-question + overall facial performance report plus Claude coaching.

**Architecture:** Browser runs MediaPipe Face Landmarker and a WebSocket to Deepgram (audio flows browser↔Deepgram directly). A FastAPI backend mints the Deepgram ephemeral token, and at session end computes facial metrics, generates Claude coaching, renders charts, and saves files. Audio never passes through our backend.

**Tech Stack:** Python 3.9, FastAPI + uvicorn, anthropic SDK, httpx, matplotlib, numpy, pytest; vanilla HTML/CSS/JS, `@mediapipe/tasks-vision` (CDN), raw WebSocket.

**Spec:** `docs/superpowers/specs/2026-06-03-web-ai-voice-interview-mediapipe-design.md`

**Reference source (read-only, for porting the Deepgram audio pipeline):**
`/Users/carrieyu/Desktop/Hipe/ai-interview-v2/apps/web/src/app/candidate-interview/[id]/_components/InCall.tsx`
and `/Users/carrieyu/Desktop/Hipe/ai-interview-v2/apps/api/src/lib/deepgram/agent-config.ts`

---

## Data Contracts (shared across tasks)

**Frame** (browser → backend, one per processed video frame):
```json
{
  "t": 1234.5,
  "turn": 2,
  "face": true,
  "bs": {
    "mouthSmileLeft": 0.10, "mouthSmileRight": 0.12,
    "eyeBlinkLeft": 0.02, "eyeBlinkRight": 0.03, "browInnerUp": 0.20
  },
  "m": [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]
}
```
- `t`: milliseconds since session start.
- `turn`: interviewer turn index (`-1` before the first interviewer line); used for per-question segmentation.
- `face`: whether a face was detected this frame.
- `bs`: selected blendshape scores (0–1).
- `m`: 16-float **row-major** 4×4 facial transformation matrix.

**Session POST body** (`POST /api/session`):
```json
{
  "role": "Software Engineer",
  "frames": [ /* Frame, ... */ ],
  "transcript": {
    "full_text": "INTERVIEWER: ...\nCANDIDATE: ...",
    "segments": [ {"speaker": "interviewer", "text": "...", "t": 100.0} ]
  }
}
```

**MetricBlock** (returned per-question and overall):
```json
{
  "eye_contact_pct": 72.5,
  "head_movement": 5.3,
  "steadiness_score": 84.0,
  "mean_smile": 0.22,
  "pct_smiling": 18.0,
  "peak_smile": 0.65,
  "blink_count": 14,
  "blinks_per_min": 12.0
}
```

**Session response** (`POST /api/session` returns):
```json
{
  "session_id": "2026-06-03T101500",
  "summary": { "duration_sec": 120.5, "frame_count": 2400, "no_face_pct": 3.2,
               "overall": { /* MetricBlock */ },
               "per_question": [ {"turn": 0, "question": "...", "metrics": { /* MetricBlock */ } } ] },
  "coaching": { "summary": "...", "strengths": ["..."], "improvements": ["..."],
                "score": 7, "rationale": "..." },
  "charts_url": "/sessions/2026-06-03T101500/charts.png"
}
```

---

# Phase 1 — Backend

## Task 1: Project scaffolding & dependencies

**Files:**
- Create: `backend/requirements.txt`
- Create: `backend/.env.example`
- Create: `backend/__init__.py` (empty)
- Create: `tests/__init__.py` (empty)
- Create: `pytest.ini`

- [ ] **Step 1: Create `backend/requirements.txt`**

```
fastapi==0.115.6
uvicorn[standard]==0.34.0
anthropic==0.42.0
httpx==0.28.1
matplotlib==3.9.4
numpy==2.0.2
python-dotenv==1.0.1
pytest==8.3.4
```

- [ ] **Step 2: Create `backend/.env.example`**

```
# Long-lived Deepgram key — stays server-side, used to mint ephemeral tokens.
DEEPGRAM_API_KEY=
# Anthropic key — used for the agent "think" provider and post-interview coaching.
ANTHROPIC_API_KEY=
```

- [ ] **Step 3: Create empty `backend/__init__.py` and `tests/__init__.py`**

Both files are empty (package markers).

- [ ] **Step 4: Create `pytest.ini`**

```ini
[pytest]
testpaths = tests
python_files = test_*.py
```

- [ ] **Step 5: Create the virtualenv and install**

Run:
```bash
python3 -m venv .venv && . .venv/bin/activate && pip install -r backend/requirements.txt
```
Expected: installs without error; `python -c "import fastapi, anthropic, httpx, matplotlib, numpy"` prints nothing (success).

- [ ] **Step 6: Commit**

```bash
git add backend/requirements.txt backend/.env.example backend/__init__.py tests/__init__.py pytest.ini
git commit -m "chore: backend scaffolding and dependencies"
```

---

## Task 2: `matrix_to_euler` (pure, TDD)

**Files:**
- Create: `backend/analysis.py`
- Test: `tests/test_analysis.py`

- [ ] **Step 1: Write the failing test**

```python
# tests/test_analysis.py
import math
from backend.analysis import matrix_to_euler

IDENTITY = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]

def test_identity_is_zero():
    pitch, yaw, roll = matrix_to_euler(IDENTITY)
    assert abs(pitch) < 1e-6
    assert abs(yaw) < 1e-6
    assert abs(roll) < 1e-6

def test_yaw_30_degrees():
    a = math.radians(30)
    c, s = math.cos(a), math.sin(a)
    # Row-major rotation about Y by +30°
    m = [ c, 0, s, 0,
          0, 1, 0, 0,
         -s, 0, c, 0,
          0, 0, 0, 1]
    pitch, yaw, roll = matrix_to_euler(m)
    assert abs(yaw - 30) < 1e-3
    assert abs(pitch) < 1e-3
    assert abs(roll) < 1e-3
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_analysis.py -v`
Expected: FAIL with `ModuleNotFoundError`/`ImportError` (no `matrix_to_euler`).

- [ ] **Step 3: Write minimal implementation**

```python
# backend/analysis.py
import math
from typing import Sequence

# --- Tunable thresholds ---
EYE_CONTACT_MAX_DEG = 15.0
SMILE_THRESHOLD = 0.3
BLINK_THRESHOLD = 0.5
STEADINESS_K = 4.0


def matrix_to_euler(m: Sequence[float]) -> tuple[float, float, float]:
    """Decompose a row-major 4x4 transform's rotation into (pitch, yaw, roll) degrees."""
    def R(i, j):  # row-major: element at row i, col j
        return m[i * 4 + j]
    pitch = math.atan2(R(2, 1), R(2, 2))
    yaw = math.atan2(-R(2, 0), math.sqrt(R(2, 1) ** 2 + R(2, 2) ** 2))
    roll = math.atan2(R(1, 0), R(0, 0))
    return math.degrees(pitch), math.degrees(yaw), math.degrees(roll)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_analysis.py -v`
Expected: PASS (2 passed).

- [ ] **Step 5: Commit**

```bash
git add backend/analysis.py tests/test_analysis.py
git commit -m "feat: matrix_to_euler head-pose decomposition"
```

---

## Task 3: `compute_metrics` — eye contact & no-face (TDD)

**Files:**
- Modify: `backend/analysis.py`
- Test: `tests/test_analysis.py`

- [ ] **Step 1: Write the failing test**

```python
# add to tests/test_analysis.py
from backend.analysis import compute_metrics

def _frame(t, turn=0, face=True, yaw_deg=0.0, smileL=0.0, smileR=0.0,
           blinkL=0.0, blinkR=0.0):
    import math
    a = math.radians(yaw_deg)
    c, s = math.cos(a), math.sin(a)
    m = [c,0,s,0, 0,1,0,0, -s,0,c,0, 0,0,0,1]
    return {"t": t, "turn": turn, "face": face,
            "bs": {"mouthSmileLeft": smileL, "mouthSmileRight": smileR,
                   "eyeBlinkLeft": blinkL, "eyeBlinkRight": blinkR, "browInnerUp": 0.0},
            "m": m}

def test_eye_contact_all_centered():
    frames = [_frame(t * 100.0, yaw_deg=0.0) for t in range(10)]
    out = compute_metrics(frames)
    assert out["overall"]["eye_contact_pct"] == 100.0
    assert out["no_face_pct"] == 0.0

def test_eye_contact_half_looking_away():
    frames = [_frame(t * 100.0, yaw_deg=0.0) for t in range(5)]
    frames += [_frame((t + 5) * 100.0, yaw_deg=40.0) for t in range(5)]
    out = compute_metrics(frames)
    assert out["overall"]["eye_contact_pct"] == 50.0

def test_no_face_counts_against_contact():
    frames = [_frame(t * 100.0, face=(t % 2 == 0)) for t in range(10)]
    out = compute_metrics(frames)
    assert out["no_face_pct"] == 50.0
    assert out["overall"]["eye_contact_pct"] == 50.0
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_analysis.py -k eye_contact or no_face -v`
Expected: FAIL with `ImportError` (no `compute_metrics`).

- [ ] **Step 3: Write minimal implementation**

```python
# add to backend/analysis.py

def _metric_block(frames: list[dict]) -> dict:
    """Compute a MetricBlock for a list of frames (any subset)."""
    total = len(frames)
    if total == 0:
        return {"eye_contact_pct": 0.0, "head_movement": 0.0, "steadiness_score": 0.0,
                "mean_smile": 0.0, "pct_smiling": 0.0, "peak_smile": 0.0,
                "blink_count": 0, "blinks_per_min": 0.0}

    poses, smiles, on_camera = [], [], 0
    for f in frames:
        if not f.get("face", False):
            continue
        pitch, yaw, roll = matrix_to_euler(f["m"])
        poses.append((pitch, yaw, roll))
        if abs(yaw) <= EYE_CONTACT_MAX_DEG and abs(pitch) <= EYE_CONTACT_MAX_DEG:
            on_camera += 1
        bs = f["bs"]
        smiles.append((bs.get("mouthSmileLeft", 0.0) + bs.get("mouthSmileRight", 0.0)) / 2.0)

    eye_contact_pct = round(100.0 * on_camera / total, 1)

    # head movement: mean per-frame absolute change across consecutive face poses
    movement = 0.0
    if len(poses) >= 2:
        deltas = []
        for (p0, y0, r0), (p1, y1, r1) in zip(poses, poses[1:]):
            deltas.append(abs(p1 - p0) + abs(y1 - y0) + abs(r1 - r0))
        movement = sum(deltas) / len(deltas)
    steadiness = max(0.0, min(100.0, 100.0 - STEADINESS_K * movement))

    mean_smile = round(sum(smiles) / len(smiles), 3) if smiles else 0.0
    pct_smiling = round(100.0 * sum(1 for s in smiles if s > SMILE_THRESHOLD) / total, 1)
    peak_smile = round(max(smiles), 3) if smiles else 0.0

    # blinks: rising edges of max(eyeBlinkLeft, eyeBlinkRight) crossing BLINK_THRESHOLD
    blink_count, prev_closed = 0, False
    for f in frames:
        bs = f["bs"]
        val = max(bs.get("eyeBlinkLeft", 0.0), bs.get("eyeBlinkRight", 0.0))
        closed = val >= BLINK_THRESHOLD
        if closed and not prev_closed:
            blink_count += 1
        prev_closed = closed

    duration_min = ((frames[-1]["t"] - frames[0]["t"]) / 1000.0 / 60.0) if total >= 2 else 0.0
    blinks_per_min = round(blink_count / duration_min, 1) if duration_min > 0 else 0.0

    return {"eye_contact_pct": eye_contact_pct, "head_movement": round(movement, 2),
            "steadiness_score": round(steadiness, 1), "mean_smile": mean_smile,
            "pct_smiling": pct_smiling, "peak_smile": peak_smile,
            "blink_count": blink_count, "blinks_per_min": blinks_per_min}


def compute_metrics(frames: list[dict], questions: dict | None = None) -> dict:
    """Compute overall + per-question metrics. `questions` maps turn index -> question text."""
    total = len(frames)
    no_face = sum(1 for f in frames if not f.get("face", False))
    no_face_pct = round(100.0 * no_face / total, 1) if total else 0.0
    duration_sec = round((frames[-1]["t"] - frames[0]["t"]) / 1000.0, 1) if total >= 2 else 0.0

    by_turn: dict[int, list[dict]] = {}
    for f in frames:
        by_turn.setdefault(f.get("turn", -1), []).append(f)

    per_question = []
    for turn in sorted(t for t in by_turn if t >= 0):
        per_question.append({
            "turn": turn,
            "question": (questions or {}).get(turn, f"Question {turn + 1}"),
            "metrics": _metric_block(by_turn[turn]),
        })

    return {"duration_sec": duration_sec, "frame_count": total,
            "no_face_pct": no_face_pct, "overall": _metric_block(frames),
            "per_question": per_question}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_analysis.py -v`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add backend/analysis.py tests/test_analysis.py
git commit -m "feat: compute_metrics eye-contact and no-face handling"
```

---

## Task 4: `compute_metrics` — smile, blink, per-question (TDD)

**Files:**
- Test: `tests/test_analysis.py` (no implementation change expected — verifies Task 3 code)

- [ ] **Step 1: Write the failing test**

```python
# add to tests/test_analysis.py

def test_positivity_smile():
    frames = [_frame(t * 100.0, smileL=0.6, smileR=0.6) for t in range(5)]
    frames += [_frame((t + 5) * 100.0, smileL=0.0, smileR=0.0) for t in range(5)]
    out = compute_metrics(frames)
    assert out["overall"]["pct_smiling"] == 50.0
    assert out["overall"]["peak_smile"] == 0.6
    assert abs(out["overall"]["mean_smile"] - 0.3) < 1e-6

def test_blink_count_rising_edges():
    # two distinct blinks: closed, open, closed
    seq = [0.0, 0.0, 0.8, 0.8, 0.0, 0.0, 0.9, 0.0]
    frames = [_frame(i * 100.0, blinkL=v, blinkR=v) for i, v in enumerate(seq)]
    out = compute_metrics(frames)
    assert out["overall"]["blink_count"] == 2

def test_per_question_segmentation():
    frames = [_frame(t * 100.0, turn=0) for t in range(5)]
    frames += [_frame((t + 5) * 100.0, turn=1, yaw_deg=40.0) for t in range(5)]
    out = compute_metrics(frames, questions={0: "Tell me about yourself", 1: "A challenge?"})
    assert len(out["per_question"]) == 2
    assert out["per_question"][0]["question"] == "Tell me about yourself"
    assert out["per_question"][0]["metrics"]["eye_contact_pct"] == 100.0
    assert out["per_question"][1]["metrics"]["eye_contact_pct"] == 0.0

def test_empty_frames_safe():
    out = compute_metrics([])
    assert out["frame_count"] == 0
    assert out["overall"]["eye_contact_pct"] == 0.0
    assert out["per_question"] == []
```

- [ ] **Step 2: Run the tests**

Run: `pytest tests/test_analysis.py -v`
Expected: PASS (all). If any fail, fix `_metric_block`/`compute_metrics` in `backend/analysis.py` until green.

- [ ] **Step 3: Commit**

```bash
git add tests/test_analysis.py
git commit -m "test: smile, blink, per-question and empty-frame coverage"
```

---

## Task 5: Report writers & charts

**Files:**
- Create: `backend/report.py`
- Test: `tests/test_report.py`

- [ ] **Step 1: Write the failing test**

```python
# tests/test_report.py
import json, math, os
from backend.report import save_session

def _frame(t, turn=0, smileL=0.2, yaw_deg=0.0):
    a = math.radians(yaw_deg); c, s = math.cos(a), math.sin(a)
    m = [c,0,s,0, 0,1,0,0, -s,0,c,0, 0,0,0,1]
    return {"t": t, "turn": turn, "face": True,
            "bs": {"mouthSmileLeft": smileL, "mouthSmileRight": smileL,
                   "eyeBlinkLeft": 0.0, "eyeBlinkRight": 0.0, "browInnerUp": 0.0},
            "m": m}

def test_save_session_writes_all_files(tmp_path):
    frames = [_frame(i * 100.0) for i in range(10)]
    summary = {"duration_sec": 1.0, "frame_count": 10, "no_face_pct": 0.0,
               "overall": {}, "per_question": []}
    coaching = {"summary": "good", "strengths": [], "improvements": [], "score": 7, "rationale": ""}
    transcript = {"full_text": "INTERVIEWER: hi\nCANDIDATE: hello", "segments": []}

    session_dir = str(tmp_path / "sess1")
    save_session(session_dir, frames, transcript, summary, coaching)

    for name in ("data.csv", "data.json", "summary.json", "transcript.txt", "charts.png"):
        assert os.path.exists(os.path.join(session_dir, name)), f"missing {name}"
    with open(os.path.join(session_dir, "summary.json")) as fh:
        assert json.load(fh)["frame_count"] == 10
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_report.py -v`
Expected: FAIL with `ImportError` (no `save_session`).

- [ ] **Step 3: Write minimal implementation**

```python
# backend/report.py
import csv, json, os
import matplotlib
matplotlib.use("Agg")  # headless backend — no display needed
import matplotlib.pyplot as plt
from backend.analysis import matrix_to_euler, SMILE_THRESHOLD


def _write_csv(path: str, frames: list[dict]) -> None:
    with open(path, "w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["t", "turn", "face", "pitch", "yaw", "roll",
                    "smileL", "smileR", "blinkL", "blinkR"])
        for f in frames:
            pitch, yaw, roll = matrix_to_euler(f["m"]) if f.get("face") else (0, 0, 0)
            bs = f["bs"]
            w.writerow([f["t"], f["turn"], int(f.get("face", False)),
                        round(pitch, 2), round(yaw, 2), round(roll, 2),
                        bs.get("mouthSmileLeft", 0), bs.get("mouthSmileRight", 0),
                        bs.get("eyeBlinkLeft", 0), bs.get("eyeBlinkRight", 0)])


def _build_charts(path: str, frames: list[dict]) -> None:
    ts = [f["t"] / 1000.0 for f in frames]
    smile, yaw_s, pitch_s = [], [], []
    for f in frames:
        bs = f["bs"]
        smile.append((bs.get("mouthSmileLeft", 0) + bs.get("mouthSmileRight", 0)) / 2.0)
        if f.get("face"):
            pitch, yaw, _ = matrix_to_euler(f["m"])
        else:
            pitch, yaw = 0.0, 0.0
        yaw_s.append(yaw); pitch_s.append(pitch)

    # vertical lines where the interviewer turn changes
    boundaries = [frames[i]["t"] / 1000.0 for i in range(1, len(frames))
                  if frames[i]["turn"] != frames[i - 1]["turn"]]

    fig, (ax1, ax2) = plt.subplots(2, 1, figsize=(10, 6), sharex=True)
    ax1.plot(ts, smile, label="smile")
    ax1.axhline(SMILE_THRESHOLD, ls="--", lw=0.8, color="gray")
    ax1.set_ylabel("smile"); ax1.legend(loc="upper right")
    ax2.plot(ts, yaw_s, label="yaw"); ax2.plot(ts, pitch_s, label="pitch")
    ax2.set_ylabel("degrees"); ax2.set_xlabel("seconds"); ax2.legend(loc="upper right")
    for b in boundaries:
        ax1.axvline(b, color="red", lw=0.6, alpha=0.5)
        ax2.axvline(b, color="red", lw=0.6, alpha=0.5)
    fig.suptitle("Interview facial timeline (red = new question)")
    fig.tight_layout()
    fig.savefig(path, dpi=100)
    plt.close(fig)


def save_session(session_dir: str, frames: list[dict], transcript: dict,
                 summary: dict, coaching: dict | None) -> None:
    os.makedirs(session_dir, exist_ok=True)
    _write_csv(os.path.join(session_dir, "data.csv"), frames)
    with open(os.path.join(session_dir, "data.json"), "w") as fh:
        json.dump(frames, fh)
    out = dict(summary)
    out["coaching"] = coaching
    with open(os.path.join(session_dir, "summary.json"), "w") as fh:
        json.dump(out, fh, indent=2)
    with open(os.path.join(session_dir, "transcript.txt"), "w") as fh:
        fh.write(transcript.get("full_text", ""))
    _build_charts(os.path.join(session_dir, "charts.png"), frames)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_report.py -v`
Expected: PASS (1 passed).

- [ ] **Step 5: Commit**

```bash
git add backend/report.py tests/test_report.py
git commit -m "feat: session report writers and matplotlib charts"
```

---

## Task 6: Deepgram token grant & agent config

**Files:**
- Create: `backend/deepgram.py`
- Test: `tests/test_deepgram.py`

> **Implementation note:** The Deepgram Voice Agent Settings schema (`agent.listen` / `agent.think` / `agent.speak`) and the way the Anthropic "think" key is supplied evolve over time. The config below mirrors `ai-interview-v2/apps/api/src/lib/deepgram/agent-config.ts`. During execution, verify the current schema at https://developers.deepgram.com/docs/voice-agent and adjust field names if Deepgram returns a settings error on the WebSocket. Keep `build_agent_config` / `build_greeting` as the single place these live.

- [ ] **Step 1: Write the failing test**

```python
# tests/test_deepgram.py
from backend.deepgram import build_agent_config, build_greeting

def test_agent_config_has_required_sections():
    cfg = build_agent_config("Software Engineer")
    assert cfg["type"] == "Settings"
    assert cfg["agent"]["listen"]["provider"]["model"] == "nova-3"
    assert cfg["agent"]["think"]["provider"]["type"] == "anthropic"
    assert cfg["agent"]["speak"]["provider"]["model"].startswith("aura-2")
    # the role must appear in the interviewer system prompt
    assert "Software Engineer" in cfg["agent"]["think"]["prompt"]

def test_greeting_mentions_interview():
    assert "interview" in build_greeting("Software Engineer").lower()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_deepgram.py -v`
Expected: FAIL with `ImportError`.

- [ ] **Step 3: Write minimal implementation**

```python
# backend/deepgram.py
import httpx

DEEPGRAM_AGENT_URL = "wss://agent.deepgram.com/v1/agent/converse"
THINK_MODEL = "claude-sonnet-4-6"
TTS_MODEL = "aura-2-thalia-en"


def build_interviewer_prompt(role: str) -> str:
    return (
        f"You are Judy, a warm but professional interviewer conducting a mock job "
        f"interview for a {role} position. Ask one question at a time. Start with an "
        f"easy warm-up, then progressively ask behavioral and role-relevant questions. "
        f"Keep your turns short (1-3 sentences). Listen to the candidate's full answer "
        f"before asking the next question. Do not give feedback during the interview; "
        f"just conduct it naturally. After about 5 questions, thank them and end."
    )


def build_greeting(role: str) -> str:
    return (f"Hi, thanks for joining. I'll be interviewing you for the {role} role today. "
            f"Whenever you're ready, tell me a little about yourself.")


def build_agent_config(role: str) -> dict:
    """Deepgram Voice Agent Settings payload (sent as first WS message)."""
    return {
        "type": "Settings",
        "audio": {
            "input": {"encoding": "linear16", "sample_rate": 48000},
            "output": {"encoding": "linear16", "sample_rate": 24000, "container": "none"},
        },
        "agent": {
            "language": "en",
            "listen": {"provider": {"type": "deepgram", "model": "nova-3"}},
            "think": {
                "provider": {"type": "anthropic", "model": THINK_MODEL},
                "prompt": build_interviewer_prompt(role),
            },
            "speak": {"provider": {"type": "deepgram", "model": TTS_MODEL}},
            "greeting": build_greeting(role),
        },
    }


async def grant_ephemeral_token(api_key: str, ttl_seconds: int = 300) -> str:
    """Mint a short-lived Deepgram token; the long-lived key never leaves the server."""
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.post(
            "https://api.deepgram.com/v1/auth/grant",
            headers={"Authorization": f"Token {api_key}"},
            json={"ttl_seconds": ttl_seconds},
        )
        resp.raise_for_status()
        return resp.json()["access_token"]
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_deepgram.py -v`
Expected: PASS (2 passed). (`grant_ephemeral_token` is exercised live in Task 9, not unit-tested.)

- [ ] **Step 5: Commit**

```bash
git add backend/deepgram.py tests/test_deepgram.py
git commit -m "feat: deepgram ephemeral token grant and agent config"
```

---

## Task 7: Anthropic coaching

**Files:**
- Create: `backend/anthropic_coach.py`
- Test: `tests/test_coach.py`

> **REQUIRED SUB-SKILL:** Invoke the **`claude-api`** skill before writing this file — it ensures prompt caching is applied and the current model id / SDK usage is correct.

- [ ] **Step 1: Write the failing test** (parsing logic only — no network)

```python
# tests/test_coach.py
from backend.anthropic_coach import parse_coaching

def test_parse_coaching_valid_json():
    raw = ('{"summary":"Solid answers.","strengths":["clear"],'
           '"improvements":["more detail"],"score":7,"rationale":"good structure"}')
    out = parse_coaching(raw)
    assert out["score"] == 7
    assert out["strengths"] == ["clear"]

def test_parse_coaching_handles_fenced_json():
    raw = "```json\n{\"summary\":\"x\",\"strengths\":[],\"improvements\":[],\"score\":5,\"rationale\":\"y\"}\n```"
    out = parse_coaching(raw)
    assert out["score"] == 5

def test_parse_coaching_bad_input_returns_fallback():
    out = parse_coaching("not json at all")
    assert out["score"] is None
    assert "summary" in out
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_coach.py -v`
Expected: FAIL with `ImportError`.

- [ ] **Step 3: Write minimal implementation**

```python
# backend/anthropic_coach.py
import json, re
from anthropic import Anthropic

COACH_MODEL = "claude-sonnet-4-6"

SYSTEM_PROMPT = (
    "You are an expert interview coach. Given an interview transcript, return ONLY a JSON "
    "object with keys: summary (string), strengths (string[]), improvements (string[]), "
    "score (integer 1-10), rationale (string). No prose outside the JSON."
)


def parse_coaching(raw: str) -> dict:
    """Extract the coaching JSON from the model response, tolerating code fences."""
    text = raw.strip()
    fenced = re.search(r"```(?:json)?\s*(\{.*\})\s*```", text, re.DOTALL)
    if fenced:
        text = fenced.group(1)
    else:
        brace = re.search(r"\{.*\}", text, re.DOTALL)
        if brace:
            text = brace.group(0)
    try:
        data = json.loads(text)
        return {"summary": data.get("summary", ""),
                "strengths": data.get("strengths", []),
                "improvements": data.get("improvements", []),
                "score": data.get("score"),
                "rationale": data.get("rationale", "")}
    except (ValueError, AttributeError):
        return {"summary": "Coaching unavailable (could not parse model output).",
                "strengths": [], "improvements": [], "score": None, "rationale": ""}


def generate_coaching(api_key: str, transcript_text: str, role: str) -> dict:
    """Call Claude to produce structured interview coaching. Prompt caching on the system block."""
    client = Anthropic(api_key=api_key)
    resp = client.messages.create(
        model=COACH_MODEL,
        max_tokens=1024,
        system=[{"type": "text", "text": SYSTEM_PROMPT,
                 "cache_control": {"type": "ephemeral"}}],
        messages=[{"role": "user",
                   "content": f"Role: {role}\n\nTranscript:\n{transcript_text}"}],
    )
    return parse_coaching(resp.content[0].text)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_coach.py -v`
Expected: PASS (3 passed).

- [ ] **Step 5: Commit**

```bash
git add backend/anthropic_coach.py tests/test_coach.py
git commit -m "feat: claude interview coaching with caching and robust parsing"
```

---

## Task 8: Question extraction from transcript (TDD)

**Files:**
- Modify: `backend/analysis.py`
- Test: `tests/test_analysis.py`

- [ ] **Step 1: Write the failing test**

```python
# add to tests/test_analysis.py
from backend.analysis import questions_from_transcript

def test_questions_from_transcript_maps_interviewer_turns():
    segments = [
        {"speaker": "interviewer", "text": "Tell me about yourself.", "t": 0},
        {"speaker": "candidate", "text": "Sure, I ...", "t": 5000},
        {"speaker": "interviewer", "text": "Describe a challenge.", "t": 20000},
        {"speaker": "candidate", "text": "Once ...", "t": 25000},
    ]
    q = questions_from_transcript(segments)
    assert q == {0: "Tell me about yourself.", 1: "Describe a challenge."}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_analysis.py -k questions_from_transcript -v`
Expected: FAIL with `ImportError`.

- [ ] **Step 3: Write minimal implementation**

```python
# add to backend/analysis.py

def questions_from_transcript(segments: list[dict]) -> dict:
    """Map interviewer turn index -> question text, in order of appearance."""
    questions: dict[int, str] = {}
    idx = 0
    for seg in segments:
        if seg.get("speaker") == "interviewer":
            questions[idx] = seg.get("text", "")
            idx += 1
    return questions
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_analysis.py -k questions_from_transcript -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/analysis.py tests/test_analysis.py
git commit -m "feat: map interviewer turns to question text"
```

> **Frame/turn alignment note for the frontend:** `turn` on each Frame must use the SAME indexing as `questions_from_transcript` — i.e., the Nth interviewer line (0-based) corresponds to `turn == N`. The frontend increments a counter each time it receives an interviewer `ConversationText` message and tags subsequent frames with that counter (starting at `-1` before the first interviewer line).

---

## Task 9: FastAPI app wiring

**Files:**
- Create: `backend/main.py`
- Test: `tests/test_main.py`

- [ ] **Step 1: Write the failing test**

```python
# tests/test_main.py
import math
from fastapi.testclient import TestClient
from backend.main import app

client = TestClient(app)

def _frame(t, turn=0):
    m = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]
    return {"t": t, "turn": turn, "face": True,
            "bs": {"mouthSmileLeft": 0.1, "mouthSmileRight": 0.1,
                   "eyeBlinkLeft": 0.0, "eyeBlinkRight": 0.0, "browInnerUp": 0.0},
            "m": m}

def test_session_endpoint_returns_summary(monkeypatch):
    # avoid a real Anthropic call
    import backend.main as main
    monkeypatch.setattr(main, "generate_coaching",
                        lambda *a, **k: {"summary": "ok", "strengths": [], "improvements": [],
                                         "score": 8, "rationale": ""})
    body = {"role": "Software Engineer",
            "frames": [_frame(i * 100.0) for i in range(10)],
            "transcript": {"full_text": "INTERVIEWER: hi", "segments": [
                {"speaker": "interviewer", "text": "hi", "t": 0}]}}
    resp = client.post("/api/session", json=body)
    assert resp.status_code == 200
    data = resp.json()
    assert data["summary"]["frame_count"] == 10
    assert data["coaching"]["score"] == 8
    assert data["charts_url"].endswith("charts.png")

def test_session_empty_frames_returns_422_or_message():
    body = {"role": "X", "frames": [], "transcript": {"full_text": "", "segments": []}}
    resp = client.post("/api/session", json=body)
    assert resp.status_code == 400
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_main.py -v`
Expected: FAIL with `ImportError` (no `backend.main`).

- [ ] **Step 3: Write minimal implementation**

```python
# backend/main.py
import os
from datetime import datetime
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from backend.analysis import compute_metrics, questions_from_transcript
from backend.report import save_session
from backend.deepgram import build_agent_config, grant_ephemeral_token, DEEPGRAM_AGENT_URL
from backend.anthropic_coach import generate_coaching

load_dotenv()

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SESSIONS_DIR = os.path.join(ROOT, "sessions")
FRONTEND_DIR = os.path.join(ROOT, "frontend")
os.makedirs(SESSIONS_DIR, exist_ok=True)

app = FastAPI()


class TokenRequest(BaseModel):
    role: str = "Software Engineer"


class SessionRequest(BaseModel):
    role: str = "Software Engineer"
    frames: list[dict]
    transcript: dict


@app.post("/api/interview/token")
async def interview_token(req: TokenRequest):
    api_key = os.getenv("DEEPGRAM_API_KEY")
    if not api_key:
        raise HTTPException(500, "DEEPGRAM_API_KEY is not set")
    token = await grant_ephemeral_token(api_key)
    return {"url": DEEPGRAM_AGENT_URL, "token": token,
            "config": build_agent_config(req.role)}


@app.post("/api/session")
def session(req: SessionRequest):
    if not req.frames:
        raise HTTPException(400, "no frames captured")
    questions = questions_from_transcript(req.transcript.get("segments", []))
    summary = compute_metrics(req.frames, questions)

    coaching = None
    anthropic_key = os.getenv("ANTHROPIC_API_KEY")
    full_text = req.transcript.get("full_text", "")
    if anthropic_key and full_text.strip():
        coaching = generate_coaching(anthropic_key, full_text, req.role)

    session_id = datetime.now().strftime("%Y-%m-%dT%H%M%S")
    save_session(os.path.join(SESSIONS_DIR, session_id),
                 req.frames, req.transcript, summary, coaching)

    return {"session_id": session_id, "summary": summary, "coaching": coaching,
            "charts_url": f"/sessions/{session_id}/charts.png"}


# static mounts last so /api routes win
app.mount("/sessions", StaticFiles(directory=SESSIONS_DIR), name="sessions")


@app.get("/")
def index():
    return FileResponse(os.path.join(FRONTEND_DIR, "index.html"))


if os.path.isdir(FRONTEND_DIR):
    app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_main.py -v`
Expected: PASS (2 passed). Note: the `/` mount requires `frontend/` to exist; the test client only hits `/api/session`, so this is fine. If the mount raises because `frontend/` is missing, create an empty `frontend/` dir: `mkdir -p frontend`.

- [ ] **Step 5: Run the full backend suite**

Run: `pytest -v`
Expected: PASS (all tests across all files).

- [ ] **Step 6: Commit**

```bash
git add backend/main.py tests/test_main.py
git commit -m "feat: FastAPI app — token mint and session report endpoints"
```

---

## Task 10: Manual backend smoke test

**Files:** none (verification only)

- [ ] **Step 1: Start the server**

Run: `. .venv/bin/activate && uvicorn backend.main:app --reload --port 8000`
Expected: `Uvicorn running on http://127.0.0.1:8000`.

- [ ] **Step 2: Token endpoint (requires real `DEEPGRAM_API_KEY` in `.env`)**

Run:
```bash
curl -s -X POST localhost:8000/api/interview/token -H 'content-type: application/json' -d '{"role":"Software Engineer"}' | head -c 300
```
Expected: JSON containing `"url": "wss://agent.deepgram.com/v1/agent/converse"`, a `token`, and a `config` object. If `DEEPGRAM_API_KEY` is unset, expect a 500 with the clear message.

- [ ] **Step 3: Session endpoint with a tiny synthetic payload**

Run:
```bash
curl -s -X POST localhost:8000/api/session -H 'content-type: application/json' \
  -d '{"role":"X","frames":[{"t":0,"turn":0,"face":true,"bs":{"mouthSmileLeft":0.1,"mouthSmileRight":0.1,"eyeBlinkLeft":0,"eyeBlinkRight":0,"browInnerUp":0},"m":[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]}],"transcript":{"full_text":"","segments":[]}}' | head -c 300
```
Expected: JSON with `summary.frame_count == 1` and a `charts_url`. Confirm `sessions/<id>/charts.png` was written.

- [ ] **Step 4: Commit (nothing to commit — note completion in the task tracker)**

---

# Phase 2 — Frontend

> **REQUIRED SUB-SKILL:** Invoke the **`frontend-design`** skill before building the UI in Tasks 12–13. It governs the visual design, layout, and styling of the three screens. This plan specifies the *contracts and behavior*; `frontend-design` owns the *look*.
>
> **Porting source:** the audio pipeline (mic capture → PCM → WebSocket; TTS playback) should be ported from
> `/Users/carrieyu/Desktop/Hipe/ai-interview-v2/apps/web/src/app/candidate-interview/[id]/_components/InCall.tsx`.
> Read it for the exact `ScriptProcessorNode` float32→int16 conversion and the 24 kHz playback scheduling, then adapt to vanilla JS.

## Task 11: Frontend config & static shell

**Files:**
- Create: `frontend/config.js`

- [ ] **Step 1: Create `frontend/config.js`**

```javascript
// frontend/config.js
export const CONFIG = {
  // MediaPipe Face Landmarker assets (pin a version that matches the CDN import in app.js)
  WASM_BASE: "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm",
  MODEL_URL: "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
  // Blendshapes we forward to the backend (keep small)
  BLENDSHAPES: ["mouthSmileLeft", "mouthSmileRight", "eyeBlinkLeft", "eyeBlinkRight", "browInnerUp"],
  ROLES: ["Software Engineer", "Product Manager", "Data Analyst", "Customer Support"],
};
```

- [ ] **Step 2: Commit**

```bash
git add frontend/config.js
git commit -m "feat: frontend runtime config"
```

---

## Task 12: Deepgram WebSocket client (ported audio pipeline)

**Files:**
- Create: `frontend/deepgram-client.js`

This module is behavior-critical and is fully specified here (it is not a design concern).

- [ ] **Step 1: Create `frontend/deepgram-client.js`**

```javascript
// frontend/deepgram-client.js
// Live voice-agent client. Ported from ai-interview-v2 InCall.tsx audio pipeline.
export function startVoiceAgent({ url, token, config, micStream, onTranscript, onClose }) {
  const ws = new WebSocket(url, ["token", token]);
  ws.binaryType = "arraybuffer";

  const inCtx = new AudioContext({ sampleRate: 48000 });
  const outCtx = new AudioContext({ sampleRate: 24000 });
  let nextStart = 0;
  let processor = null;
  let source = null;

  ws.onopen = () => {
    ws.send(JSON.stringify(config)); // Settings first

    source = inCtx.createMediaStreamSource(micStream);
    processor = inCtx.createScriptProcessor(4096, 1, 1);
    processor.onaudioprocess = (e) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      const input = e.inputBuffer.getChannelData(0);
      const int16 = new Int16Array(input.length);
      for (let i = 0; i < input.length; i++) {
        const s = Math.max(-1, Math.min(1, input[i]));
        int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      ws.send(int16.buffer);
    };
    source.connect(processor);
    processor.connect(inCtx.destination);
  };

  ws.onmessage = (event) => {
    if (event.data instanceof ArrayBuffer) {
      // binary = TTS audio (24kHz int16 mono)
      const int16 = new Int16Array(event.data);
      const f32 = new Float32Array(int16.length);
      for (let i = 0; i < int16.length; i++) f32[i] = int16[i] / 32768;
      const buf = outCtx.createBuffer(1, f32.length, 24000);
      buf.getChannelData(0).set(f32);
      const src = outCtx.createBufferSource();
      src.buffer = buf;
      src.connect(outCtx.destination);
      const now = outCtx.currentTime;
      const start = Math.max(now, nextStart);
      src.start(start);
      nextStart = start + buf.duration;
    } else {
      const msg = JSON.parse(event.data);
      if (msg.type === "ConversationText") {
        onTranscript({
          speaker: msg.role === "assistant" ? "interviewer" : "candidate",
          text: msg.content,
        });
      }
    }
  };

  ws.onclose = () => { if (onClose) onClose(); };
  ws.onerror = () => { if (onClose) onClose(); };

  return {
    stop() {
      try { if (processor) processor.disconnect(); } catch (_) {}
      try { if (source) source.disconnect(); } catch (_) {}
      try { inCtx.close(); } catch (_) {}
      try { outCtx.close(); } catch (_) {}
      if (ws.readyState === WebSocket.OPEN) ws.close();
    },
  };
}
```

- [ ] **Step 2: Commit**

```bash
git add frontend/deepgram-client.js
git commit -m "feat: deepgram voice-agent websocket client (ported audio pipeline)"
```

---

## Task 13: App orchestration, MediaPipe capture & 3 screens

**Files:**
- Create: `frontend/app.js`
- Create: `frontend/index.html` (structure; **styling via `frontend-design` skill**)
- Create: `frontend/style.css` (**authored by `frontend-design` skill**)

> Invoke **`frontend-design`** to produce `index.html` + `style.css` for the three screens. Give it these required element IDs/behaviors so `app.js` can bind to them. `app.js` logic below is the contract.

**Required DOM contract** (frontend-design must include these IDs):
- Screen containers: `#screen-start`, `#screen-interview`, `#screen-results` (show one at a time).
- Start: `#role-select` (a `<select>`), `#start-btn`.
- Interview: `#cam` (`<video>` or `<canvas>` for mesh overlay), `#transcript` (scrolling list), `#hud-time`, `#hud-question`, `#hud-face`, `#end-btn`.
- Results: `#metrics-overall`, `#metrics-per-question`, `#chart-img` (`<img>`), `#coaching`, `#newsession-btn`.

- [ ] **Step 1: Create `frontend/app.js`**

```javascript
// frontend/app.js
import { CONFIG } from "./config.js";
import { startVoiceAgent } from "./deepgram-client.js";
import { FaceLandmarker, FilesetResolver, DrawingUtils }
  from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35";

let landmarker = null;
let frames = [];
let segments = [];
let turnIndex = -1;       // -1 until the first interviewer line
let sessionStart = 0;
let agent = null;
let mediaStream = null;
let running = false;
let role = CONFIG.ROLES[0];

const $ = (id) => document.getElementById(id);
function show(screen) {
  for (const s of ["screen-start", "screen-interview", "screen-results"])
    $(s).style.display = (s === screen) ? "" : "none";
}

async function initLandmarker() {
  const fileset = await FilesetResolver.forVisionTasks(CONFIG.WASM_BASE);
  landmarker = await FaceLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: CONFIG.MODEL_URL },
    runningMode: "VIDEO",
    numFaces: 1,
    outputFaceBlendshapes: true,
    outputFacialTransformationMatrixes: true,
  });
}

function pickBlendshapes(categories) {
  const out = {};
  for (const k of CONFIG.BLENDSHAPES) out[k] = 0;
  if (categories) for (const c of categories)
    if (CONFIG.BLENDSHAPES.includes(c.categoryName)) out[c.categoryName] = c.score;
  return out;
}

function renderLoop(video, canvas, ctx, draw) {
  if (!running) return;
  const now = performance.now();
  const result = landmarker.detectForVideo(video, now);
  const hasFace = result.faceLandmarks && result.faceLandmarks.length > 0;

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  if (hasFace) {
    draw.drawConnectors(result.faceLandmarks[0],
      FaceLandmarker.FACE_LANDMARKS_TESSELATION, { color: "#30FF9080", lineWidth: 0.5 });
  }

  const bs = pickBlendshapes(hasFace ? result.faceBlendshapes?.[0]?.categories : null);
  const m = hasFace && result.facialTransformationMatrixes?.[0]
    ? Array.from(result.facialTransformationMatrixes[0].data)
    : [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];

  frames.push({ t: now - sessionStart, turn: turnIndex, face: hasFace, bs, m });

  $("hud-time").textContent = ((now - sessionStart) / 1000).toFixed(0) + "s";
  $("hud-question").textContent = "Q" + (turnIndex + 1);
  $("hud-face").textContent = hasFace ? "face ✓" : "face ✗";

  requestAnimationFrame(() => renderLoop(video, canvas, ctx, draw));
}

function onTranscript({ speaker, text }) {
  if (speaker === "interviewer") turnIndex += 1;  // matches questions_from_transcript indexing
  segments.push({ speaker, text, t: performance.now() - sessionStart });
  const li = document.createElement("div");
  li.className = "line " + speaker;
  li.textContent = (speaker === "interviewer" ? "Interviewer: " : "You: ") + text;
  $("transcript").appendChild(li);
  $("transcript").scrollTop = $("transcript").scrollHeight;
}

async function startInterview() {
  role = $("role-select").value || CONFIG.ROLES[0];
  frames = []; segments = []; turnIndex = -1;
  show("screen-interview");

  mediaStream = await navigator.mediaDevices.getUserMedia({
    video: { width: 1280, height: 720, facingMode: "user" },
    audio: { sampleRate: 48000, channelCount: 1,
             echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });

  const video = document.createElement("video");
  video.srcObject = mediaStream; video.muted = true; await video.play();

  const canvas = $("cam");
  canvas.width = 1280; canvas.height = 720;
  const ctx = canvas.getContext("2d");
  const draw = new DrawingUtils(ctx);

  if (!landmarker) await initLandmarker();

  const tokenResp = await fetch("/api/interview/token", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ role }),
  }).then((r) => r.json());

  sessionStart = performance.now();
  running = true;
  renderLoop(video, canvas, ctx, draw);

  agent = startVoiceAgent({
    url: tokenResp.url, token: tokenResp.token, config: tokenResp.config,
    micStream: mediaStream, onTranscript, onClose: () => {},
  });
}

async function endInterview() {
  running = false;
  if (agent) agent.stop();
  if (mediaStream) mediaStream.getTracks().forEach((t) => t.stop());

  const full_text = segments
    .map((s) => (s.speaker === "interviewer" ? "INTERVIEWER: " : "CANDIDATE: ") + s.text)
    .join("\n");

  const resp = await fetch("/api/session", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ role, frames, transcript: { full_text, segments } }),
  }).then((r) => r.json());

  renderResults(resp);
  show("screen-results");
}

function renderResults(data) {
  const o = data.summary.overall;
  $("metrics-overall").innerHTML =
    `<li>Eye contact: ${o.eye_contact_pct}%</li>` +
    `<li>Steadiness: ${o.steadiness_score}/100</li>` +
    `<li>Smiling: ${o.pct_smiling}% (peak ${o.peak_smile})</li>` +
    `<li>Blinks: ${o.blink_count} (${o.blinks_per_min}/min)</li>` +
    `<li>No-face: ${data.summary.no_face_pct}%</li>`;

  $("metrics-per-question").innerHTML = data.summary.per_question.map((q) =>
    `<tr><td>${q.question}</td><td>${q.metrics.eye_contact_pct}%</td>` +
    `<td>${q.metrics.steadiness_score}</td><td>${q.metrics.pct_smiling}%</td>` +
    `<td>${q.metrics.blink_count}</td></tr>`).join("");

  $("chart-img").src = data.charts_url;

  if (data.coaching) {
    const c = data.coaching;
    $("coaching").innerHTML =
      `<p><strong>Score:</strong> ${c.score ?? "—"}/10</p>` +
      `<p>${c.summary}</p>` +
      `<p><strong>Strengths:</strong> ${(c.strengths || []).join("; ")}</p>` +
      `<p><strong>Improve:</strong> ${(c.improvements || []).join("; ")}</p>`;
  } else {
    $("coaching").textContent = "Coaching not available (no Anthropic key or empty transcript).";
  }
}

window.addEventListener("DOMContentLoaded", () => {
  const sel = $("role-select");
  for (const r of CONFIG.ROLES) {
    const opt = document.createElement("option"); opt.value = r; opt.textContent = r;
    sel.appendChild(opt);
  }
  $("start-btn").addEventListener("click", () => startInterview().catch((e) => {
    alert("Could not start: " + e.message); show("screen-start");
  }));
  $("end-btn").addEventListener("click", () => endInterview().catch((e) => alert(e.message)));
  $("newsession-btn").addEventListener("click", () => show("screen-start"));
  show("screen-start");
});
```

- [ ] **Step 2: Invoke `frontend-design` to create `index.html` + `style.css`**

Provide the skill the **Required DOM contract** above (element IDs and per-screen content) and these constraints:
- `frontend/index.html` must load `app.js` as a module: `<script type="module" src="/app.js"></script>`.
- Three screens (`#screen-start`, `#screen-interview`, `#screen-results`), shown one at a time (`app.js` toggles `style.display`).
- Interview screen: large webcam canvas `#cam` beside a scrolling `#transcript`, with the HUD strip (`#hud-time`, `#hud-question`, `#hud-face`) and `#end-btn`.
- Results screen: `#metrics-overall` (`<ul>`), a `#metrics-per-question` table body (columns: Question, Eye contact, Steadiness, Smiling, Blinks), `#chart-img`, `#coaching`, `#newsession-btn`.
- Start screen: heading + instructions, `#role-select`, `#start-btn`.

- [ ] **Step 3: Manual end-to-end test (local, requires both API keys in `.env`)**

Run: `. .venv/bin/activate && uvicorn backend.main:app --reload --port 8000`, open `http://localhost:8000`.
Expected:
1. Start screen shows; pick a role; click Start → browser asks for camera + mic permission.
2. Interview screen shows the webcam with a green mesh overlay; the AI greets you by voice; HUD ticks; transcript fills as you converse; `Q#` increments on each interviewer turn.
3. Click End → Results screen shows overall + per-question metrics, the chart image, and coaching text.
4. `sessions/<id>/` contains `data.csv`, `data.json`, `summary.json`, `transcript.txt`, `charts.png`.

- [ ] **Step 4: Commit**

```bash
git add frontend/app.js frontend/index.html frontend/style.css
git commit -m "feat: frontend app — MediaPipe capture, voice agent, 3 screens"
```

---

# Phase 3 — EC2 Deployment (later / optional)

## Task 14: Deployment docs & Nginx TLS config

**Files:**
- Create: `deploy/nginx.conf`
- Create: `deploy/DEPLOY.md`

- [ ] **Step 1: Create `deploy/nginx.conf`**

```nginx
# Reverse proxy with TLS — HTTPS is required for browser camera + mic access.
server {
    listen 443 ssl;
    server_name _;

    ssl_certificate     /etc/ssl/interview/cert.pem;
    ssl_certificate_key /etc/ssl/interview/key.pem;

    location / {
        proxy_pass http://127.0.0.1:8000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_read_timeout 300s;
    }
}
server {
    listen 80;
    server_name _;
    return 301 https://$host$request_uri;
}
```

- [ ] **Step 2: Create `deploy/DEPLOY.md`**

````markdown
# EC2 Deployment

> Local dev needs none of this — `localhost` is a secure context, so camera/mic work over plain HTTP.
> This is only for remote testing on EC2, where browsers require HTTPS.

## 1. Provision
- Ubuntu 22.04 EC2 instance.
- Security group inbound: 443 (HTTPS), 22 (SSH).

## 2. App setup
```bash
sudo apt update && sudo apt install -y python3-venv nginx
git clone <your-repo> interview && cd interview
python3 -m venv .venv && . .venv/bin/activate
pip install -r backend/requirements.txt
printf "DEEPGRAM_API_KEY=...\nANTHROPIC_API_KEY=...\n" > .env
```

## 3. Run the app (systemd)
Create `/etc/systemd/system/interview.service`:
```ini
[Unit]
Description=Interview app
After=network.target
[Service]
WorkingDirectory=/home/ubuntu/interview
ExecStart=/home/ubuntu/interview/.venv/bin/uvicorn backend.main:app --host 127.0.0.1 --port 8000
Restart=always
EnvironmentFile=/home/ubuntu/interview/.env
[Install]
WantedBy=multi-user.target
```
```bash
sudo systemctl enable --now interview
```

## 4. TLS (self-signed for testing)
```bash
sudo mkdir -p /etc/ssl/interview
sudo openssl req -x509 -newkey rsa:2048 -nodes -days 365 \
  -keyout /etc/ssl/interview/key.pem -out /etc/ssl/interview/cert.pem -subj "/CN=$(curl -s ifconfig.me)"
sudo cp deploy/nginx.conf /etc/nginx/sites-available/interview
sudo ln -sf /etc/nginx/sites-available/interview /etc/nginx/sites-enabled/interview
sudo nginx -t && sudo systemctl restart nginx
```
Visit `https://<ec2-public-ip>/` and accept the one-time browser warning.
For a real cert, point a domain at the instance and use Let's Encrypt (`certbot --nginx`).
````

- [ ] **Step 3: Commit**

```bash
git add deploy/nginx.conf deploy/DEPLOY.md
git commit -m "docs: EC2 deployment with Nginx TLS reverse proxy"
```

---

## Self-Review (completed during planning)

- **Spec coverage:** every spec section maps to a task — analysis/metrics (Tasks 2–4, 8), report+charts (Task 5), Deepgram interview (Task 6 + frontend Task 12), Claude coaching (Task 7), API (Task 9), 3-screen UI (Tasks 11–13), local run + EC2 deploy (Tasks 10, 14), error handling (empty frames → 400 in Task 9; no-face in Task 3; missing key in Task 9; WS close in Task 12). MediaPipe runs in-browser (Task 13), `numFaces: 1` (Task 13).
- **Type consistency:** the `Frame` shape (`t/turn/face/bs/m`) and `MetricBlock` keys are used identically in `analysis.py`, `report.py`, `main.py`, and `app.js`. `turn` indexing in `app.js` (increment on interviewer `ConversationText`) matches `questions_from_transcript` (Nth interviewer line → turn N).
- **Placeholders:** none — all code steps contain full code; the only delegated artifacts are `index.html`/`style.css`, intentionally handed to the `frontend-design` skill with an explicit DOM contract.
