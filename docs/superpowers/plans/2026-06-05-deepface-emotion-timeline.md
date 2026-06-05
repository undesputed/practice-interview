# DeepFace Emotion Timeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an additive, batch-at-end DeepFace emotion timeline to the interview report without changing the existing MediaPipe pipeline or layout.

**Architecture:** During the interview the client crops face thumbnails (using the MediaPipe face box) ~every 3s and buffers them. On "End", the crops upload to a new `POST /api/emotion`; the backend runs DeepFace emotion scoring in memory (images discarded), aggregates per-question/over-time, and the client echoes the result into the existing `/api/session` body, which renders a new `emotion.png` chart and emotion card. DeepFace is optional (separate requirements file, lazy import, env flag) and degrades gracefully.

**Tech Stack:** FastAPI, DeepFace (+ TensorFlow CPU, optional), matplotlib, vanilla JS + MediaPipe Tasks Vision (browser), pytest.

**Spec:** [docs/superpowers/specs/2026-06-05-deepface-emotion-timeline-design.md](../specs/2026-06-05-deepface-emotion-timeline-design.md)

---

## File structure

- **Create** `backend/emotion.py` — `EMOTION_CLASSES`, pure `aggregate_emotions(shots)`, lazy `score_emotions(images)`.
- **Create** `backend/requirements-emotion.txt` — optional DeepFace + TF deps.
- **Create** `tests/test_emotion.py` — aggregation + scoring-degradation + endpoint tests.
- **Modify** `backend/main.py` — `POST /api/emotion`; `SessionRequest.emotion`; merge into `summary`; return `emotion_chart_url`.
- **Modify** `backend/report.py` — `_build_emotion_chart`; render `emotion.png` in `save_session`.
- **Modify** `frontend/config.js` — `EMOTION_*` constants.
- **Modify** `frontend/app.js` — face-box crop capture, buffer, upload, results rendering.
- **Modify** `frontend/index.html` — emotion card, chart img, per-question column, privacy notice.
- **Modify** `deploy/DEPLOY.md` — optional "enable emotion analysis" step.

---

## Task 1: Emotion aggregation core (pure, no ML)

**Files:**
- Create: `backend/emotion.py`
- Test: `tests/test_emotion.py`

- [ ] **Step 1: Write the failing test**

```python
# tests/test_emotion.py
from backend.emotion import aggregate_emotions, EMOTION_CLASSES

def _scores(dominant):
    s = {c: 0.0 for c in EMOTION_CLASSES}
    s[dominant] = 90.0
    return s

def _shot(t, turn, dominant):
    return {"t": t, "turn": turn, "dominant": dominant, "scores": _scores(dominant)}

def test_aggregate_empty_is_unavailable():
    assert aggregate_emotions([]) == {"available": False}

def test_aggregate_overall_and_per_question():
    shots = [
        _shot(0.0, 0, "neutral"), _shot(100.0, 0, "happy"),
        _shot(200.0, 1, "neutral"), _shot(300.0, 1, "neutral"),
    ]
    out = aggregate_emotions(shots)
    assert out["available"] is True
    assert out["dominant"] == "neutral"                      # 3 of 4 shots
    assert out["overall_distribution"]["neutral"] == 75.0
    assert out["overall_distribution"]["happy"] == 25.0
    assert [q["turn"] for q in out["per_question"]] == [0, 1]
    assert out["per_question"][1]["dominant"] == "neutral"   # both turn-1 shots neutral
    assert out["per_question"][1]["distribution"]["neutral"] == 100.0
    assert [s["t"] for s in out["timeline"]] == [0.0, 100.0, 200.0, 300.0]

def test_aggregate_timeline_is_time_sorted():
    shots = [_shot(300.0, 1, "sad"), _shot(0.0, 0, "happy")]
    out = aggregate_emotions(shots)
    assert [s["t"] for s in out["timeline"]] == [0.0, 300.0]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_emotion.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'backend.emotion'`

- [ ] **Step 3: Write minimal implementation**

