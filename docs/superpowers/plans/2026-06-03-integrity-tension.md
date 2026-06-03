# Integrity Signals + Facial Tension (Plan 1 of 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add multi-face + object detection (integrity signals) and richer expression blendshapes with a facial-tension metric, surfaced on the results page.

**Architecture:** Face Landmarker runs with `numFaces: 2` (capture `face_count`); a new throttled Object Detector captures in-frame objects; extra blendshapes feed a `facial_tension` composite. New `integrity_metrics` is computed server-side and exposed as `summary.integrity`; tension extends `expression_detail`.

**Tech Stack:** Python 3.9, FastAPI, pytest; vanilla JS, MediaPipe `ObjectDetector` + Face Landmarker.

**Spec:** `docs/superpowers/specs/2026-06-03-integrity-tension-actions-design.md` (this is Plan 1 of 2; Plan 2 = the live actions feed.)

---

## Data contract additions (this plan)

- `Frame.face_count` (int); `Frame.objects` (list of `{label, score}`, only on throttled frames).
- `summary.integrity` = `{multi_face_pct, another_person_detected, objects_seen:[{label,pct}], device_in_frame_pct, device_detected}`.
- `MetricBlock` (overall + per-question) gains expression tension fields: `eye_squint, lip_press, brow_down, jaw_shift, nose_sneer, mouth_frown, facial_tension`.

---

## Task 1: `integrity_metrics` (multi-face + objects)

**Files:** Modify `backend/analysis.py`; Modify `tests/test_analysis.py`

- [ ] **Step 1: Append tests** to `tests/test_analysis.py`

```python
from backend.analysis import integrity_metrics

def test_integrity_multi_face():
    frames = [{"t": i*100.0, "turn": 0, "face": True, "face_count": (2 if i < 3 else 1)} for i in range(10)]
    out = integrity_metrics(frames)
    assert out["multi_face_pct"] == 30.0
    assert out["another_person_detected"] is True

def test_integrity_objects_and_device():
    frames = [
        {"t": 0, "turn": 0, "face": True, "face_count": 1, "objects": [{"label": "cell phone", "score": 0.8}]},
        {"t": 1, "turn": 0, "face": True, "face_count": 1, "objects": [{"label": "cup", "score": 0.7}]},
    ]
    out = integrity_metrics(frames)
    labels = {o["label"]: o["pct"] for o in out["objects_seen"]}
    assert labels["cell phone"] == 50.0 and labels["cup"] == 50.0
    assert out["device_in_frame_pct"] == 50.0
    assert out["device_detected"] is True

def test_integrity_empty_safe():
    out = integrity_metrics([{"t": 0, "turn": 0, "face": True}])  # no face_count, no objects
    assert out["multi_face_pct"] == 0.0
    assert out["another_person_detected"] is False
    assert out["objects_seen"] == []
    assert out["device_detected"] is False
```

- [ ] **Step 2: Run to verify fail**

Run: `. .venv/bin/activate && pytest tests/test_analysis.py -k integrity -v`
Expected: FAIL (ImportError).

- [ ] **Step 3: Implement** in `backend/analysis.py` — add constant near the thresholds and the function:

```python
CONCERN_OBJECTS = {"cell phone", "laptop", "tv", "book", "remote", "keyboard"}


def integrity_metrics(frames: list[dict]) -> dict:
    """Session-level integrity signals: a second face, and objects/devices in frame."""
    total = len(frames)
    multi = sum(1 for f in frames if f.get("face_count", 0) > 1)
    obj_frames = [f for f in frames if f.get("objects") is not None]
    seen, device_frames = {}, 0
    for f in obj_frames:
        labels = {o["label"] for o in (f["objects"] or [])}
        for lbl in labels:
            seen[lbl] = seen.get(lbl, 0) + 1
        if labels & CONCERN_OBJECTS:
            device_frames += 1
    n = len(obj_frames)
    objects_seen = sorted(
        ({"label": k, "pct": round(100.0 * v / n, 1)} for k, v in seen.items()),
        key=lambda d: -d["pct"]) if n else []
    device_pct = round(100.0 * device_frames / n, 1) if n else 0.0
    return {"multi_face_pct": round(100.0 * multi / total, 1) if total else 0.0,
            "another_person_detected": multi > 0,
            "objects_seen": objects_seen,
            "device_in_frame_pct": device_pct,
            "device_detected": device_pct > 0}
```

- [ ] **Step 4: Run to verify pass**

Run: `pytest tests/test_analysis.py -k integrity -v` → PASS, then `pytest tests/test_analysis.py -v` (all).

