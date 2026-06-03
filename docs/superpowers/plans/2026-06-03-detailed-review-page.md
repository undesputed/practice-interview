# Detailed Review Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the results page into a detailed, honest breakdown of all producible MediaPipe signals — grouped by category, with new derived metrics (expression detail, gaze breakdown, head-pose stats, four composite scores, transcript timing) and a large full-width chart.

**Architecture:** New pure metric functions in `backend/analysis.py` (TDD), merged into the existing `_metric_block`; transcript-timing computed in `main.py`; a bigger multi-series matplotlib chart; a redesigned results screen (layout via `frontend-design`, data binding in `app.js`). Infeasible items are omitted (see `docs/features/mediapipe-limitations.md`).

**Tech Stack:** Python 3.9, FastAPI, pytest, matplotlib; vanilla JS, MediaPipe blendshapes.

**Spec:** `docs/superpowers/specs/2026-06-03-detailed-review-page-design.md`

---

## MetricBlock additions (produced by `_metric_block`, per-question + overall)

Existing keys stay. New keys: `face_presence_pct`, `eye_openness`, `mouth_open_mean`,
`speaking_pct`, `eyebrow_raise`, `gaze_breakdown` (`{center_pct,left_pct,right_pct,up_pct,down_pct}`),
`head_pose` (`{pitch:{mean,min,max}, yaw:{...}, roll:{...}}`), `attention`, `confidence`,
`nervousness`, `composure`. Top-level `summary.timing` (`{speaking_pct, mean_response_sec,
per_question_response_sec}`) is added in `main.py`.

---

# Phase 1 — Backend metrics (TDD)

## Task 1: Expression detail + face presence

**Files:** Modify `backend/analysis.py`; Modify `tests/test_analysis.py`

- [ ] **Step 1: Append tests to `tests/test_analysis.py`**

```python
from backend.analysis import expression_detail

def _frame_x(t, face=True, blink=0.0, jaw=0.0, brow=0.0):
    f = _frame(t, face=face, blinkL=blink, blinkR=blink)
    f["bs"]["jawOpen"] = jaw
    f["bs"]["browInnerUp"] = brow
    f["bs"]["browOuterUpLeft"] = brow
    f["bs"]["browOuterUpRight"] = brow
    return f

def test_expression_detail_basic():
    frames = [_frame_x(i*100.0, blink=0.0, jaw=0.4, brow=0.5) for i in range(5)]
    out = expression_detail(frames)
    assert out["eye_openness"] == 1.0           # 1 - blink(0)
    assert out["speaking_pct"] == 100.0         # jaw 0.4 > 0.2 threshold
    assert abs(out["mouth_open_mean"] - 0.4) < 1e-6
    assert abs(out["eyebrow_raise"] - 0.5) < 1e-6

def test_expression_detail_no_face_safe():
    out = expression_detail([_frame_x(i*100.0, face=False) for i in range(3)])
    assert out == {"eye_openness": 0.0, "mouth_open_mean": 0.0, "speaking_pct": 0.0, "eyebrow_raise": 0.0}
```

- [ ] **Step 2: Run to verify fail**

Run: `. .venv/bin/activate && pytest tests/test_analysis.py -k expression_detail -v`
Expected: FAIL (ImportError).

- [ ] **Step 3: Implement** — add constant near the others and the function in `backend/analysis.py`:

```python
SPEAKING_OPEN = 0.2  # jawOpen above this counts as mouth-open / speaking


def expression_detail(frames: list[dict]) -> dict:
    """Eye openness, mouth-open/speaking, eyebrow raise from face-bearing frames."""
    total = len(frames)
    face = [f for f in frames if f.get("face", False) and "bs" in f]
    if not face:
        return {"eye_openness": 0.0, "mouth_open_mean": 0.0, "speaking_pct": 0.0, "eyebrow_raise": 0.0}
    eye_open, mouth, brow, speaking = [], [], [], 0
    for f in face:
        bs = f["bs"]
        eye_open.append(1.0 - max(bs.get("eyeBlinkLeft", 0.0), bs.get("eyeBlinkRight", 0.0)))
        jo = bs.get("jawOpen", 0.0)
        mouth.append(jo)
        if jo > SPEAKING_OPEN:
            speaking += 1
        brow.append((bs.get("browInnerUp", 0.0) + bs.get("browOuterUpLeft", 0.0)
                     + bs.get("browOuterUpRight", 0.0)) / 3.0)
    n = len(face)
    return {"eye_openness": round(sum(eye_open) / n, 3),
            "mouth_open_mean": round(sum(mouth) / n, 3),
            "speaking_pct": round(100.0 * speaking / total, 1),
            "eyebrow_raise": round(sum(brow) / n, 3)}
```

