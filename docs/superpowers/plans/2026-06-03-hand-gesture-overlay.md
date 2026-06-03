# Live Hand + Gesture Overlay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Draw a live hand skeleton + gesture-name label on the interview webcam canvas (like the existing face mesh), by replacing the Hand Landmarker with MediaPipe's Gesture Recognizer.

**Architecture:** Frontend-only. The Gesture Recognizer returns the same 21 hand landmarks (so existing hand metrics are unchanged) plus a recognized gesture per hand. Detection stays throttled (~8/sec); the last result is cached and the hand skeleton + label are drawn every frame for a smooth overlay.

**Tech Stack:** vanilla JS, `@mediapipe/tasks-vision` (`GestureRecognizer`, `DrawingUtils`, `HandLandmarker.HAND_CONNECTIONS`).

**Spec:** `docs/superpowers/specs/2026-06-03-hand-gesture-overlay-design.md`

> No backend or test changes. JS verified with `node --check` (ignore only ES import/export notes).

---

## Task 1: Config — gesture model URL

**Files:** Modify `frontend/config.js`

- [ ] **Step 1: Implement** — replace the `HAND_MODEL_URL` line:
```javascript
  HAND_MODEL_URL: "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
```
with:
```javascript
  GESTURE_MODEL_URL: "https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task",
```

- [ ] **Step 2: Verify & commit**
```bash
node --check frontend/config.js
git add frontend/config.js
git commit -m "feat: gesture recognizer model URL (replaces hand landmarker)"
```

---

## Task 2: `pickHands` tolerant of handedness field name

**Files:** Modify `frontend/landmarks.js`

The Gesture Recognizer result exposes handedness as `handedness` (vs `handednesses` on Hand Landmarker). Make `pickHands` accept either.

- [ ] **Step 1: Implement** — replace:
```javascript
  const labels = (result && result.handednesses) || [];
```
with:
```javascript
  const labels = (result && (result.handedness || result.handednesses)) || [];
```

- [ ] **Step 2: Verify & commit**
```bash
node --check frontend/landmarks.js
git add frontend/landmarks.js
git commit -m "feat: pickHands accepts gesture-recognizer handedness field"
```

---

## Task 3: app.js — swap to Gesture Recognizer, cache, draw skeleton + label

**Files:** Modify `frontend/app.js`

Apply these EXACT edits (strings below match the current file).

- [ ] **Step 1: Import GestureRecognizer** — replace:
```javascript
import { FaceLandmarker, PoseLandmarker, HandLandmarker, FilesetResolver, DrawingUtils }
  from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35";
```
with (keep `HandLandmarker` — used only for the `HAND_CONNECTIONS` constant):
```javascript
import { FaceLandmarker, PoseLandmarker, HandLandmarker, GestureRecognizer, FilesetResolver, DrawingUtils }
  from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35";
```

- [ ] **Step 2: Module state** — replace:
```javascript
let handLandmarker = null;
let lastBodyTs = 0;
```
with:
```javascript
let gestureRecognizer = null;
let lastHandResult = null;   // cached for smooth every-frame drawing
let lastBodyTs = 0;
```

- [ ] **Step 3: initLandmarker** — replace:
```javascript
  handLandmarker = await HandLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: CONFIG.HAND_MODEL_URL },
    runningMode: "VIDEO", numHands: 2,
  });
```
with:
```javascript
  gestureRecognizer = await GestureRecognizer.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: CONFIG.GESTURE_MODEL_URL },
    runningMode: "VIDEO", numHands: 2,
  });
```

- [ ] **Step 4: Throttled detection** — replace:
```javascript
    try {
      frame.pose = pickPose(poseLandmarker.detectForVideo(video, now));
      frame.hands = pickHands(handLandmarker.detectForVideo(video, now));
    } catch (e) { console.warn("[interview] body detect skipped:", e.message); }
```
with (note: GestureRecognizer uses `recognizeForVideo`, not `detectForVideo`):
```javascript
    try {
      frame.pose = pickPose(poseLandmarker.detectForVideo(video, now));
      const hr = gestureRecognizer.recognizeForVideo(video, now);
      lastHandResult = (hr && hr.landmarks && hr.landmarks.length) ? hr : null;
      frame.hands = pickHands(hr);
    } catch (e) { console.warn("[interview] body detect skipped:", e.message); }
```