- [ ] **Step 5: Commit**

```bash
git add backend/analysis.py tests/test_analysis.py
git commit -m "feat: integrity_metrics (multi-face + in-frame objects/devices)"
```

---

## Task 2: Facial tension in `expression_detail`

**Files:** Modify `backend/analysis.py`; Modify `tests/test_analysis.py`

- [ ] **Step 1: Append test** to `tests/test_analysis.py`

```python
def test_expression_tension_fields():
    frames = []
    for i in range(4):
        f = _frame(i*100.0)
        f["bs"]["eyeSquintLeft"] = 0.6; f["bs"]["eyeSquintRight"] = 0.6
        f["bs"]["mouthPressLeft"] = 0.4; f["bs"]["mouthPressRight"] = 0.4
        f["bs"]["browDownLeft"] = 0.2; f["bs"]["browDownRight"] = 0.2
        f["bs"]["jawLeft"] = 0.1; f["bs"]["jawRight"] = 0.0
        f["bs"]["noseSneerLeft"] = 0.0; f["bs"]["noseSneerRight"] = 0.0
        f["bs"]["mouthFrownLeft"] = 0.0; f["bs"]["mouthFrownRight"] = 0.0
        frames.append(f)
    out = expression_detail(frames)
    assert abs(out["eye_squint"] - 0.6) < 1e-6
    assert abs(out["lip_press"] - 0.4) < 1e-6
    assert abs(out["jaw_shift"] - 0.1) < 1e-6
    # facial_tension = 100*(squint+lip_press+brow_down)/3 = 100*(0.6+0.4+0.2)/3 = 40.0
    assert out["facial_tension"] == 40.0
```

- [ ] **Step 2: Run to verify fail**

Run: `pytest tests/test_analysis.py -k tension -v`
Expected: FAIL (KeyError — fields missing).

- [ ] **Step 3: Implement** — replace the ENTIRE `expression_detail` function in `backend/analysis.py` with:

```python
def expression_detail(frames: list[dict]) -> dict:
    """Eye/mouth openness, speaking, eyebrow raise, and facial-tension signals from face frames."""
    total = len(frames)
    face = [f for f in frames if f.get("face", False) and "bs" in f]
    if not face:
        return {"eye_openness": 0.0, "mouth_open_mean": 0.0, "speaking_pct": 0.0, "eyebrow_raise": 0.0,
                "eye_squint": 0.0, "lip_press": 0.0, "brow_down": 0.0, "jaw_shift": 0.0,
                "nose_sneer": 0.0, "mouth_frown": 0.0, "facial_tension": 0.0}
    eye_open, mouth, brow, speaking = [], [], [], 0
    squint, press, down, jaw, sneer, frown = [], [], [], [], [], []
    for f in face:
        bs = f["bs"]
        eye_open.append(1.0 - max(bs.get("eyeBlinkLeft", 0.0), bs.get("eyeBlinkRight", 0.0)))
        jo = bs.get("jawOpen", 0.0)
        mouth.append(jo)
        if jo > SPEAKING_OPEN:
            speaking += 1
        brow.append((bs.get("browInnerUp", 0.0) + bs.get("browOuterUpLeft", 0.0)
                     + bs.get("browOuterUpRight", 0.0)) / 3.0)
        squint.append(max(bs.get("eyeSquintLeft", 0.0), bs.get("eyeSquintRight", 0.0)))
        press.append(max(bs.get("mouthPressLeft", 0.0), bs.get("mouthPressRight", 0.0)))
        down.append(max(bs.get("browDownLeft", 0.0), bs.get("browDownRight", 0.0)))
        jaw.append(max(bs.get("jawLeft", 0.0), bs.get("jawRight", 0.0)))
        sneer.append(max(bs.get("noseSneerLeft", 0.0), bs.get("noseSneerRight", 0.0)))
        frown.append(max(bs.get("mouthFrownLeft", 0.0), bs.get("mouthFrownRight", 0.0)))
    n = len(face)
    eye_squint = sum(squint) / n
    lip_press = sum(press) / n
    brow_down = sum(down) / n
    return {"eye_openness": round(sum(eye_open) / n, 3),
            "mouth_open_mean": round(sum(mouth) / n, 3),
            "speaking_pct": round(100.0 * speaking / total, 1),
            "eyebrow_raise": round(sum(brow) / n, 3),
            "eye_squint": round(eye_squint, 3), "lip_press": round(lip_press, 3),
            "brow_down": round(brow_down, 3), "jaw_shift": round(sum(jaw) / n, 3),
            "nose_sneer": round(sum(sneer) / n, 3), "mouth_frown": round(sum(frown) / n, 3),
            "facial_tension": round(100.0 * (eye_squint + lip_press + brow_down) / 3.0, 1)}
```

