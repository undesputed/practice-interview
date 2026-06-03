# Body-Language Signals + Transcription Quality — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Improve candidate speech-to-text (sample-rate auto-match + keyterms) and add MediaPipe body-language signals — gaze-based eye contact, posture, fidget/steadiness, and face-touching — as new per-question + overall report metrics.

**Architecture:** Approach A — keep FaceLandmarker every frame (now also capturing `eyeLook*` blendshapes for gaze); add Pose + Hand landmarkers throttled to ~8/sec. The browser sends extra raw landmarks in each `Frame`; all new metrics are pure functions in `backend/analysis.py`, unit-tested. The head-pose `eye_contact_pct` is replaced by the gaze metric.

**Tech Stack:** Python 3.9, FastAPI, pytest, matplotlib; vanilla JS, `@mediapipe/tasks-vision` (FaceLandmarker + PoseLandmarker + HandLandmarker).

**Spec:** `docs/superpowers/specs/2026-06-03-body-language-and-transcription-design.md`

---

## Data Contract (extended `Frame`)

```json
{
  "t": 1234.5, "turn": 2, "face": true,
  "bs": { "mouthSmileLeft":0, "mouthSmileRight":0, "eyeBlinkLeft":0, "eyeBlinkRight":0, "browInnerUp":0,
          "eyeLookInLeft":0,"eyeLookInRight":0,"eyeLookOutLeft":0,"eyeLookOutRight":0,
          "eyeLookUpLeft":0,"eyeLookUpRight":0,"eyeLookDownLeft":0,"eyeLookDownRight":0 },
  "m": [16 floats],
  "pose": { "nose":{"x":0.5,"y":0.3,"visibility":0.9}, "leftShoulder":{...}, "rightShoulder":{...},
            "leftEar":{...}, "rightEar":{...}, "leftHip":{...}, "rightHip":{...} },
  "hands": [ { "handedness":"Left", "wrist":{"x":0.4,"y":0.7}, "indexTip":{"x":..,"y":..}, "middleTip":{"x":..,"y":..} } ]
}
```
- `pose` and `hands` appear only on throttled body-frames; otherwise the key is **absent** (treat as `None`/missing).
- All coords are MediaPipe normalized image space: `x` right, `y` **down**, range ~[0,1].

**`MetricBlock` after this change** (per-question and overall): drops `eye_contact_pct`; keeps `head_movement`, `steadiness_score`, `mean_smile`, `pct_smiling`, `peak_smile`, `blink_count`, `blinks_per_min`; adds `gaze_eye_contact_pct`, `upright_pct`, `lean`, `body_steadiness`, `hand_fidget`, `face_touch_count`.

---

# Phase 0 — Transcription quick wins

## Task 1: Deepgram keyterms

**Files:**
- Modify: `backend/deepgram.py`
- Test: `tests/test_deepgram.py`

- [ ] **Step 1: Write the failing test** (append to `tests/test_deepgram.py`)

```python
def test_agent_config_includes_keyterms_with_role():
    cfg = build_agent_config("Data Analyst")
    kt = cfg["agent"]["listen"]["provider"].get("keyterms")
    assert isinstance(kt, list)
    assert "Data Analyst" in kt        # role is boosted
    assert "STAR" in kt                # generic interview term
```

- [ ] **Step 2: Run test to verify it fails**

Run: `. .venv/bin/activate && pytest tests/test_deepgram.py -k keyterms -v`
Expected: FAIL (`keyterms` is `None`).

- [ ] **Step 3: Implement** — in `backend/deepgram.py`, change the `listen` line inside `build_agent_config`:

Replace:
```python
            "listen": {"provider": {"type": "deepgram", "model": "nova-3"}},
```
with:
```python
            "listen": {"provider": {"type": "deepgram", "model": "nova-3",
                                    "keyterms": ["STAR", "behavioral", "strengths", "weaknesses", role]}},
```

- [ ] **Step 4: Run tests**

Run: `pytest tests/test_deepgram.py -v`
Expected: PASS (all, including the existing config/greeting tests).

- [ ] **Step 5: Commit**

```bash
git add backend/deepgram.py tests/test_deepgram.py
git commit -m "feat: add nova-3 keyterms to boost interview transcription"
```

---

## Task 2: Frontend mic sample-rate auto-match

**Files:**
- Modify: `frontend/app.js` (inside `startInterview`, around the token fetch / agent start)

- [ ] **Step 1: Implement** — in `frontend/app.js`, find the block that creates the input context inside `startVoiceAgent`… NOTE: the input `AudioContext` is created inside `deepgram-client.js`, so the actual rate isn't known in `app.js` before the agent starts. Instead, fix it where the context is created. In `frontend/deepgram-client.js`, inside `ws.onopen`, BEFORE `ws.send(JSON.stringify(config))`, set the real input rate on the config:

Replace (in `deepgram-client.js` `ws.onopen`):
```javascript
    inCtx.resume().catch(() => {});
    outCtx.resume().catch(() => {});
    ws.send(JSON.stringify(config)); // Settings first
```
with:
```javascript
    inCtx.resume().catch(() => {});
    outCtx.resume().catch(() => {});
    // Tell Deepgram the ACTUAL input sample rate (browsers may not honor 48k) to avoid
    // mislabeled PCM that garbles transcription.
    if (config && config.audio && config.audio.input) {
      config.audio.input.sample_rate = inCtx.sampleRate;
    }
    console.log("[dg] input sample_rate =", inCtx.sampleRate);
    ws.send(JSON.stringify(config)); // Settings first
```