```python
# backend/emotion.py
from __future__ import annotations
import logging

# DeepFace's FER model emits these 7 classes (no "contempt").
EMOTION_CLASSES = ["angry", "disgust", "fear", "happy", "sad", "surprise", "neutral"]


def aggregate_emotions(shots: list[dict]) -> dict:
    """Aggregate per-shot emotion records into the report's emotion summary.

    Each shot: {"t": float_ms, "turn": int, "dominant": str, "scores": {class: 0-100}}.
    Distribution = percent of shots for which a class is the dominant emotion.
    Returns {"available": False} when there are no shots.
    """
    if not shots:
        return {"available": False}

    n = len(shots)
    dom_counts = {c: 0 for c in EMOTION_CLASSES}
    for s in shots:
        dom_counts[s["dominant"]] = dom_counts.get(s["dominant"], 0) + 1
    overall = {c: round(100.0 * dom_counts[c] / n, 1) for c in EMOTION_CLASSES}
    dominant = max(dom_counts, key=dom_counts.get)

    by_turn: dict[int, list[dict]] = {}
    for s in shots:
        by_turn.setdefault(s.get("turn", -1), []).append(s)
    per_question = []
    for turn in sorted(t for t in by_turn if t >= 0):
        group = by_turn[turn]
        c = {cl: 0 for cl in EMOTION_CLASSES}
        for s in group:
            c[s["dominant"]] += 1
        m = len(group)
        per_question.append({
            "turn": turn,
            "dominant": max(c, key=c.get),
            "distribution": {cl: round(100.0 * c[cl] / m, 1) for cl in EMOTION_CLASSES},
        })

    timeline = [{"t": s["t"], "turn": s.get("turn", -1),
                 "dominant": s["dominant"], "scores": s["scores"]}
                for s in sorted(shots, key=lambda s: s["t"])]

    return {"available": True, "dominant": dominant, "overall_distribution": overall,
            "per_question": per_question, "timeline": timeline}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/test_emotion.py -v`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add backend/emotion.py tests/test_emotion.py
git commit -m "feat: emotion aggregation core (pure, no ML deps)"
```

---

## Task 2: DeepFace scoring wrapper with graceful degradation

**Files:**
- Modify: `backend/emotion.py`
- Test: `tests/test_emotion.py`

- [ ] **Step 1: Write the failing test**

Append to `tests/test_emotion.py`:

```python
from backend import emotion as emotion_mod

def test_score_emotions_raises_when_deepface_missing(monkeypatch):
    # Simulate DeepFace not installed: the lazy import inside score_emotions fails.
    import builtins
    real_import = builtins.__import__

    def fake_import(name, *a, **k):
        if name == "deepface" or name.startswith("deepface."):
            raise ImportError("No module named 'deepface'")
        return real_import(name, *a, **k)

    monkeypatch.setattr(builtins, "__import__", fake_import)
    import pytest
    with pytest.raises(ImportError):
        emotion_mod.score_emotions([b"not-a-real-jpeg"])
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_emotion.py::test_score_emotions_raises_when_deepface_missing -v`
Expected: FAIL with `AttributeError: module 'backend.emotion' has no attribute 'score_emotions'`

- [ ] **Step 3: Write minimal implementation**

Append to `backend/emotion.py`:

```python
def score_emotions(images: list[bytes]) -> list[dict | None]:
    """Run DeepFace emotion analysis on each JPEG byte string.

    Returns a list aligned with `images`; each element is
    {"dominant": str, "scores": {class: 0-100}} or None if that shot failed.
    Lazy-imports DeepFace (and cv2/numpy) so the app boots without them; raises
    ImportError if DeepFace is unavailable. Images are never written to disk.
    """
    from deepface import DeepFace  # lazy, heavy (TensorFlow)
    import numpy as np
    import cv2

    out: list[dict | None] = []
    for buf in images:
        try:
            arr = cv2.imdecode(np.frombuffer(buf, np.uint8), cv2.IMREAD_COLOR)
            if arr is None:
                raise ValueError("could not decode image")
            res = DeepFace.analyze(arr, actions=["emotion"], detector_backend="skip",
                                   enforce_detection=False, silent=True)
            r = res[0] if isinstance(res, list) else res
            emo = r["emotion"]
            out.append({"dominant": r["dominant_emotion"],
                        "scores": {c: round(float(emo.get(c, 0.0)), 1) for c in EMOTION_CLASSES}})
        except Exception as exc:  # one bad frame must not sink the batch
            logging.warning("emotion shot skipped: %s", exc)
            out.append(None)
    return out
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/test_emotion.py -v`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add backend/emotion.py tests/test_emotion.py
git commit -m "feat: lazy DeepFace emotion scoring wrapper"
```