- [ ] **Step 4: Run to verify pass**

Run: `pytest tests/test_analysis.py -v` (all pass — `_metric_block` already merges `expression_detail`, so the new keys appear in the block automatically).

- [ ] **Step 5: Commit**

```bash
git add backend/analysis.py tests/test_analysis.py
git commit -m "feat: facial tension signals in expression_detail"
```

---

## Task 3: Wire `summary.integrity` in the API

**Files:** Modify `backend/main.py`; Modify `tests/test_main.py`

- [ ] **Step 1: Append test** to `tests/test_main.py`

```python
def test_session_summary_has_integrity(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "")
    frames = [{"t": i*100.0, "turn": 0, "face": True, "face_count": (2 if i == 0 else 1),
               "bs": {}, "m": [1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1],
               "objects": ([{"label": "cell phone", "score": 0.9}] if i == 0 else None)}
              for i in range(4)]
    body = {"role": "X", "frames": frames, "transcript": {"full_text": "", "segments": []}}
    data = client.post("/api/session", json=body).json()
    assert "integrity" in data["summary"]
    assert data["summary"]["integrity"]["another_person_detected"] is True
    assert data["summary"]["integrity"]["device_detected"] is True
```

- [ ] **Step 2: Run to verify fail**

Run: `pytest tests/test_main.py -k integrity -v`
Expected: FAIL (no `integrity` key).

- [ ] **Step 3: Implement** in `backend/main.py`
Change the import line:
```python
from backend.analysis import compute_metrics, questions_from_transcript, transcript_metrics
```
to:
```python
from backend.analysis import compute_metrics, questions_from_transcript, transcript_metrics, integrity_metrics
```
In `session`, right after the existing `summary["timing"] = transcript_metrics(...)` line, add:
```python
    summary["integrity"] = integrity_metrics(req.frames)
```

- [ ] **Step 4: Run** `pytest -q` → all pass.

- [ ] **Step 5: Commit**

```bash
git add backend/main.py tests/test_main.py
git commit -m "feat: expose summary.integrity from the session endpoint"
```

---

## Task 4: Frontend config — object model + blendshapes

**Files:** Modify `frontend/config.js`

- [ ] **Step 1: Implement** — add the object model URL after the gesture model line:
```javascript
  OBJECT_MODEL_URL: "https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/float16/1/efficientdet_lite0.tflite",
```
And extend the `BLENDSHAPES` array: replace
```javascript
    "jawOpen", "browOuterUpLeft", "browOuterUpRight"],
```
with
```javascript
    "jawOpen", "browOuterUpLeft", "browOuterUpRight",
    "eyeSquintLeft", "eyeSquintRight", "mouthPressLeft", "mouthPressRight",
    "browDownLeft", "browDownRight", "jawLeft", "jawRight",
    "noseSneerLeft", "noseSneerRight", "mouthFrownLeft", "mouthFrownRight"],
```

- [ ] **Step 2: Verify & commit**
```bash
node --check frontend/config.js
git add frontend/config.js
git commit -m "feat: object-detector model URL + tension blendshapes"
```

---

## Task 5: `pickObjects` helper

**Files:** Modify `frontend/landmarks.js`

- [ ] **Step 1: Implement** — append to `frontend/landmarks.js`:
```javascript
export function pickObjects(result) {
  const dets = (result && result.detections) || [];
  return dets
    .map((d) => (d.categories && d.categories[0]
      ? { label: d.categories[0].categoryName, score: d.categories[0].score } : null))
    .filter(Boolean);
}
```

- [ ] **Step 2: Verify & commit**
```bash
node --check frontend/landmarks.js
git add frontend/landmarks.js
git commit -m "feat: pickObjects helper for object-detector results"
```

---

## Task 6: app.js — multi-face + object capture

**Files:** Modify `frontend/app.js`

- [ ] **Step 1: Imports** — replace:
```javascript
import { pickPose, pickHands } from "./landmarks.js";
import { FaceLandmarker, PoseLandmarker, HandLandmarker, GestureRecognizer, FilesetResolver, DrawingUtils }
  from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35";
```
with:
```javascript
import { pickPose, pickHands, pickObjects } from "./landmarks.js";
import { FaceLandmarker, PoseLandmarker, HandLandmarker, GestureRecognizer, ObjectDetector, FilesetResolver, DrawingUtils }
  from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35";
```