- [ ] **Step 2: Verify syntax**

Run: `node --check frontend/deepgram-client.js` (ignore module import/export notes).
Expected: no syntax error.

- [ ] **Step 3: Commit**

```bash
git add frontend/deepgram-client.js
git commit -m "fix: send actual mic sample rate to Deepgram to fix garbled transcription"
```

> Manual verify later: the server/browser log shows the real rate; candidate transcription is cleaner.

---

# Phase 1 — Backend metrics (TDD)

## Task 3: Gaze-based eye contact (replaces head-pose eye contact)

**Files:**
- Modify: `backend/analysis.py`
- Modify: `tests/test_analysis.py`

- [ ] **Step 1: Update the test helper and rewrite the eye-contact tests.** In `tests/test_analysis.py`, REPLACE the existing `_frame` helper with this version (adds `eyeLook` + pose/hands support used by later tasks; existing callers keep working via defaults):

```python
def _frame(t, turn=0, face=True, yaw_deg=0.0, smileL=0.0, smileR=0.0,
           blinkL=0.0, blinkR=0.0, look_out=0.0, look_up=0.0, pose=None, hands=None):
    import math
    a = math.radians(yaw_deg)
    c, s = math.cos(a), math.sin(a)
    m = [c,0,s,0, 0,1,0,0, -s,0,c,0, 0,0,0,1]
    bs = {"mouthSmileLeft": smileL, "mouthSmileRight": smileR,
          "eyeBlinkLeft": blinkL, "eyeBlinkRight": blinkR, "browInnerUp": 0.0,
          "eyeLookInLeft": 0.0, "eyeLookInRight": 0.0,
          "eyeLookOutLeft": look_out, "eyeLookOutRight": look_out,
          "eyeLookUpLeft": look_up, "eyeLookUpRight": look_up,
          "eyeLookDownLeft": 0.0, "eyeLookDownRight": 0.0}
    f = {"t": t, "turn": turn, "face": face, "bs": bs, "m": m}
    if pose is not None: f["pose"] = pose
    if hands is not None: f["hands"] = hands
    return f
```

Then REPLACE the three head-pose eye-contact tests (`test_eye_contact_all_centered`, `test_eye_contact_half_looking_away`, `test_no_face_counts_against_contact`) with these gaze tests:

```python
def test_gaze_all_centered():
    frames = [_frame(t * 100.0, look_out=0.0) for t in range(10)]
    out = compute_metrics(frames)
    assert out["overall"]["gaze_eye_contact_pct"] == 100.0

def test_gaze_half_looking_away():
    frames = [_frame(t * 100.0, look_out=0.0) for t in range(5)]
    frames += [_frame((t + 5) * 100.0, look_out=0.8) for t in range(5)]
    out = compute_metrics(frames)
    assert out["overall"]["gaze_eye_contact_pct"] == 50.0

def test_no_face_counts_against_gaze():
    frames = [_frame(t * 100.0, face=(t % 2 == 0)) for t in range(10)]
    out = compute_metrics(frames)
    assert out["no_face_pct"] == 50.0
    assert out["overall"]["gaze_eye_contact_pct"] == 50.0
```

Also update `test_per_question_segmentation` and `test_empty_frames_safe` to use gaze:
- In `test_per_question_segmentation`, change the second-turn frames from `yaw_deg=40.0` to `look_out=0.8`, and change both metric assertions from `["eye_contact_pct"]` to `["gaze_eye_contact_pct"]`.
- In `test_empty_frames_safe`, change `out["overall"]["eye_contact_pct"]` to `out["overall"]["gaze_eye_contact_pct"]`.

- [ ] **Step 2: Run to verify failure**

Run: `pytest tests/test_analysis.py -k gaze -v`
Expected: FAIL (`gaze_eye_contact_pct` not present / KeyError).

- [ ] **Step 3: Implement in `backend/analysis.py`.** Add the gaze constant near the other thresholds:

```python
GAZE_MAX = 0.5  # eyeLook* magnitude above which gaze is "off camera"
```

Add this pure function (place after `matrix_to_euler`):

```python
def gaze_eye_contact_pct(frames: list[dict]) -> float:
    """% of frames with a face whose gaze is on-camera (eyeLook* below GAZE_MAX). Denominator = total."""
    total = len(frames)
    if total == 0:
        return 0.0
    on = 0
    for f in frames:
        if not f.get("face", False):
            continue
        bs = f.get("bs", {})
        horiz = max(bs.get("eyeLookOutLeft", 0.0), bs.get("eyeLookOutRight", 0.0),
                    bs.get("eyeLookInLeft", 0.0), bs.get("eyeLookInRight", 0.0))
        vert = max(bs.get("eyeLookUpLeft", 0.0), bs.get("eyeLookUpRight", 0.0),
                   bs.get("eyeLookDownLeft", 0.0), bs.get("eyeLookDownRight", 0.0))
        if horiz < GAZE_MAX and vert < GAZE_MAX:
            on += 1
    return round(100.0 * on / total, 1)
```