- [ ] **Step 4: Run to verify pass**

Run: `pytest tests/test_analysis.py -k expression_detail -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/analysis.py tests/test_analysis.py
git commit -m "feat: expression detail metrics (eye/mouth openness, speaking, eyebrow)"
```

---

## Task 2: Gaze breakdown

**Files:** Modify `backend/analysis.py`; Modify `tests/test_analysis.py`

- [ ] **Step 1: Append tests**

```python
from backend.analysis import gaze_breakdown

def test_gaze_breakdown_center_and_left():
    center = [_frame(i*100.0, look_out=0.0) for i in range(5)]    # all eyeLook ~0 -> center
    out = gaze_breakdown(center)
    assert out["center_pct"] == 100.0
    # look_out sets eyeLookOutLeft+Right=0.8 -> "left" dominant (eyeLookOutLeft)
    left = [_frame(i*100.0, look_out=0.8) for i in range(5)]
    out2 = gaze_breakdown(left)
    assert out2["left_pct"] == 100.0
    assert out2["center_pct"] == 0.0
```

- [ ] **Step 2: Run to verify fail**

Run: `pytest tests/test_analysis.py -k gaze_breakdown -v`
Expected: FAIL (ImportError).

- [ ] **Step 3: Implement** in `backend/analysis.py`:

```python
def gaze_breakdown(frames: list[dict]) -> dict:
    """% of frames per dominant gaze direction (center/left/right/up/down). Denominator = total."""
    counts = {"center": 0, "left": 0, "right": 0, "up": 0, "down": 0}
    total = len(frames)
    if total == 0:
        return {k + "_pct": 0.0 for k in counts}
    for f in frames:
        if not f.get("face", False):
            continue
        bs = f.get("bs", {})
        dirs = {
            "left": max(bs.get("eyeLookOutLeft", 0.0), bs.get("eyeLookInRight", 0.0)),
            "right": max(bs.get("eyeLookOutRight", 0.0), bs.get("eyeLookInLeft", 0.0)),
            "up": max(bs.get("eyeLookUpLeft", 0.0), bs.get("eyeLookUpRight", 0.0)),
            "down": max(bs.get("eyeLookDownLeft", 0.0), bs.get("eyeLookDownRight", 0.0)),
        }
        if max(dirs.values()) < GAZE_MAX:
            counts["center"] += 1
        else:
            counts[max(dirs, key=dirs.get)] += 1
    return {k + "_pct": round(100.0 * v / total, 1) for k, v in counts.items()}
```

- [ ] **Step 4: Run to verify pass**

Run: `pytest tests/test_analysis.py -k gaze_breakdown -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/analysis.py tests/test_analysis.py
git commit -m "feat: gaze direction breakdown metric"
```

---

## Task 3: Head-pose stats

**Files:** Modify `backend/analysis.py`; Modify `tests/test_analysis.py`

- [ ] **Step 1: Append tests**

```python
from backend.analysis import head_pose_stats

def test_head_pose_stats():
    frames = [_frame(i*100.0, yaw_deg=10.0) for i in range(3)]
    out = head_pose_stats(frames)
    assert abs(out["yaw"]["mean"] - 10.0) < 0.5
    assert out["yaw"]["min"] <= out["yaw"]["max"]
    assert out["pitch"]["mean"] == 0.0

def test_head_pose_stats_empty():
    out = head_pose_stats([_frame(i*100.0, face=False) for i in range(2)])
    assert out["yaw"] == {"mean": 0.0, "min": 0.0, "max": 0.0}
```