---

## Task 3: `POST /api/emotion` endpoint

**Files:**
- Modify: `backend/main.py`
- Test: `tests/test_emotion.py`

- [ ] **Step 1: Write the failing test**

Append to `tests/test_emotion.py`:

```python
import json
from fastapi.testclient import TestClient
from backend.main import app

_client = TestClient(app)

def _canned_scores(dominant):
    s = {c: 0.0 for c in EMOTION_CLASSES}
    s[dominant] = 88.0
    return {"dominant": dominant, "scores": s}

def test_emotion_endpoint_disabled_returns_unavailable(monkeypatch):
    monkeypatch.delenv("EMOTION_ANALYSIS", raising=False)
    files = [("images", ("f.jpg", b"x", "image/jpeg"))]
    data = {"meta": json.dumps([{"t": 0.0, "turn": 0}])}
    resp = _client.post("/api/emotion", data=data, files=files)
    assert resp.status_code == 200
    assert resp.json() == {"available": False}

def test_emotion_endpoint_aggregates_when_enabled(monkeypatch):
    monkeypatch.setenv("EMOTION_ANALYSIS", "1")
    import backend.main as main
    monkeypatch.setattr(main, "score_emotions",
                        lambda bufs: [_canned_scores("happy") for _ in bufs])
    files = [("images", ("a.jpg", b"x", "image/jpeg")),
             ("images", ("b.jpg", b"y", "image/jpeg"))]
    data = {"meta": json.dumps([{"t": 0.0, "turn": 0}, {"t": 100.0, "turn": 0}])}
    resp = _client.post("/api/emotion", data=data, files=files)
    assert resp.status_code == 200
    out = resp.json()
    assert out["available"] is True
    assert out["dominant"] == "happy"
    assert out["overall_distribution"]["happy"] == 100.0

def test_emotion_endpoint_unavailable_when_scoring_raises(monkeypatch):
    monkeypatch.setenv("EMOTION_ANALYSIS", "1")
    import backend.main as main
    def boom(_bufs):
        raise ImportError("no deepface")
    monkeypatch.setattr(main, "score_emotions", boom)
    files = [("images", ("a.jpg", b"x", "image/jpeg"))]
    data = {"meta": json.dumps([{"t": 0.0, "turn": 0}])}
    resp = _client.post("/api/emotion", data=data, files=files)
    assert resp.json() == {"available": False}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_emotion.py::test_emotion_endpoint_aggregates_when_enabled -v`
Expected: FAIL with `404 Not Found` (route does not exist yet)

- [ ] **Step 3: Write minimal implementation**

In `backend/main.py`, add to the imports near the top (after the existing `from fastapi import ...` line, which currently reads `from fastapi import FastAPI, HTTPException`):

```python
import json
from fastapi import FastAPI, HTTPException, File, Form, UploadFile
from backend.emotion import score_emotions, aggregate_emotions
```

(Replace the existing `from fastapi import FastAPI, HTTPException` line with the expanded one above; add the other two lines alongside the existing backend imports.)

Then add the endpoint after the `interview_token` function and before `@app.post("/api/session")`:

```python
@app.post("/api/emotion")
async def emotion(meta: str = Form(...), images: list[UploadFile] = File(default=[])):
    """Score buffered face crops with DeepFace and return the aggregated emotion summary.

    Optional + graceful: returns {"available": False} when EMOTION_ANALYSIS != "1",
    no images were sent, or DeepFace is unavailable. Images are scored in memory and
    never written to disk.
    """
    if os.getenv("EMOTION_ANALYSIS") != "1" or not images:
        return {"available": False}
    try:
        metas = json.loads(meta)
    except (ValueError, TypeError):
        raise HTTPException(400, "invalid meta JSON")
    bufs = [await im.read() for im in images]
    try:
        scored = score_emotions(bufs)
    except Exception as exc:  # DeepFace import/runtime failure -> degrade
        logging.warning("emotion scoring unavailable: %s", exc)
        return {"available": False}
    shots = []
    for md, sc in zip(metas, scored):
        if sc is None:
            continue
        shots.append({"t": md.get("t", 0.0), "turn": md.get("turn", -1),
                      "dominant": sc["dominant"], "scores": sc["scores"]})
    return aggregate_emotions(shots)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/test_emotion.py -v`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add backend/main.py tests/test_emotion.py
git commit -m "feat: POST /api/emotion endpoint (optional, graceful)"
```

---

## Task 4: Wire emotion into `/api/session`

**Files:**
- Modify: `backend/main.py:32-36` (SessionRequest), `backend/main.py:78-99` (session)
- Test: `tests/test_emotion.py`

- [ ] **Step 1: Write the failing test**

Append to `tests/test_emotion.py`:

```python
def _frame(t, turn=0):
    m = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]
    return {"t": t, "turn": turn, "face": True,
            "bs": {"mouthSmileLeft": 0.1, "mouthSmileRight": 0.1,
                   "eyeBlinkLeft": 0.0, "eyeBlinkRight": 0.0, "browInnerUp": 0.0},
            "m": m}

def test_session_includes_emotion_and_chart_url(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)  # skip coaching
    emotion_summary = {
        "available": True, "dominant": "neutral",
        "overall_distribution": {c: (100.0 if c == "neutral" else 0.0) for c in EMOTION_CLASSES},
        "per_question": [{"turn": 0, "dominant": "neutral",
                          "distribution": {c: (100.0 if c == "neutral" else 0.0) for c in EMOTION_CLASSES}}],
        "timeline": [{"t": 0.0, "turn": 0, "dominant": "neutral",
                      "scores": {c: (90.0 if c == "neutral" else 0.0) for c in EMOTION_CLASSES}}],
    }
    body = {"role": "Software Engineer",
            "frames": [_frame(i * 100.0) for i in range(5)],
            "transcript": {"full_text": "", "segments": [
                {"speaker": "interviewer", "text": "hi", "t": 0}]},
            "emotion": emotion_summary}
    resp = _client.post("/api/session", json=body)
    assert resp.status_code == 200
    data = resp.json()
    assert data["summary"]["emotion"]["dominant"] == "neutral"
    assert data["emotion_chart_url"].endswith("emotion.png")