In `_metric_block`, (a) in the empty-frames early return, REPLACE `"eye_contact_pct": 0.0,` with `"gaze_eye_contact_pct": 0.0,`; (b) delete the `eye_contact_pct` computation lines and the `on_camera` counter usage; (c) in the final `return`, REPLACE `"eye_contact_pct": eye_contact_pct,` with `"gaze_eye_contact_pct": gaze_eye_contact_pct(frames),`.

Concretely, the face loop's `on_camera` lines become unnecessary — change the loop body so it no longer increments `on_camera` and remove the `eye_contact_pct = round(...)` line. The poses/smiles/blink logic stays.

- [ ] **Step 4: Run to verify pass**

Run: `pytest tests/test_analysis.py -v`
Expected: PASS (matrix, gaze, smile, blink, per-question, empty, questions_from_transcript).

- [ ] **Step 5: Commit**

```bash
git add backend/analysis.py tests/test_analysis.py
git commit -m "feat: gaze-based eye contact metric, replacing head-pose proxy"
```

---

## Task 4: Pose metrics — upright, lean, body steadiness

**Files:**
- Modify: `backend/analysis.py`
- Modify: `tests/test_analysis.py`

- [ ] **Step 1: Write failing tests** (append to `tests/test_analysis.py`)

```python
from backend.analysis import pose_metrics

def _pose(nose_y, ls=(0.4, 0.5), rs=(0.6, 0.5)):
    return {"nose": {"x": 0.5, "y": nose_y, "visibility": 0.9},
            "leftShoulder": {"x": ls[0], "y": ls[1], "visibility": 0.9},
            "rightShoulder": {"x": rs[0], "y": rs[1], "visibility": 0.9},
            "leftEar": {"x": 0.45, "y": 0.3}, "rightEar": {"x": 0.55, "y": 0.3},
            "leftHip": {"x": 0.42, "y": 0.9}, "rightHip": {"x": 0.58, "y": 0.9}}

def test_upright_vs_slouched():
    # nose well above shoulders (y=0.2 vs 0.5), width=0.2 -> headRise/width = 1.5 > 0.5 -> upright
    upright = [_frame(i * 100.0, pose=_pose(0.2)) for i in range(5)]
    assert pose_metrics(upright)["upright_pct"] == 100.0
    # nose near shoulder line (y=0.48) -> headRise/width = 0.1 -> not upright
    slouch = [_frame(i * 100.0, pose=_pose(0.48)) for i in range(5)]
    assert pose_metrics(slouch)["upright_pct"] == 0.0

def test_lean_level_vs_tilted():
    level = [_frame(i * 100.0, pose=_pose(0.2, ls=(0.4, 0.5), rs=(0.6, 0.5))) for i in range(5)]
    assert pose_metrics(level)["lean"] == 0.0
    tilted = [_frame(i * 100.0, pose=_pose(0.2, ls=(0.4, 0.45), rs=(0.6, 0.55))) for i in range(5)]
    assert pose_metrics(tilted)["lean"] > 0.0

def test_body_steadiness_still_vs_moving():
    still = [_frame(i * 100.0, pose=_pose(0.2)) for i in range(5)]
    assert pose_metrics(still)["body_steadiness"] == 100.0
    moving = [_frame(i * 100.0, pose=_pose(0.2, ls=(0.4 + 0.05 * i, 0.5), rs=(0.6 + 0.05 * i, 0.5)))
              for i in range(5)]
    assert pose_metrics(moving)["body_steadiness"] < 100.0

def test_pose_metrics_no_pose_safe():
    out = pose_metrics([_frame(i * 100.0) for i in range(3)])  # no pose key
    assert out == {"upright_pct": 0.0, "lean": 0.0, "body_steadiness": 0.0}
```

- [ ] **Step 2: Run to verify failure**

Run: `pytest tests/test_analysis.py -k "pose or upright or lean or steadiness" -v`
Expected: FAIL (`pose_metrics` not defined).

- [ ] **Step 3: Implement in `backend/analysis.py`** — add constants near thresholds:

```python
UPRIGHT_RATIO = 0.5       # headRise / shoulderWidth above this = upright
BODY_FIDGET_SCALE = 2000  # maps mean normalized body movement to a 0-100 steadiness drop
```

Add the function:

```python
def pose_metrics(frames: list[dict]) -> dict:
    """Posture/lean/steadiness from pose-bearing frames. Safe (zeros) when no pose present."""
    poses = [f["pose"] for f in frames if f.get("pose")]
    if not poses:
        return {"upright_pct": 0.0, "lean": 0.0, "body_steadiness": 0.0}

    upright, tilts, centers = 0, [], []
    for p in poses:
        ls, rs, nose = p["leftShoulder"], p["rightShoulder"], p["nose"]
        mid_y = (ls["y"] + rs["y"]) / 2.0
        width = abs(ls["x"] - rs["x"]) or 1e-6
        if (mid_y - nose["y"]) / width > UPRIGHT_RATIO:
            upright += 1
        tilts.append(abs(math.degrees(math.atan2(rs["y"] - ls["y"], rs["x"] - ls["x"]))))
        centers.append(((ls["x"] + rs["x"]) / 2.0, mid_y, nose["x"], nose["y"]))

    movement = 0.0
    if len(centers) >= 2:
        d = [abs(b[0]-a[0]) + abs(b[1]-a[1]) + abs(b[2]-a[2]) + abs(b[3]-a[3])
             for a, b in zip(centers, centers[1:])]
        movement = sum(d) / len(d)
    steadiness = max(0.0, min(100.0, 100.0 - BODY_FIDGET_SCALE * movement / 100.0))

    return {"upright_pct": round(100.0 * upright / len(poses), 1),
            "lean": round(sum(tilts) / len(tilts), 1),
            "body_steadiness": round(steadiness, 1)}
```

- [ ] **Step 4: Run to verify pass**

Run: `pytest tests/test_analysis.py -k "pose or upright or lean or steadiness" -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/analysis.py tests/test_analysis.py
git commit -m "feat: pose metrics (upright, lean, body steadiness)"
```

---

## Task 5: Hand metrics — fidget & face-touch

**Files:**
- Modify: `backend/analysis.py`
- Modify: `tests/test_analysis.py`

- [ ] **Step 1: Write failing tests** (append to `tests/test_analysis.py`)

```python
from backend.analysis import hand_metrics

def _hand(wx, wy, ix=None, iy=None):
    ix = wx if ix is None else ix
    iy = wy if iy is None else iy
    return {"handedness": "Right", "wrist": {"x": wx, "y": wy},
            "indexTip": {"x": ix, "y": iy}, "middleTip": {"x": ix, "y": iy}}

def test_hand_fidget_still_vs_moving():
    still = [_frame(i * 100.0, hands=[_hand(0.4, 0.7)]) for i in range(5)]
    assert hand_metrics(still)["hand_fidget"] == 0.0
    moving = [_frame(i * 100.0, hands=[_hand(0.4 + 0.05 * i, 0.7)]) for i in range(5)]
    assert hand_metrics(moving)["hand_fidget"] > 0.0

def test_face_touch_counts_rising_edges():
    # nose at (0.5,0.3); shoulders width 0.2 -> radius = 0.6*0.2 = 0.12
    p = _pose(0.3)
    away = _frame(0.0, pose=p, hands=[_hand(0.9, 0.9)])          # far from nose
    near = _frame(100.0, pose=p, hands=[_hand(0.5, 0.32)])        # ~0.02 from nose -> touch
    seq = [away, near, away, near]                                # two rising edges
    assert hand_metrics(seq)["face_touch_count"] == 2

def test_hand_metrics_no_hands_safe():
    out = hand_metrics([_frame(i * 100.0) for i in range(3)])
    assert out == {"hand_fidget": 0.0, "face_touch_count": 0}
```

- [ ] **Step 2: Run to verify failure**

Run: `pytest tests/test_analysis.py -k "hand or face_touch" -v`
Expected: FAIL (`hand_metrics` not defined).

- [ ] **Step 3: Implement in `backend/analysis.py`** — add constant:

```python
FACE_TOUCH_RADIUS = 0.6   # × shoulder width: hand-point within this of the nose = touching
```

Add the function:

```python
def hand_metrics(frames: list[dict]) -> dict:
    """Hand fidget + face-touch onset count from hand-bearing frames. Safe (zeros) when absent."""
    hand_frames = [f for f in frames if f.get("hands") is not None]
    if not hand_frames:
        return {"hand_fidget": 0.0, "face_touch_count": 0}

    # fidget: mean wrist (first hand) displacement across consecutive frames that have a hand
    wrists = [(f["hands"][0]["wrist"] if f["hands"] else None) for f in hand_frames]
    seq = [w for w in wrists if w is not None]
    fidget = 0.0
    if len(seq) >= 2:
        d = [abs(b["x"] - a["x"]) + abs(b["y"] - a["y"]) for a, b in zip(seq, seq[1:])]
        fidget = sum(d) / len(d)

    # face-touch: hand point within radius of nose; count rising edges
    touches, prev = 0, False
    for f in hand_frames:
        hands = f.get("hands") or []
        pose = f.get("pose")
        touching = False
        if hands and pose:
            nose = pose["nose"]; ls = pose["leftShoulder"]; rs = pose["rightShoulder"]
            radius = FACE_TOUCH_RADIUS * (abs(ls["x"] - rs["x"]) or 1e-6)
            for h in hands:
                for key in ("wrist", "indexTip", "middleTip"):
                    pt = h.get(key)
                    if pt and math.hypot(pt["x"] - nose["x"], pt["y"] - nose["y"]) <= radius:
                        touching = True
        if touching and not prev:
            touches += 1
        prev = touching

    return {"hand_fidget": round(fidget, 4), "face_touch_count": touches}
```

- [ ] **Step 4: Run to verify pass**

Run: `pytest tests/test_analysis.py -k "hand or face_touch" -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/analysis.py tests/test_analysis.py
git commit -m "feat: hand metrics (fidget and face-touch count)"
```

---

## Task 6: Merge new metrics into `_metric_block`