- [ ] **Step 2: Run to verify fail**

Run: `pytest tests/test_analysis.py -k head_pose_stats -v`
Expected: FAIL (ImportError).

- [ ] **Step 3: Implement** in `backend/analysis.py`:

```python
def head_pose_stats(frames: list[dict]) -> dict:
    """Mean and (min,max) of pitch/yaw/roll over face frames with a matrix."""
    p, y, r = [], [], []
    for f in frames:
        if not f.get("face", False) or "m" not in f:
            continue
        pitch, yaw, roll = matrix_to_euler(f["m"])
        p.append(pitch); y.append(yaw); r.append(roll)

    def stats(v):
        if not v:
            return {"mean": 0.0, "min": 0.0, "max": 0.0}
        return {"mean": round(sum(v) / len(v), 1), "min": round(min(v), 1), "max": round(max(v), 1)}

    return {"pitch": stats(p), "yaw": stats(y), "roll": stats(r)}
```

- [ ] **Step 4: Run to verify pass**

Run: `pytest tests/test_analysis.py -k head_pose_stats -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/analysis.py tests/test_analysis.py
git commit -m "feat: head-pose stats (pitch/yaw/roll mean and range)"
```

---

## Task 4: Composite scores

**Files:** Modify `backend/analysis.py`; Modify `tests/test_analysis.py`

- [ ] **Step 1: Append tests**

```python
from backend.analysis import composite_scores

def test_composite_scores_ranges_and_logic():
    good = {"gaze_eye_contact_pct": 100.0, "steadiness_score": 100.0, "face_presence_pct": 100.0,
            "upright_pct": 100.0, "body_steadiness": 100.0, "blinks_per_min": 5.0,
            "face_touch_count": 0, "hand_fidget": 0.0}
    s = composite_scores(good)
    assert s["attention"] == 100.0
    assert s["confidence"] == 100.0
    assert s["composure"] == 100.0
    assert s["nervousness"] < 40.0          # calm inputs -> low nervousness
    nervous = {"gaze_eye_contact_pct": 10.0, "steadiness_score": 20.0, "face_presence_pct": 80.0,
               "upright_pct": 30.0, "body_steadiness": 30.0, "blinks_per_min": 30.0,
               "face_touch_count": 5, "hand_fidget": 0.05}
    assert composite_scores(nervous)["nervousness"] > 70.0
    for k in ("attention", "confidence", "nervousness", "composure"):
        assert 0.0 <= composite_scores(nervous)[k] <= 100.0
```

- [ ] **Step 2: Run to verify fail**

Run: `pytest tests/test_analysis.py -k composite_scores -v`
Expected: FAIL (ImportError).

- [ ] **Step 3: Implement** in `backend/analysis.py`:

```python
def composite_scores(m: dict) -> dict:
    """Heuristic 0-100 interview indicators derived from base metrics. Supplementary, tunable."""
    def clamp(x):
        return round(max(0.0, min(100.0, x)), 1)
    gaze = m.get("gaze_eye_contact_pct", 0.0)
    head = m.get("steadiness_score", 0.0)
    body = m.get("body_steadiness", 0.0)
    presence = m.get("face_presence_pct", 0.0)
    upright = m.get("upright_pct", 0.0)
    bpm = m.get("blinks_per_min", 0.0)
    touch = m.get("face_touch_count", 0)
    fidget = m.get("hand_fidget", 0.0)
    return {
        "attention": clamp(0.5 * gaze + 0.3 * head + 0.2 * presence),
        "confidence": clamp(0.5 * upright + 0.5 * body),
        "nervousness": clamp(0.3 * min(100.0, bpm * 5.0) + 0.3 * (100.0 - gaze)
                             + 0.2 * min(100.0, touch * 20.0) + 0.2 * min(100.0, fidget * 2000.0)),
        "composure": clamp((head + body) / 2.0),
    }
```

- [ ] **Step 4: Run to verify pass**

Run: `pytest tests/test_analysis.py -k composite_scores -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/analysis.py tests/test_analysis.py
git commit -m "feat: heuristic composite scores (attention/confidence/nervousness/composure)"
```

---

## Task 5: Merge new metrics into `_metric_block`