def test_session_emotion_absent_is_unavailable(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    body = {"role": "Software Engineer",
            "frames": [_frame(0.0)],
            "transcript": {"full_text": "", "segments": []}}
    data = _client.post("/api/session", json=body).json()
    assert data["summary"]["emotion"] == {"available": False}
    assert data["emotion_chart_url"] is None
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_emotion.py::test_session_includes_emotion_and_chart_url -v`
Expected: FAIL with `KeyError: 'emotion'` or assertion error on missing `emotion_chart_url`

- [ ] **Step 3: Write minimal implementation**

In `backend/main.py`, add the `emotion` field to `SessionRequest` (currently lines 32-36):

```python
class SessionRequest(BaseModel):
    role: str = "Software Engineer"
    frames: list[dict]
    transcript: dict
    events: list = []
    emotion: dict | None = None
```

In the `session` function, after the line `summary["actions"] = summarize_actions(req.events)`, add:

```python
    summary["emotion"] = req.emotion if (req.emotion and req.emotion.get("available")) else {"available": False}
```

Then change the final `return` of `session` to include the chart URL:

```python
    emotion_chart_url = (f"/sessions/{session_id}/emotion.png"
                         if summary["emotion"].get("available") else None)
    return {"session_id": session_id, "summary": summary, "coaching": coaching,
            "charts_url": f"/sessions/{session_id}/charts.png",
            "emotion_chart_url": emotion_chart_url}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/test_emotion.py tests/test_main.py -v`
Expected: PASS (existing `test_main.py` tests still pass; new session tests pass)

- [ ] **Step 5: Commit**

```bash
git add backend/main.py tests/test_emotion.py
git commit -m "feat: merge emotion summary into /api/session response"
```

---

## Task 5: Render `emotion.png` chart in the report

**Files:**
- Modify: `backend/report.py`
- Test: `tests/test_report.py`

- [ ] **Step 1: Write the failing test**

Append to `tests/test_report.py`:

```python
from backend.emotion import EMOTION_CLASSES

def _emotion_summary():
    def dist(dom): return {c: (100.0 if c == dom else 0.0) for c in EMOTION_CLASSES}
    def scores(dom): return {c: (90.0 if c == dom else 1.0) for c in EMOTION_CLASSES}
    return {"available": True, "dominant": "neutral",
            "overall_distribution": dist("neutral"),
            "per_question": [{"turn": 0, "dominant": "neutral", "distribution": dist("neutral")}],
            "timeline": [{"t": i * 1000.0, "turn": 0, "dominant": "neutral",
                          "scores": scores("neutral")} for i in range(4)]}

def test_save_session_writes_emotion_png_when_available(tmp_path):
    frames = [_frame(i * 100.0) for i in range(5)]
    summary = {"duration_sec": 0.5, "frame_count": 5, "no_face_pct": 0.0,
               "overall": {}, "per_question": [], "emotion": _emotion_summary()}
    d = str(tmp_path / "s")
    save_session(d, frames, {"full_text": "", "segments": []}, summary, None)
    assert os.path.exists(os.path.join(d, "emotion.png"))

def test_save_session_skips_emotion_png_when_unavailable(tmp_path):
    frames = [_frame(i * 100.0) for i in range(5)]
    summary = {"duration_sec": 0.5, "frame_count": 5, "no_face_pct": 0.0,
               "overall": {}, "per_question": [], "emotion": {"available": False}}
    d = str(tmp_path / "s2")
    save_session(d, frames, {"full_text": "", "segments": []}, summary, None)
    assert not os.path.exists(os.path.join(d, "emotion.png"))
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_report.py::test_save_session_writes_emotion_png_when_available -v`
Expected: FAIL — `emotion.png` is not created

- [ ] **Step 3: Write minimal implementation**

In `backend/report.py`, add `EMOTION_CLASSES` to the existing analysis import (currently the multi-line import of `matrix_to_euler, SMILE_THRESHOLD, GAZE_MAX, UPRIGHT_RATIO, FRAME_ASPECT`):

```python
from backend.analysis import (matrix_to_euler, SMILE_THRESHOLD, GAZE_MAX,
                              UPRIGHT_RATIO, FRAME_ASPECT)
from backend.emotion import EMOTION_CLASSES
```

Add this function above `save_session`:

```python
def _build_emotion_chart(path: str, emotion: dict) -> None:
    """Line-per-emotion score over time, with red lines at question boundaries."""
    timeline = emotion.get("timeline", [])
    if not timeline:
        return
    ts = [s["t"] / 1000.0 for s in timeline]
    boundaries = [timeline[i]["t"] / 1000.0 for i in range(1, len(timeline))
                  if timeline[i]["turn"] != timeline[i - 1]["turn"]]
    fig, ax = plt.subplots(figsize=(14, 4))
    for c in EMOTION_CLASSES:
        ax.plot(ts, [s["scores"].get(c, 0.0) for s in timeline], label=c, lw=1.0)
    for b in boundaries:
        ax.axvline(b, color="red", lw=0.6, alpha=0.5)
    ax.set_xlabel("seconds"); ax.set_ylabel("emotion score (0-100)")
    ax.legend(loc="upper right", ncol=4, fontsize=8)
    fig.suptitle("Emotion over time (red = new question)")
    fig.tight_layout()
    fig.savefig(path, dpi=120)
    plt.close(fig)
```

In `save_session`, after the existing `_build_charts(...)` call, add:

```python
    emotion = summary.get("emotion") or {}
    if emotion.get("available"):
        _build_emotion_chart(os.path.join(session_dir, "emotion.png"), emotion)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/test_report.py -v`
Expected: PASS (existing report tests + 2 new)

- [ ] **Step 5: Commit**

```bash
git add backend/report.py tests/test_report.py
git commit -m "feat: render emotion.png chart in session report"
```

---

## Task 6: Optional dependency packaging + deploy docs

**Files:**
- Create: `backend/requirements-emotion.txt`
- Modify: `deploy/DEPLOY.md`

- [ ] **Step 1: Create the optional requirements file**

```
# backend/requirements-emotion.txt
# OPTIONAL — only needed to enable DeepFace emotion analysis (EMOTION_ANALYSIS=1).
# Heavy (TensorFlow). Install separately from backend/requirements.txt.
deepface==0.0.93
tf-keras==2.17.0
```

- [ ] **Step 2: Run the full suite to confirm nothing regressed**

Run: `python -m pytest tests/ -q`
Expected: PASS (all tests; DeepFace not imported because lazy)

- [ ] **Step 3: Document the optional step in DEPLOY.md**

In `deploy/DEPLOY.md`, after the `pip install -r backend/requirements.txt` line in the "App setup" section, add:

```markdown

### Optional: DeepFace emotion analysis
Emotion analysis is off by default. To enable it:
```bash
pip install -r backend/requirements-emotion.txt   # heavy: pulls TensorFlow
```
Add `EMOTION_ANALYSIS=1` to `.env`. First run downloads the ~5 MB emotion model.
Leave it unset to disable (the app and reports work normally without it).
```

- [ ] **Step 4: Commit**

```bash
git add backend/requirements-emotion.txt deploy/DEPLOY.md
git commit -m "build: optional DeepFace emotion deps + deploy docs"
```

---

## Task 7: Frontend capture — config + face-crop buffering

**Files:**
- Modify: `frontend/config.js`
- Modify: `frontend/app.js`

No automated JS tests exist in this repo; verification is manual (Step 4).

- [ ] **Step 1: Add config constants**

In `frontend/config.js`, add these keys inside the `CONFIG` object (after `POSE_THROTTLE_MS`):

```javascript
  EMOTION_THROTTLE_MS: 3000,  // capture ~1 face crop per 3s for DeepFace emotion
  EMOTION_CROP_PX: 112,       // square crop size sent to the backend
  EMOTION_MAX_SHOTS: 200,     // hard cap on buffered crops per interview
```

- [ ] **Step 2: Add capture state, helpers, and the throttled crop**

In `frontend/app.js`, add module-level state near the other `let` declarations (after `let frames = [];`):

```javascript
let emotionShots = [];
let lastEmotionTs = 0;
const cropCanvas = document.createElement("canvas");
```

Add this helper near the other top-level helper functions (e.g. after `fmtTime`):

```javascript
// Derive a padded pixel bounding box around the face from normalized landmarks.
function faceBox(landmarks, w, h, pad = 0.2) {
  let minX = 1, minY = 1, maxX = 0, maxY = 0;
  for (const p of landmarks) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  const bw = maxX - minX, bh = maxY - minY;
  minX -= bw * pad; maxX += bw * pad; minY -= bh * pad; maxY += bh * pad;
  const sx = Math.max(0, minX * w), sy = Math.max(0, minY * h);
  const sw = Math.min(w, maxX * w) - sx, sh = Math.min(h, maxY * h) - sy;
  return { sx, sy, sw, sh };
}
```

In `renderLoop`, immediately after the line `frames.push(frame);`, add the throttled capture:

```javascript
  // Emotion: throttled face crop buffered for batch DeepFace analysis at end.
  if (hasFace && now - lastEmotionTs >= CONFIG.EMOTION_THROTTLE_MS
      && emotionShots.length < CONFIG.EMOTION_MAX_SHOTS) {
    lastEmotionTs = now;
    const box = faceBox(result.faceLandmarks[0], video.videoWidth, video.videoHeight);
    if (box.sw > 4 && box.sh > 4) {
      cropCanvas.width = CONFIG.EMOTION_CROP_PX;
      cropCanvas.height = CONFIG.EMOTION_CROP_PX;
      const cctx = cropCanvas.getContext("2d");
      cctx.drawImage(video, box.sx, box.sy, box.sw, box.sh,
                     0, 0, CONFIG.EMOTION_CROP_PX, CONFIG.EMOTION_CROP_PX);
      const capturedT = frame.t, capturedTurn = turnIndex;
      cropCanvas.toBlob((blob) => {
        if (blob) emotionShots.push({ t: capturedT, turn: capturedTurn, blob });
      }, "image/jpeg", 0.8);
    }
  }
```

In `startInterview`, add to the reset block (the line `frames = []; segments = []; turnIndex = -1; events = [];`):

```javascript
  emotionShots = []; lastEmotionTs = 0;
```

- [ ] **Step 3: Manual sanity check — capture buffers crops**

Run the app locally:
```bash
EMOTION_ANALYSIS=0 .venv/bin/uvicorn backend.main:app --reload
```
Open `http://localhost:8000`, start an interview, let it run ~15s, open the browser console and type `window.__emotionShots ?? "n/a"`. (Optional: temporarily expose `window.__emotionShots = emotionShots` at the end of `renderLoop` to inspect; remove before commit.) Expected: the buffer grows by roughly one entry per 3 seconds.

- [ ] **Step 4: Commit**

```bash
git add frontend/config.js frontend/app.js
git commit -m "feat: buffer throttled face crops for emotion analysis"
```

---

## Task 8: Frontend upload — POST crops, echo into session

**Files:**
- Modify: `frontend/app.js` (`endInterview`)

- [ ] **Step 1: Upload crops and attach result to the session body**

In `frontend/app.js`, inside `endInterview`, after the `full_text` is built and BEFORE the existing `const r = await fetch("/api/session", ...)` call, add:

```javascript
  let emotion = null;
  if (emotionShots.length) {
    try {
      const fd = new FormData();
      fd.append("meta", JSON.stringify(emotionShots.map((s) => ({ t: s.t, turn: s.turn }))));
      for (const s of emotionShots) fd.append("images", s.blob, "crop.jpg");
      const er = await fetch("/api/emotion", { method: "POST", body: fd });
      if (er.ok) emotion = await er.json();
    } catch (e) {
      console.warn("[interview] emotion upload failed:", e.message);
    }
  }
```

Then change the `/api/session` request body to include `emotion`. The existing call is:

```javascript
  const r = await fetch("/api/session", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ role, frames, transcript: { full_text, segments }, events }),
  });
```

Change the `body` line to:

```javascript
    body: JSON.stringify({ role, frames, transcript: { full_text, segments }, events, emotion }),
```

- [ ] **Step 2: Manual check — request shape**

With `EMOTION_ANALYSIS` unset, run an interview and click End. In the browser Network tab: `/api/emotion` returns `{"available": false}`; `/api/session` succeeds and its response includes `emotion_chart_url: null`. Expected: no errors, report renders as before.

- [ ] **Step 3: Commit**

```bash
git add frontend/app.js
git commit -m "feat: upload face crops to /api/emotion and attach to session"
```

---

## Task 9: Frontend results UI — emotion card, chart, per-question column, privacy notice

**Files:**
- Modify: `frontend/index.html`
- Modify: `frontend/app.js` (`renderResults`)

- [ ] **Step 1: Add the markup**

In `frontend/index.html`:

(a) Add a privacy note to the start-screen `<ul class="start-notes">` (after the existing camera/mic `<li>`):

```html
            <li><span class="dot" aria-hidden="true"></span> Facial expressions are analyzed; face snapshots are processed and immediately discarded</li>
```

(b) Add an **Emotion** header cell to the per-question table `<thead><tr>`, after the `<th>Composure</th>` cell:

```html
                  <th>Emotion</th>
```

(c) Add a new emotion card + chart section. Insert it right after the "4. Big full-width chart" card block (after the `</div>` that closes `card card-chart`, before the "5. Coaching" card):

```html
        <!-- 4b. Emotion (DeepFace) -->
        <div class="card card-emotion-section">
          <h2 class="card-title">Emotion (DeepFace)</h2>
          <ul id="card-emotion" class="card-list"></ul>
          <div class="chart-holder chart-holder-big">
            <img id="emotion-img" alt="Emotion over time chart" style="display:none" />
          </div>
        </div>
```

- [ ] **Step 2: Render emotion in `renderResults`**

In `frontend/app.js`, inside `renderResults`, add near the top (after `const s = data.summary, ...`) a per-turn emotion lookup:

```javascript
  const emo = s.emotion || { available: false };
  const emoByTurn = {};
  (emo.per_question || []).forEach((q) => { emoByTurn[q.turn] = q.dominant; });
```

In the per-question row loop, the existing cell array is:

```javascript
    for (const cell of [q.question, `${q.metrics.gaze_eye_contact_pct}%`,
                        `${q.metrics.upright_pct}%`, `${q.metrics.composure}`,
                        rt[q.turn] != null ? `${rt[q.turn]}s` : "—",
                        `${q.metrics.face_touch_count}`]) {
```

Change it to insert the emotion cell after composure:

```javascript
    for (const cell of [q.question, `${q.metrics.gaze_eye_contact_pct}%`,
                        `${q.metrics.upright_pct}%`, `${q.metrics.composure}`,
                        emoByTurn[q.turn] || "—",
                        rt[q.turn] != null ? `${rt[q.turn]}s` : "—",
                        `${q.metrics.face_touch_count}`]) {
```

At the end of `renderResults` (after the coaching block), add the emotion card + chart rendering:

```javascript
  const emoImg = $("emotion-img");
  if (emo.available) {
    const dist = Object.entries(emo.overall_distribution || {})
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k} ${v}%`).join(" · ");
    fillList("card-emotion", [`Dominant emotion: ${emo.dominant}`, `Distribution: ${dist}`]);
    if (emoImg && data.emotion_chart_url) { emoImg.src = data.emotion_chart_url; emoImg.style.display = ""; }
  } else {
    fillList("card-emotion", ["Emotion analysis not available"]);
    if (emoImg) emoImg.style.display = "none";
  }