**Files:**
- Modify: `backend/analysis.py`
- Modify: `tests/test_analysis.py`

- [ ] **Step 1: Write failing test** (append to `tests/test_analysis.py`)

```python
def test_metric_block_has_all_new_keys():
    p = _pose(0.2)
    frames = [_frame(i * 100.0, pose=p, hands=[_hand(0.4, 0.7)]) for i in range(4)]
    m = compute_metrics(frames)["overall"]
    for k in ("gaze_eye_contact_pct", "upright_pct", "lean", "body_steadiness",
              "hand_fidget", "face_touch_count", "head_movement", "steadiness_score",
              "mean_smile", "pct_smiling", "peak_smile", "blink_count", "blinks_per_min"):
        assert k in m, f"missing {k}"
    assert "eye_contact_pct" not in m   # head-pose metric removed

def test_metric_block_empty_has_new_keys():
    m = compute_metrics([])["overall"]
    assert m["upright_pct"] == 0.0 and m["hand_fidget"] == 0.0 and m["face_touch_count"] == 0
    assert m["gaze_eye_contact_pct"] == 0.0
```

- [ ] **Step 2: Run to verify failure**

Run: `pytest tests/test_analysis.py -k "metric_block" -v`
Expected: FAIL (pose/hand keys missing from the block).

- [ ] **Step 3: Implement** — in `backend/analysis.py` `_metric_block`:

(a) In the empty-frames early-return dict, add the new keys so it reads:
```python
        return {"gaze_eye_contact_pct": 0.0, "head_movement": 0.0, "steadiness_score": 0.0,
                "mean_smile": 0.0, "pct_smiling": 0.0, "peak_smile": 0.0,
                "blink_count": 0, "blinks_per_min": 0.0,
                "upright_pct": 0.0, "lean": 0.0, "body_steadiness": 0.0,
                "hand_fidget": 0.0, "face_touch_count": 0}
```

(b) Replace the final `return {...}` with a version that merges pose/hand metrics:
```python
    block = {"gaze_eye_contact_pct": gaze_eye_contact_pct(frames),
             "head_movement": round(movement, 2), "steadiness_score": round(steadiness, 1),
             "mean_smile": mean_smile, "pct_smiling": pct_smiling, "peak_smile": peak_smile,
             "blink_count": blink_count, "blinks_per_min": blinks_per_min}
    block.update(pose_metrics(frames))
    block.update(hand_metrics(frames))
    return block
```

- [ ] **Step 4: Run the FULL analysis suite**

Run: `pytest tests/test_analysis.py -v`
Expected: PASS (all).

- [ ] **Step 5: Run the WHOLE suite** (ensure main/report/deepgram still pass)

Run: `pytest -v`
Expected: PASS (all files).

- [ ] **Step 6: Commit**

```bash
git add backend/analysis.py tests/test_analysis.py
git commit -m "feat: merge gaze/pose/hand metrics into the metric block"
```

---

## Task 7: Report — CSV columns & posture/fidget chart

**Files:**
- Modify: `backend/report.py`
- Test: `tests/test_report.py`

- [ ] **Step 1: Write failing test** (append to `tests/test_report.py`)

```python
import csv as _csv

def _pose(nose_y=0.2):
    return {"nose": {"x": 0.5, "y": nose_y}, "leftShoulder": {"x": 0.4, "y": 0.5},
            "rightShoulder": {"x": 0.6, "y": 0.5}, "leftEar": {"x": 0.45, "y": 0.3},
            "rightEar": {"x": 0.55, "y": 0.3}, "leftHip": {"x": 0.42, "y": 0.9},
            "rightHip": {"x": 0.58, "y": 0.9}}

def test_csv_has_body_columns(tmp_path):
    frames = []
    for i in range(6):
        f = _frame(i * 100.0)
        f["pose"] = _pose()
        frames.append(f)
    summary = {"duration_sec": 0.5, "frame_count": 6, "no_face_pct": 0.0,
               "overall": {}, "per_question": []}
    d = str(tmp_path / "s")
    save_session(d, frames, {"full_text": "", "segments": []}, summary, None)
    with open(d + "/data.csv") as fh:
        header = next(_csv.reader(fh))
    for col in ("gaze_on", "pose_present", "upright", "hands_present"):
        assert col in header
```

NOTE: `_frame` in `tests/test_report.py` currently has no `eyeLook`/pose support. Update that file's local `_frame` helper to include the `eyeLook*` keys in `bs` (copy the bs dict from the analysis test helper) so gaze columns compute without KeyError.

- [ ] **Step 2: Run to verify failure**

Run: `pytest tests/test_report.py -v`
Expected: FAIL (new columns absent).

- [ ] **Step 3: Implement in `backend/report.py`.**

Import the helpers at the top:
```python
from backend.analysis import (matrix_to_euler, SMILE_THRESHOLD, GAZE_MAX, UPRIGHT_RATIO)
```