- [ ] **Step 2: State** — replace:
```javascript
let lastHandResult = null;   // cached for smooth every-frame drawing
let lastBodyTs = 0;
```
with:
```javascript
let lastHandResult = null;   // cached for smooth every-frame drawing
let objectDetector = null;
let lastObjectResult = null;
let lastBodyTs = 0;
```

- [ ] **Step 3: initLandmarker** — at the END of `initLandmarker` (after the `gestureRecognizer = ...` block), add:
```javascript
  objectDetector = await ObjectDetector.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: CONFIG.OBJECT_MODEL_URL },
    runningMode: "VIDEO", scoreThreshold: 0.4, maxResults: 5,
  });
```
Also change the Face Landmarker option `numFaces: 1,` to `numFaces: 2,`.

- [ ] **Step 4: Capture face_count + objects** — replace:
```javascript
  const frame = { t: now - sessionStart, turn: turnIndex, face: hasFace, bs, m };

  // Pose + hands are heavier — run them throttled and attach only on those frames.
  if (now - lastBodyTs >= CONFIG.POSE_THROTTLE_MS) {
    lastBodyTs = now;
    try {
      frame.pose = pickPose(poseLandmarker.detectForVideo(video, now));
      const hr = gestureRecognizer.recognizeForVideo(video, now);
      lastHandResult = (hr && hr.landmarks && hr.landmarks.length) ? hr : null;
      frame.hands = pickHands(hr);
    } catch (e) { console.warn("[interview] body detect skipped:", e.message); }
  }
  frames.push(frame);
```
with:
```javascript
  const faceCount = result.faceLandmarks ? result.faceLandmarks.length : 0;
  const frame = { t: now - sessionStart, turn: turnIndex, face: hasFace, face_count: faceCount, bs, m };

  // Pose + hands + objects are heavier — run them throttled and attach only on those frames.
  if (now - lastBodyTs >= CONFIG.POSE_THROTTLE_MS) {
    lastBodyTs = now;
    try {
      frame.pose = pickPose(poseLandmarker.detectForVideo(video, now));
      const hr = gestureRecognizer.recognizeForVideo(video, now);
      lastHandResult = (hr && hr.landmarks && hr.landmarks.length) ? hr : null;
      frame.hands = pickHands(hr);
      const orr = objectDetector.detectForVideo(video, now);
      lastObjectResult = orr;
      frame.objects = pickObjects(orr);
    } catch (e) { console.warn("[interview] body detect skipped:", e.message); }
  }
  frames.push(frame);
```

- [ ] **Step 5: Reset object cache on new session** — in `startInterview`, the line `lastHandResult = null; lastBodyTs = 0;` → change to:
```javascript
  lastHandResult = null; lastObjectResult = null; lastBodyTs = 0;
```

- [ ] **Step 6: Verify**
Run: `node --check frontend/app.js` (ignore module note).

- [ ] **Step 7: Commit**
```bash
git add frontend/app.js
git commit -m "feat: capture second face + in-frame objects (throttled)"
```

---

## Task 7: app.js — draw objects/faces + render integrity & tension

**Files:** Modify `frontend/app.js`

- [ ] **Step 1: Draw all face meshes** — replace:
```javascript
  if (hasFace) {
    draw.drawConnectors(result.faceLandmarks[0],
      FaceLandmarker.FACE_LANDMARKS_TESSELATION, { color: "#30FF9080", lineWidth: 0.5 });
  }
```
with:
```javascript
  if (hasFace) {
    for (const fl of result.faceLandmarks) {
      draw.drawConnectors(fl, FaceLandmarker.FACE_LANDMARKS_TESSELATION,
        { color: "#30FF9080", lineWidth: 0.5 });
    }
  }
```

- [ ] **Step 2: Draw object boxes** — immediately AFTER the hand-overlay drawing block (the `if (lastHandResult && lastHandResult.landmarks) { ... }` block), insert:
```javascript

  // Object detection boxes (from the throttled cache).
  if (lastObjectResult && lastObjectResult.detections) {
    ctx.strokeStyle = "#FFD23F"; ctx.lineWidth = 2; ctx.fillStyle = "#FFD23F"; ctx.font = "14px sans-serif";
    for (const d of lastObjectResult.detections) {
      const b = d.boundingBox; const c = d.categories && d.categories[0];
      if (!b || !c) continue;
      ctx.strokeRect(b.originX, b.originY, b.width, b.height);
      ctx.fillText(`${c.categoryName} ${c.score.toFixed(2)}`, b.originX, Math.max(14, b.originY - 4));
    }
  }
```