```

- [ ] **Step 3: Manual check — additive UI, both reports visible**

Run with emotion **disabled** (`EMOTION_ANALYSIS` unset): finish an interview → the Emotion card reads "Emotion analysis not available", chart hidden, per-question Emotion column shows "—", and every existing MediaPipe card/column is unchanged.

Then run with emotion **enabled** locally (`pip install -r backend/requirements-emotion.txt`, `EMOTION_ANALYSIS=1`): finish an interview → the Emotion card shows a dominant emotion + distribution, `emotion.png` renders, and the per-question Emotion column is populated. Expected: existing report unchanged; emotion section added alongside.

- [ ] **Step 4: Commit**

```bash
git add frontend/index.html frontend/app.js
git commit -m "feat: emotion results card, chart, per-question column, privacy notice"
```

---

## Task 10: Full verification

- [ ] **Step 1: Run the whole backend suite**

Run: `python -m pytest tests/ -q`
Expected: PASS (all tests, including the new `test_emotion.py` and report tests).

- [ ] **Step 2: Confirm the app boots without DeepFace installed**

Run: `EMOTION_ANALYSIS=0 .venv/bin/uvicorn backend.main:app` (DeepFace NOT installed in the base venv).
Expected: server starts, `/` loads, an interview completes and a report renders — proving the lazy import never triggers when disabled.

- [ ] **Step 3: Optional local smoke test with DeepFace**

In a venv with `backend/requirements-emotion.txt` installed and `EMOTION_ANALYSIS=1`, complete a short interview and confirm `sessions/<id>/emotion.png` exists and the emotion card is populated. (Not part of CI — heavy.)

---

## Self-review notes

- **Spec coverage:** §4 flow → Tasks 1-9; §5 capture → Tasks 7-8; §6 module/flag/deps → Tasks 2,3,6; §7 report/UI/shapes → Tasks 4,5,9; §8 privacy → Tasks 2 (in-memory), 9 (notice); §9 testing → Tasks 1-5,10. All covered.
- **Graceful degradation** verified by tests in Tasks 3-4 and manual checks in Tasks 8-10.
- **Type consistency:** `aggregate_emotions`/`score_emotions`/`EMOTION_CLASSES` names and the `{available, dominant, overall_distribution, per_question, timeline}` shape are identical across backend, report, and frontend tasks.