**Files:** Modify `backend/analysis.py`; Modify `tests/test_analysis.py`

- [ ] **Step 1: Append test**

```python
def test_metric_block_detailed_keys():
    p = _pose(0.2)
    frames = [_frame_x(i*100.0, jaw=0.4, brow=0.3) for i in range(4)]
    for f in frames: f["pose"] = p; f["hands"] = [_hand(0.4, 0.7)]
    m = compute_metrics(frames)["overall"]
    for k in ("face_presence_pct", "eye_openness", "mouth_open_mean", "speaking_pct",
              "eyebrow_raise", "gaze_breakdown", "head_pose",
              "attention", "confidence", "nervousness", "composure"):
        assert k in m, f"missing {k}"
    assert "center_pct" in m["gaze_breakdown"]
    assert "mean" in m["head_pose"]["yaw"]

def test_metric_block_empty_detailed_keys():
    m = compute_metrics([])["overall"]
    assert m["eye_openness"] == 0.0 and m["attention"] == 0.0
    assert m["gaze_breakdown"]["center_pct"] == 0.0
    assert m["head_pose"]["pitch"] == {"mean": 0.0, "min": 0.0, "max": 0.0}
```

- [ ] **Step 2: Run to verify fail**

Run: `pytest tests/test_analysis.py -k "metric_block_detailed" -v`
Expected: FAIL (keys missing).

- [ ] **Step 3: Implement** in `backend/analysis.py` `_metric_block`:

(a) Replace the empty-frames early-return dict with one that includes the new keys:
```python
        return {"gaze_eye_contact_pct": 0.0, "head_movement": 0.0, "steadiness_score": 0.0,
                "mean_smile": 0.0, "pct_smiling": 0.0, "peak_smile": 0.0,
                "blink_count": 0, "blinks_per_min": 0.0,
                "upright_pct": 0.0, "lean": 0.0, "body_steadiness": 0.0,
                "hand_fidget": 0.0, "face_touch_count": 0,
                "face_presence_pct": 0.0, "eye_openness": 0.0, "mouth_open_mean": 0.0,
                "speaking_pct": 0.0, "eyebrow_raise": 0.0,
                "gaze_breakdown": gaze_breakdown([]), "head_pose": head_pose_stats([]),
                "attention": 0.0, "confidence": 0.0, "nervousness": 0.0, "composure": 0.0}
```

(b) Replace the non-empty `block = {...}` / `block.update(...)` / `return block` tail with:
```python
    faces = sum(1 for f in frames if f.get("face", False))
    block = {"gaze_eye_contact_pct": gaze_eye_contact_pct(frames),
             "head_movement": round(movement, 2), "steadiness_score": round(steadiness, 1),
             "mean_smile": mean_smile, "pct_smiling": pct_smiling, "peak_smile": peak_smile,
             "blink_count": blink_count, "blinks_per_min": blinks_per_min,
             "face_presence_pct": round(100.0 * faces / total, 1)}
    block.update(pose_metrics(frames))
    block.update(hand_metrics(frames))
    block.update(expression_detail(frames))
    block["gaze_breakdown"] = gaze_breakdown(frames)
    block["head_pose"] = head_pose_stats(frames)
    block.update(composite_scores(block))
    return block
```

- [ ] **Step 4: Run full analysis suite, then whole suite**

Run: `pytest tests/test_analysis.py -v` then `pytest -q`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add backend/analysis.py tests/test_analysis.py
git commit -m "feat: merge detailed + composite metrics into metric block"
```

---

## Task 6: Transcript timing + wire into summary

**Files:** Modify `backend/analysis.py`; Modify `backend/main.py`; Modify `tests/test_analysis.py`, `tests/test_main.py`

- [ ] **Step 1: Append analysis test**

```python
from backend.analysis import transcript_metrics

def test_transcript_metrics_timing():
    segs = [
        {"speaker": "interviewer", "text": "Q1", "t": 0.0},
        {"speaker": "candidate", "text": "A1", "t": 2000.0},
        {"speaker": "interviewer", "text": "Q2", "t": 6000.0},
        {"speaker": "candidate", "text": "A2", "t": 9000.0},
    ]
    out = transcript_metrics(segs)
    assert out["per_question_response_sec"] == [2.0, 3.0]   # 2000ms, 3000ms latencies
    assert out["mean_response_sec"] == 2.5
    assert out["speaking_pct"] > 0.0