Replace `_write_csv` with:
```python
def _write_csv(path: str, frames: list[dict]) -> None:
    with open(path, "w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        w.writerow(["t", "turn", "face", "pitch", "yaw", "roll",
                    "smileL", "smileR", "blinkL", "blinkR",
                    "gaze_on", "pose_present", "upright", "shoulder_tilt", "hands_present"])
        for f in frames:
            pitch, yaw, roll = matrix_to_euler(f["m"]) if f.get("face") else (0, 0, 0)
            bs = f.get("bs", {})
            horiz = max(bs.get("eyeLookOutLeft", 0), bs.get("eyeLookOutRight", 0),
                        bs.get("eyeLookInLeft", 0), bs.get("eyeLookInRight", 0))
            vert = max(bs.get("eyeLookUpLeft", 0), bs.get("eyeLookUpRight", 0),
                       bs.get("eyeLookDownLeft", 0), bs.get("eyeLookDownRight", 0))
            gaze_on = int(bool(f.get("face")) and horiz < GAZE_MAX and vert < GAZE_MAX)
            p = f.get("pose")
            if p:
                import math as _m
                width = abs(p["leftShoulder"]["x"] - p["rightShoulder"]["x"]) or 1e-6
                mid_y = (p["leftShoulder"]["y"] + p["rightShoulder"]["y"]) / 2.0
                upright = int((mid_y - p["nose"]["y"]) / width > UPRIGHT_RATIO)
                tilt = round(abs(_m.degrees(_m.atan2(
                    p["rightShoulder"]["y"] - p["leftShoulder"]["y"],
                    p["rightShoulder"]["x"] - p["leftShoulder"]["x"]))), 2)
            else:
                upright, tilt = "", ""
            w.writerow([f["t"], f.get("turn"), int(bool(f.get("face"))),
                        round(pitch, 2), round(yaw, 2), round(roll, 2),
                        bs.get("mouthSmileLeft", 0), bs.get("mouthSmileRight", 0),
                        bs.get("eyeBlinkLeft", 0), bs.get("eyeBlinkRight", 0),
                        gaze_on, int(p is not None), upright, tilt,
                        int(f.get("hands") is not None)])
```

In `_build_charts`, add a third subplot for posture/fidget. Replace the `fig, (ax1, ax2) = plt.subplots(...)` line and the lines that use `ax1/ax2`/`boundaries`/`savefig` with a 3-row version:
```python
    upright_series, ts_pose = [], []
    for f in frames:
        p = f.get("pose")
        if p:
            width = abs(p["leftShoulder"]["x"] - p["rightShoulder"]["x"]) or 1e-6
            mid_y = (p["leftShoulder"]["y"] + p["rightShoulder"]["y"]) / 2.0
            upright_series.append(1 if (mid_y - p["nose"]["y"]) / width > UPRIGHT_RATIO else 0)
            ts_pose.append(f["t"] / 1000.0)

    fig, (ax1, ax2, ax3) = plt.subplots(3, 1, figsize=(10, 8), sharex=True)
    ax1.plot(ts, smile, label="smile")
    ax1.axhline(SMILE_THRESHOLD, ls="--", lw=0.8, color="gray")
    ax1.set_ylabel("smile"); ax1.legend(loc="upper right")
    ax2.plot(ts, yaw_s, label="yaw"); ax2.plot(ts, pitch_s, label="pitch")
    ax2.set_ylabel("degrees"); ax2.legend(loc="upper right")
    if ts_pose:
        ax3.step(ts_pose, upright_series, where="post", label="upright (1/0)")
    ax3.set_ylabel("posture"); ax3.set_xlabel("seconds"); ax3.legend(loc="upper right")
    for b in boundaries:
        for ax in (ax1, ax2, ax3):
            ax.axvline(b, color="red", lw=0.6, alpha=0.5)
    fig.suptitle("Interview timeline (red = new question)")
    fig.tight_layout()
    fig.savefig(path, dpi=100)
    plt.close(fig)
```

- [ ] **Step 4: Run to verify pass**

Run: `pytest tests/test_report.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/report.py tests/test_report.py
git commit -m "feat: report CSV body columns and posture/fidget chart panel"
```

---

# Phase 1 — Frontend capture & UI

## Task 8: Frontend config — models, throttle, blendshapes

**Files:**
- Modify: `frontend/config.js`

- [ ] **Step 1: Implement** — replace `frontend/config.js` with:

```javascript
// frontend/config.js
export const CONFIG = {
  WASM_BASE: "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm",
  MODEL_URL: "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
  POSE_MODEL_URL: "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task",
  HAND_MODEL_URL: "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
  POSE_THROTTLE_MS: 120,  // run pose + hands ~8x/sec
  // Blendshapes forwarded to the backend (smile, blink, brow, and 8 eyeLook* for gaze)
  BLENDSHAPES: ["mouthSmileLeft", "mouthSmileRight", "eyeBlinkLeft", "eyeBlinkRight", "browInnerUp",
    "eyeLookInLeft", "eyeLookInRight", "eyeLookOutLeft", "eyeLookOutRight",
    "eyeLookUpLeft", "eyeLookUpRight", "eyeLookDownLeft", "eyeLookDownRight"],
  ROLES: ["Software Engineer", "Product Manager", "Data Analyst", "Customer Support"],
};
```

- [ ] **Step 2: Verify & commit**

```bash
node --check frontend/config.js
git add frontend/config.js
git commit -m "feat: config for pose/hand models, throttle, and eyeLook blendshapes"
```