- [ ] **Step 3: Render integrity + tension** — in `renderResults`, replace the `card-presence` fill:
```javascript
  fillList("card-presence", [
    `Face present: ${o.face_presence_pct}%`,
    `No-face: ${s.no_face_pct}%`,
  ]);
```
with (reads `summary.integrity`):
```javascript
  const ig = s.integrity || {};
  fillList("card-presence", [
    `Face present: ${o.face_presence_pct}%`,
    `Another person detected: ${ig.another_person_detected ? "yes" : "no"} (${ig.multi_face_pct ?? 0}% of frames)`,
    `Device in frame: ${ig.device_detected ? "yes" : "no"} (${ig.device_in_frame_pct ?? 0}%)`,
    `Objects seen: ${(ig.objects_seen || []).map((x) => x.label + " " + x.pct + "%").join(", ") || "none"}`,
  ]);
```
And replace the `card-expression` fill:
```javascript
  fillList("card-expression", [
    `Smile: mean ${o.mean_smile}, peak ${o.peak_smile} (${o.pct_smiling}% of time)`,
    `Eyebrow raise: ${o.eyebrow_raise}`,
    `Mouth open: ${o.mouth_open_mean} · speaking ${o.speaking_pct}%`,
  ]);
```
with:
```javascript
  fillList("card-expression", [
    `Smile: mean ${o.mean_smile}, peak ${o.peak_smile} (${o.pct_smiling}% of time)`,
    `Eyebrow raise: ${o.eyebrow_raise}`,
    `Mouth open: ${o.mouth_open_mean} · speaking ${o.speaking_pct}%`,
    `Facial tension: ${o.facial_tension}/100`,
    `Tension signals — squint ${o.eye_squint} · lip-press ${o.lip_press} · brow-down ${o.brow_down} · jaw ${o.jaw_shift}`,
  ]);
```

- [ ] **Step 4: Verify**
Run: `node --check frontend/app.js`; `grep -n innerHTML frontend/app.js` → no output.

- [ ] **Step 5: Commit**
```bash
git add frontend/app.js
git commit -m "feat: draw object boxes + all faces; render integrity & tension"
```

---

## Task 8: Retitle the Presence card to "Integrity"

**Files:** Modify `frontend/index.html`

- [ ] **Step 1: Implement** — find the results-screen card whose `<ul>` has `id="card-presence"` and change its visible title text from "Presence" to "Integrity". Change ONLY the human-readable title (heading) text; keep `id="card-presence"` on the `<ul>` unchanged (JS binds to it).

- [ ] **Step 2: Verify**
Run: `grep -c 'id="card-presence"' frontend/index.html` → `1`; `grep -c "Integrity" frontend/index.html` → at least `1`.

- [ ] **Step 3: Commit**
```bash
git add frontend/index.html
git commit -m "feat: retitle Presence card to Integrity"
```

---

## Task 9: Manual end-to-end verification

**Files:** none

- [ ] **Step 1:** `. .venv/bin/activate && pytest -q` → all pass.
- [ ] **Step 2:** `uvicorn backend.main:app --reload --port 8000`, run a short interview. Confirm:
  1. Holding up a phone draws a yellow box labeled "cell phone"; a second face draws a second mesh.
  2. Results "Integrity" card shows another-person + device flags + objects seen.
  3. "Expression" card shows Facial tension + the raw tension signals.
  4. `sessions/<id>/summary.json` has `integrity` and the tension keys.
- [ ] **Step 3:** Note completion.

---

## Self-Review (completed during planning)

- **Spec coverage (A,B,C):** multi-face → Tasks 1,3,6,7; objects → Tasks 1,3,4,5,6,7; richer blendshapes + tension → Tasks 2,4,7; Integrity card retitle → Task 8; verify → Task 9. (Component D — actions feed — is Plan 2, intentionally not here.)
- **Type consistency:** `integrity_metrics` keys (`multi_face_pct, another_person_detected, objects_seen[{label,pct}], device_in_frame_pct, device_detected`) produced in Task 1, exposed in Task 3, consumed in Task 7. `Frame.face_count`/`Frame.objects` produced in Task 6 match what Task 1 reads. `expression_detail` tension keys (Task 2) are merged by the existing `_metric_block` and consumed in Task 7. `pickObjects` (Task 5) output `[{label,score}]` matches Task 6 usage and Task 1's reader.
- **Placeholders:** none — all code steps complete; the only delegated/loose item is Task 8's one-word title edit (no structural change, no frontend-design needed).