def test_transcript_metrics_empty():
    assert transcript_metrics([]) == {"speaking_pct": 0.0, "mean_response_sec": 0.0, "per_question_response_sec": []}
```

- [ ] **Step 2: Run to verify fail**

Run: `pytest tests/test_analysis.py -k transcript_metrics -v`
Expected: FAIL (ImportError).

- [ ] **Step 3: Implement `transcript_metrics`** in `backend/analysis.py`:

```python
def transcript_metrics(segments: list[dict]) -> dict:
    """Speaking-vs-listening split and response latencies from transcript segment timestamps (ms)."""
    if not segments:
        return {"speaking_pct": 0.0, "mean_response_sec": 0.0, "per_question_response_sec": []}
    speak_ms, total_ms, responses = 0.0, 0.0, []
    for i, seg in enumerate(segments):
        t = seg.get("t", 0.0)
        nxt = segments[i + 1].get("t", t) if i + 1 < len(segments) else t
        dur = max(0.0, nxt - t)
        total_ms += dur
        if seg.get("speaker") == "candidate":
            speak_ms += dur
        if seg.get("speaker") == "interviewer":
            for j in range(i + 1, len(segments)):
                if segments[j].get("speaker") == "candidate":
                    responses.append(round((segments[j].get("t", t) - t) / 1000.0, 2))
                    break
    return {"speaking_pct": round(100.0 * speak_ms / total_ms, 1) if total_ms > 0 else 0.0,
            "mean_response_sec": round(sum(responses) / len(responses), 2) if responses else 0.0,
            "per_question_response_sec": responses}
```

- [ ] **Step 4: Wire into `backend/main.py`** — change the import line:
```python
from backend.analysis import compute_metrics, questions_from_transcript
```
to:
```python
from backend.analysis import compute_metrics, questions_from_transcript, transcript_metrics
```
And in `session`, right after `summary = compute_metrics(req.frames, questions)`, add:
```python
    summary["timing"] = transcript_metrics(req.transcript.get("segments", []))
```

- [ ] **Step 5: Append `tests/test_main.py` test** (verifies summary carries timing)

```python
def test_session_summary_has_timing(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "")  # skip coaching
    body = {"role": "X", "frames": [_frame(i*100.0) for i in range(5)],
            "transcript": {"full_text": "INTERVIEWER: hi",
                           "segments": [{"speaker": "interviewer", "text": "hi", "t": 0.0},
                                        {"speaker": "candidate", "text": "yo", "t": 1500.0}]}}
    data = client.post("/api/session", json=body).json()
    assert "timing" in data["summary"]
    assert data["summary"]["timing"]["per_question_response_sec"] == [1.5]