- [ ] **Step 5: Draw hands + gesture label every frame** — insert this block immediately AFTER the face-mesh draw block (after the lines):
```javascript
  if (hasFace) {
    draw.drawConnectors(result.faceLandmarks[0],
      FaceLandmarker.FACE_LANDMARKS_TESSELATION, { color: "#30FF9080", lineWidth: 0.5 });
  }
```
Insert:
```javascript

  // Hand skeleton + gesture label, drawn every frame from the throttled cache (no flicker).
  if (lastHandResult && lastHandResult.landmarks) {
    const handed = lastHandResult.handedness || lastHandResult.handednesses || [];
    for (let h = 0; h < lastHandResult.landmarks.length; h++) {
      const lm = lastHandResult.landmarks[h];
      draw.drawConnectors(lm, HandLandmarker.HAND_CONNECTIONS, { color: "#FFFFFFB0", lineWidth: 2 });
      draw.drawLandmarks(lm, { color: "#30FF90", radius: 2 });
      const g = lastHandResult.gestures && lastHandResult.gestures[h] && lastHandResult.gestures[h][0];
      if (g && g.categoryName && g.categoryName !== "None") {
        const handName = handed[h] && handed[h][0] && handed[h][0].categoryName;
        const label = (handName ? handName + ": " : "") + g.categoryName + " " + g.score.toFixed(2);
        ctx.fillStyle = "#30FF90";
        ctx.font = "16px sans-serif";
        ctx.fillText(label, lm[0].x * canvas.width, lm[0].y * canvas.height - 8);
      }
    }
  }
```

- [ ] **Step 6: Reset the cache on a new session** — in `startInterview`, replace:
```javascript
  frames = []; segments = []; turnIndex = -1;
```
with:
```javascript
  frames = []; segments = []; turnIndex = -1;
  lastHandResult = null; lastBodyTs = 0;
```

- [ ] **Step 7: Verify**
```bash
node --check frontend/app.js
grep -n "handLandmarker" frontend/app.js   # expect: no output (all references renamed)
grep -n innerHTML frontend/app.js          # expect: no output (XSS-safe rendering preserved)
```
Expected: `node --check` clean (module note aside); both greps print nothing.

- [ ] **Step 8: Commit**
```bash
git add frontend/app.js
git commit -m "feat: live hand skeleton + gesture label overlay via Gesture Recognizer"
```

---

## Task 4: Manual verification

**Files:** none (verification only)

- [ ] **Step 1: Backend suite unaffected**
Run: `. .venv/bin/activate && pytest -q`
Expected: all pass (no backend/test changes were made).

- [ ] **Step 2: Live run**
Run: `uvicorn backend.main:app --reload --port 8000`, open `http://localhost:8000`, start an interview, raise a hand and make gestures (open palm, fist, thumbs-up).
Expected:
1. A white hand skeleton with green joints tracks each visible hand, smoothly (no heavy flicker).
2. A green gesture label (e.g. "Right: Open_Palm 0.93") shows above the wrist when a gesture is recognized.
3. The overlay disappears shortly after hands leave the frame.
4. The face mesh still renders; the interview voice + transcript + end-of-session report are unchanged (hand metrics still computed).

- [ ] **Step 3:** Note completion (nothing to commit).

---

## Self-Review (completed during planning)

- **Spec coverage:** model swap → Tasks 1 + 3; `pickHands` field tolerance → Task 2; cache + every-frame skeleton draw → Task 3 Steps 4–5; gesture label → Task 3 Step 5; cache reset → Step 6; visual-only / no backend change → confirmed (Task 4 Step 1). Error handling: empty `landmarks` clears the cache (Step 4); detect exceptions already caught (Step 4); `HAND_CONNECTIONS` fallback note is in the spec — if it is undefined at runtime, drop the `drawConnectors` line and keep `drawLandmarks`.
- **Consistency:** the variable is `gestureRecognizer` everywhere (Steps 2–4); `CONFIG.GESTURE_MODEL_URL` matches Task 1; `recognizeForVideo` (not `detectForVideo`) is used for the Gesture Recognizer; `pickHands` reads `result.landmarks` which both models provide.
- **Placeholders:** none — all steps contain exact code.