---

## Task 9: Landmark extraction helpers

**Files:**
- Create: `frontend/landmarks.js`

- [ ] **Step 1: Implement** — create `frontend/landmarks.js`:

```javascript
// frontend/landmarks.js
// Extract the small set of pose/hand keypoints we send to the backend (normalized image coords).
const POSE_IDX = { nose: 0, leftEar: 7, rightEar: 8, leftShoulder: 11, rightShoulder: 12,
                   leftHip: 23, rightHip: 24 };
const HAND_IDX = { wrist: 0, indexTip: 8, middleTip: 12 };

export function pickPose(result) {
  const lm = result && result.landmarks && result.landmarks[0];
  if (!lm) return null;
  const pt = (i) => ({ x: lm[i].x, y: lm[i].y, visibility: lm[i].visibility ?? 0 });
  const out = {};
  for (const [name, i] of Object.entries(POSE_IDX)) out[name] = pt(i);
  return out;
}

export function pickHands(result) {
  const hands = (result && result.landmarks) || [];
  const labels = (result && result.handednesses) || [];
  return hands.map((lm, h) => {
    const pt = (i) => ({ x: lm[i].x, y: lm[i].y });
    return {
      handedness: (labels[h] && labels[h][0] && labels[h][0].categoryName) || "",
      wrist: pt(HAND_IDX.wrist), indexTip: pt(HAND_IDX.indexTip), middleTip: pt(HAND_IDX.middleTip),
    };
  });
}
```

- [ ] **Step 2: Verify & commit**

```bash
node --check frontend/landmarks.js
git add frontend/landmarks.js
git commit -m "feat: pose/hand keypoint extraction helpers"
```

---

## Task 10: app.js — init pose/hand, throttled capture, extended frames, results keys

**Files:**
- Modify: `frontend/app.js`

- [ ] **Step 1: Update imports** — at the top of `frontend/app.js`, change the tasks-vision import to add Pose + Hand, and import the helpers:

```javascript
import { CONFIG } from "./config.js";
import { startVoiceAgent } from "./deepgram-client.js";
import { pickPose, pickHands } from "./landmarks.js";
import { FaceLandmarker, PoseLandmarker, HandLandmarker, FilesetResolver, DrawingUtils }
  from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35";
```

- [ ] **Step 2: Add module state** — near the other `let` declarations at the top, add:

```javascript
let poseLandmarker = null;
let handLandmarker = null;
let lastBodyTs = 0;
```

- [ ] **Step 3: Extend `initLandmarker`** — replace the `initLandmarker` function body's end (after the FaceLandmarker is created) so it also creates the pose + hand landmarkers from the same fileset:

```javascript
async function initLandmarker() {
  const fileset = await FilesetResolver.forVisionTasks(CONFIG.WASM_BASE);
  landmarker = await FaceLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: CONFIG.MODEL_URL },
    runningMode: "VIDEO", numFaces: 1,
    outputFaceBlendshapes: true, outputFacialTransformationMatrixes: true,
  });
  poseLandmarker = await PoseLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: CONFIG.POSE_MODEL_URL },
    runningMode: "VIDEO", numPoses: 1,
  });
  handLandmarker = await HandLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: CONFIG.HAND_MODEL_URL },
    runningMode: "VIDEO", numHands: 2,
  });
}
```

- [ ] **Step 4: Throttled body capture in `renderLoop`** — replace the part of `renderLoop` that builds and pushes the frame (the `const bs = ...` / `const m = ...` / `frames.push(...)` lines) with:

```javascript
  const bs = pickBlendshapes(hasFace ? result.faceBlendshapes?.[0]?.categories : null);
  const m = hasFace && result.facialTransformationMatrixes?.[0]
    ? Array.from(result.facialTransformationMatrixes[0].data)
    : [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];

  const frame = { t: now - sessionStart, turn: turnIndex, face: hasFace, bs, m };

  // Pose + hands are heavier — run them throttled and attach only on those frames.
  if (now - lastBodyTs >= CONFIG.POSE_THROTTLE_MS) {
    lastBodyTs = now;
    try {
      frame.pose = pickPose(poseLandmarker.detectForVideo(video, now));
      frame.hands = pickHands(handLandmarker.detectForVideo(video, now));
    } catch (e) { console.warn("[interview] body detect skipped:", e.message); }
  }
  frames.push(frame);
```

- [ ] **Step 5: Update `renderResults`** — the backend no longer returns `eye_contact_pct`; use the new keys. In `renderResults`, replace the `#metrics-overall` block and the per-question row mapping:

```javascript
  $("metrics-overall").innerHTML = "";
  for (const text of [
    `Eye contact (gaze): ${o.gaze_eye_contact_pct}%`,
    `Upright posture: ${o.upright_pct}%`,
    `Steadiness: head ${o.steadiness_score}/100, body ${o.body_steadiness}/100`,
    `Hand fidget: ${o.hand_fidget}  ·  face-touches: ${o.face_touch_count}`,
    `Smiling: ${o.pct_smiling}% (peak ${o.peak_smile})  ·  blinks: ${o.blink_count}`,
    `Lean (lateral): ${o.lean}°  ·  no-face: ${data.summary.no_face_pct}%`,
  ]) {
    const li = document.createElement("li");
    li.textContent = text;
    $("metrics-overall").appendChild(li);
  }
```
(Keep using the safe `createElement`/`textContent` pattern — no `innerHTML` with data.)