```

- [ ] **Step 6: Run** `pytest -q` → all pass.

- [ ] **Step 7: Commit**

```bash
git add backend/analysis.py backend/main.py tests/test_analysis.py tests/test_main.py
git commit -m "feat: transcript timing metrics (speaking %, response latency) in summary"
```

---

# Phase 2 — Report

## Task 7: Bigger multi-series chart

**Files:** Modify `backend/report.py`

- [ ] **Step 1: Implement** — in `_build_charts`, after the existing series are gathered, also collect mouth-open and gaze-on series, and render a taller 4-row figure. Replace the figure-building block (from `fig, (ax1, ax2, ax3) = plt.subplots(...)` through `plt.close(fig)`) with:

```python
    mouth, gaze_on, ts_face = [], [], []
    for f in frames:
        bs = f.get("bs", {})
        mouth.append(bs.get("jawOpen", 0.0))
        horiz = max(bs.get("eyeLookOutLeft", 0), bs.get("eyeLookOutRight", 0),
                    bs.get("eyeLookInLeft", 0), bs.get("eyeLookInRight", 0))
        vert = max(bs.get("eyeLookUpLeft", 0), bs.get("eyeLookUpRight", 0),
                   bs.get("eyeLookDownLeft", 0), bs.get("eyeLookDownRight", 0))
        gaze_on.append(1 if (f.get("face") and horiz < GAZE_MAX and vert < GAZE_MAX) else 0)
        ts_face.append(f["t"] / 1000.0)

    fig, (ax1, ax2, ax3, ax4) = plt.subplots(4, 1, figsize=(14, 11), sharex=True)
    ax1.plot(ts, smile, label="smile"); ax1.plot(ts_face, mouth, label="mouth open", alpha=0.7)
    ax1.axhline(SMILE_THRESHOLD, ls="--", lw=0.8, color="gray")
    ax1.set_ylabel("expression"); ax1.legend(loc="upper right")
    ax2.plot(ts, yaw_s, label="yaw"); ax2.plot(ts, pitch_s, label="pitch")
    ax2.set_ylabel("head °"); ax2.legend(loc="upper right")
    if ts_pose:
        ax3.step(ts_pose, upright_series, where="post", label="upright (1/0)")
    ax3.set_ylabel("posture"); ax3.legend(loc="upper right")
    ax4.step(ts_face, gaze_on, where="post", color="teal", label="gaze on-camera (1/0)")
    ax4.set_ylabel("gaze"); ax4.set_xlabel("seconds"); ax4.legend(loc="upper right")
    for b in boundaries:
        for ax in (ax1, ax2, ax3, ax4):
            ax.axvline(b, color="red", lw=0.6, alpha=0.5)
    fig.suptitle("Interview timeline (red = new question)")
    fig.tight_layout()
    fig.savefig(path, dpi=120)
    plt.close(fig)
```

Also update the import line to include `GAZE_MAX`:
```python
from backend.analysis import matrix_to_euler, SMILE_THRESHOLD, GAZE_MAX, UPRIGHT_RATIO
```
(`GAZE_MAX` may already be imported from a prior task — if so, leave it.)

- [ ] **Step 2: Run** `pytest tests/test_report.py -v` → PASS (still writes charts.png).

- [ ] **Step 3: Commit**

```bash
git add backend/report.py
git commit -m "feat: larger 4-panel timeline chart (expression/head/posture/gaze)"
```

---

# Phase 3 — Frontend

## Task 8: Config — new blendshapes

**Files:** Modify `frontend/config.js`

- [ ] **Step 1: Implement** — in the `BLENDSHAPES` array, add the three new names. Change:
```javascript
    "eyeLookUpLeft", "eyeLookUpRight", "eyeLookDownLeft", "eyeLookDownRight"],
```
to:
```javascript
    "eyeLookUpLeft", "eyeLookUpRight", "eyeLookDownLeft", "eyeLookDownRight",
    "jawOpen", "browOuterUpLeft", "browOuterUpRight"],
```

- [ ] **Step 2: Verify & commit**

```bash
node --check frontend/config.js
git add frontend/config.js
git commit -m "feat: capture jawOpen + browOuterUp blendshapes"
```

---

## Task 9: `app.js renderResults` — chips, category cards, table

**Files:** Modify `frontend/app.js`

The redesigned `index.html` (Task 10) exposes these element IDs that `renderResults` fills:
score-chip values `#chip-attention #chip-confidence #chip-nervousness #chip-composure`; card
lists `#card-eye #card-head #card-expression #card-posture #card-engagement #card-presence`
(each a `<ul>`); `#metrics-per-question` (tbody); `#chart-img`; `#coaching`; `#saved-path`.

- [ ] **Step 1: Implement** — replace the ENTIRE current `renderResults(data) { ... }` function with:

```javascript
function fillList(id, lines) {
  const el = $(id);
  if (!el) return;
  while (el.firstChild) el.removeChild(el.firstChild);
  for (const text of lines) {
    const li = document.createElement("li");
    li.textContent = text;
    el.appendChild(li);
  }
}

function renderResults(data) {
  const s = data.summary, o = s.overall, t = s.timing || {};
  const setChip = (id, v) => { const e = $(id); if (e) e.textContent = (v == null ? "—" : v); };
  setChip("chip-attention", o.attention);
  setChip("chip-confidence", o.confidence);
  setChip("chip-nervousness", o.nervousness);
  setChip("chip-composure", o.composure);

  const gb = o.gaze_breakdown || {};
  const hp = o.head_pose || { pitch: {}, yaw: {}, roll: {} };
  fillList("card-eye", [
    `Eye contact (gaze): ${o.gaze_eye_contact_pct}%`,
    `Gaze — center ${gb.center_pct}% · L ${gb.left_pct}% · R ${gb.right_pct}% · U ${gb.up_pct}% · D ${gb.down_pct}%`,
    `Blinks: ${o.blink_count} (${o.blinks_per_min}/min)`,
    `Eye openness: ${o.eye_openness}`,
  ]);
  fillList("card-head", [
    `Pitch: ${hp.pitch.mean}° (${hp.pitch.min}…${hp.pitch.max})`,
    `Yaw: ${hp.yaw.mean}° (${hp.yaw.min}…${hp.yaw.max})`,
    `Roll: ${hp.roll.mean}° (${hp.roll.min}…${hp.roll.max})`,
    `Head steadiness: ${o.steadiness_score}/100 (movement ${o.head_movement})`,
  ]);
  fillList("card-expression", [
    `Smile: mean ${o.mean_smile}, peak ${o.peak_smile} (${o.pct_smiling}% of time)`,
    `Eyebrow raise: ${o.eyebrow_raise}`,
    `Mouth open: ${o.mouth_open_mean} · speaking ${o.speaking_pct}%`,
  ]);
  fillList("card-posture", [
    `Upright posture: ${o.upright_pct}%`,
    `Lateral lean: ${o.lean}°`,
    `Body steadiness: ${o.body_steadiness}/100`,
    `Hand fidget: ${o.hand_fidget} · face-touches: ${o.face_touch_count}`,
  ]);
  fillList("card-engagement", [
    `Speaking vs listening: ${t.speaking_pct ?? 0}% speaking`,
    `Mean response time: ${t.mean_response_sec ?? 0}s`,
  ]);
  fillList("card-presence", [
    `Face present: ${o.face_presence_pct}%`,
    `No-face: ${s.no_face_pct}%`,
  ]);

  const tb = $("metrics-per-question");
  while (tb.firstChild) tb.removeChild(tb.firstChild);
  const rt = t.per_question_response_sec || [];
  for (const q of s.per_question) {
    const tr = document.createElement("tr");
    for (const cell of [q.question, `${q.metrics.gaze_eye_contact_pct}%`,
                        `${q.metrics.upright_pct}%`, `${q.metrics.composure}`,
                        rt[q.turn] != null ? `${rt[q.turn]}s` : "—",
                        `${q.metrics.face_touch_count}`]) {
      const td = document.createElement("td");
      td.textContent = cell;
      tr.appendChild(td);
    }
    tb.appendChild(tr);
  }

  $("chart-img").src = data.charts_url;
  $("saved-path").textContent = "Saved to sessions/" + data.session_id + "/";

  const co = $("coaching");
  while (co.firstChild) co.removeChild(co.firstChild);
  if (data.coaching) {
    const c = data.coaching;
    const mk = (label, value) => {
      const p = document.createElement("p");
      const b = document.createElement("strong"); b.textContent = label;
      p.appendChild(b); p.appendChild(document.createTextNode(" " + value));
      return p;
    };
    co.appendChild(mk("Score:", `${c.score ?? "—"}/10`));
    const sum = document.createElement("p"); sum.textContent = c.summary || ""; co.appendChild(sum);
    co.appendChild(mk("Strengths:", (c.strengths || []).join("; ")));
    co.appendChild(mk("Improve:", (c.improvements || []).join("; ")));
  } else {
    co.textContent = "Coaching not available (no Anthropic key or empty transcript).";
  }
}
```

- [ ] **Step 2: Verify**

Run: `node --check frontend/app.js` (ignore module note); `grep -n innerHTML frontend/app.js` → empty.
Expected: clean; no innerHTML.

- [ ] **Step 3: Commit**

```bash
git add frontend/app.js
git commit -m "feat: render detailed review (score chips, category cards, response-time column)"
```