And replace the per-question table row builder loop body to use the new columns:
```javascript
  const tb = $("metrics-per-question");
  while (tb.firstChild) tb.removeChild(tb.firstChild);
  for (const q of data.summary.per_question) {
    const tr = document.createElement("tr");
    for (const cell of [q.question, `${q.metrics.gaze_eye_contact_pct}%`,
                        `${q.metrics.upright_pct}%`, `${q.metrics.body_steadiness}`,
                        `${q.metrics.face_touch_count}`]) {
      const td = document.createElement("td");
      td.textContent = cell;
      tr.appendChild(td);
    }
    tb.appendChild(tr);
  }
```

> NOTE: if `renderResults` currently sets `$("metrics-overall").innerHTML = ...` or builds the per-question rows with `innerHTML`, you are replacing those with the safe DOM versions above. Confirm `grep -n innerHTML frontend/app.js` prints nothing afterward.

- [ ] **Step 6: Verify syntax**

Run: `node --check frontend/app.js` (ignore module import/export notes only).
Expected: no other syntax error. Then `grep -n innerHTML frontend/app.js` → no output.

- [ ] **Step 7: Commit**

```bash
git add frontend/app.js
git commit -m "feat: capture pose/hands (throttled) and render new body-language metrics"
```

---

## Task 11: Results-screen layout for new metrics (frontend-design)

**Files:**
- Modify: `frontend/index.html`, `frontend/style.css`

> **REQUIRED SUB-SKILL:** Invoke the **`frontend-design`** skill to update ONLY the results screen.

- [ ] **Step 1: Update the per-question table header** via `frontend-design`. The results table currently has columns `Question, Eye contact, Steadiness, Smiling, Blinks`. Change the `<thead>` columns to exactly: **Question, Eye contact, Upright, Steadiness, Face-touch** (5 columns) to match the row cells produced in Task 10 Step 5 (`gaze_eye_contact_pct`, `upright_pct`, `body_steadiness`, `face_touch_count`). Keep `id="metrics-per-question"` on the `<tbody>` and all other IDs unchanged.

- [ ] **Step 2: Optional polish** — `frontend-design` may restyle the overall-metrics list / coaching area for the added lines, but MUST preserve all element IDs (`metrics-overall`, `metrics-per-question`, `chart-img`, `coaching`, `saved-path`, `newsession-btn`) and must not add scripts.

- [ ] **Step 3: Verify IDs intact**

Run: `for id in metrics-overall metrics-per-question chart-img coaching saved-path newsession-btn; do printf "%s " $id; grep -c "id=\"$id\"" frontend/index.html; done`
Expected: each prints `1`.

- [ ] **Step 4: Commit**

```bash
git add frontend/index.html frontend/style.css
git commit -m "feat: results screen columns/layout for body-language metrics"
```

---

## Task 12: Manual end-to-end verification

**Files:** none (verification only)

- [ ] **Step 1: Full suite**

Run: `. .venv/bin/activate && pytest -q`
Expected: all pass.

- [ ] **Step 2: Live run**

Run: `uvicorn backend.main:app --reload --port 8000`, open `http://localhost:8000`, complete a short interview.
Expected:
1. Browser console shows `[dg] input sample_rate = …`; your transcription reads more accurately than before.
2. The interview works; mesh overlay still renders.
3. End → results show gaze eye-contact, upright %, head + body steadiness, hand fidget, face-touch count, and the per-question table with the new columns; `charts.png` has the third (posture) panel.
4. `sessions/<id>/data.csv` includes the new columns; `summary.json` includes the new metric keys.

- [ ] **Step 3:** Note completion (nothing to commit).

---

## Self-Review (completed during planning)

- **Spec coverage:** Phase 0 transcription → Tasks 1 (keyterms) + 2 (sample-rate). Gaze → Task 3. Posture/lean/body-steadiness → Task 4. Hand fidget/face-touch → Task 5. Metric-block merge + `eye_contact_pct` removal → Task 6. Report CSV + chart → Task 7. Client config/models/throttle/blendshapes → Tasks 8–10. UI → Task 11. Verification → Task 12. Out-of-scope items (Holistic, client-side metrics, forward-lean, AudioWorklet) are excluded.
- **Type consistency:** `MetricBlock` keys (`gaze_eye_contact_pct`, `upright_pct`, `lean`, `body_steadiness`, `hand_fidget`, `face_touch_count`) are produced in Tasks 3–6 and consumed identically in `report.py` (Task 7) and `app.js` `renderResults` (Task 10). `Frame.pose`/`Frame.hands` shapes match between `landmarks.js` (Task 9), the analysis functions (Tasks 4–5), and the test helpers. Pose key names (`leftShoulder` etc.) and hand keys (`wrist/indexTip/middleTip`) are identical across producer and consumers.
- **Placeholders:** none — every code step contains full code; the only delegated artifact is the results-screen markup/CSS (Task 11), handed to `frontend-design` with an exact column/ID contract.