---

## Task 10: Results-screen layout (frontend-design)

**Files:** Modify `frontend/index.html`, `frontend/style.css`

> **REQUIRED SUB-SKILL:** invoke the **`frontend-design`** skill. Build the "chart lower" layout.

- [ ] **Step 1:** Replace the `#screen-results` section markup so it contains, in order:
  1. A heading and a **score-chips** row with four chips; each chip has a label and a value span with the exact id: `#chip-attention`, `#chip-confidence`, `#chip-nervousness`, `#chip-composure`.
  2. **Six category cards**, each with a title and a `<ul>` carrying the exact id: `#card-eye` (Eye & Gaze), `#card-head` (Head Pose), `#card-expression` (Expression), `#card-posture` (Posture & Body), `#card-engagement` (Engagement), `#card-presence` (Presence). (Lay them out as a responsive grid.)
  3. The **per-question table** with `<tbody id="metrics-per-question">` and a `<thead>` of exactly 6 columns: **Question · Eye contact · Upright · Composure · Response · Face-touch**.
  4. A **big full-width chart** section containing `<img id="chart-img">` (make it span the full width, large).
  5. `<div id="coaching">`.
  6. `<p id="saved-path"></p>` and a one-line disclaimer: *"Facial/body signals are supplementary indicators, not objective emotion or identity measurements."*

  HARD CONSTRAINTS: keep the three screen containers (`#screen-start`, `#screen-interview`, `#screen-results`) and ALL other existing IDs intact (`role-select, start-btn, cam, transcript, hud-time, hud-question, hud-face, end-btn, newsession-btn`). Keep `<script type="module" src="/app.js">` and the stylesheet link. Add no scripts. Use DOM-safe structure only (no inline JS).

- [ ] **Step 2: Verify IDs**

Run:
```bash
for id in screen-start screen-interview screen-results chip-attention chip-confidence chip-nervousness chip-composure card-eye card-head card-expression card-posture card-engagement card-presence metrics-per-question chart-img coaching saved-path newsession-btn; do printf "%s " $id; grep -c "id=\"$id\"" frontend/index.html; done
```
Expected: each prints `1`. Confirm the 6 table headers and the disclaimer text are present.

- [ ] **Step 3: Commit**

```bash
git add frontend/index.html frontend/style.css
git commit -m "feat: detailed review-page layout (chips, category cards, big chart)"
```

---

## Task 11: Manual end-to-end verification

**Files:** none

- [ ] **Step 1:** `. .venv/bin/activate && pytest -q` → all pass.
- [ ] **Step 2:** `uvicorn backend.main:app --reload --port 8000`, run a short interview, end it. Confirm:
  1. Score chips (Attention/Confidence/Nervousness/Composure) populate.
  2. All six category cards show their metrics; per-question table has the Response column.
  3. The chart is large/full-width with 4 panels (expression/head/posture/gaze).
  4. `sessions/<id>/summary.json` contains the new keys + `timing`; the disclaimer shows.
- [ ] **Step 3:** Note completion.

---

## Self-Review (completed during planning)

- **Spec coverage:** new blendshapes → Task 8; expression detail → T1; gaze breakdown → T2; head-pose stats → T3; composites → T4; merge → T5; transcript timing + summary wiring → T6; bigger chart → T7; chips/cards/table render → T9; layout (chart-lower, categories, disclaimer, omit infeasible) → T10; verify → T11. Limitations doc already written and referenced.
- **Type consistency:** `MetricBlock` keys produced in T1–T5 (`face_presence_pct, eye_openness, mouth_open_mean, speaking_pct, eyebrow_raise, gaze_breakdown{center_pct,…}, head_pose{pitch{mean,min,max},…}, attention, confidence, nervousness, composure`) are consumed verbatim by `report.py` (T7) and `app.js renderResults` (T9). `summary.timing.per_question_response_sec` (T6) is read by the per-question table (T9) by `q.turn` index. The six card IDs and four chip IDs in T9 match the DOM contract in T10.
- **Placeholders:** none — all code steps are complete; only the results-screen markup/CSS is delegated to `frontend-design` with an exact ID/column contract.
