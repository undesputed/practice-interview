# Live Hand + Gesture Overlay — Design

**Date:** 2026-06-03
**Status:** Approved (pending spec review)
**Builds on:** the interview app + body-language signals (`2026-06-03-body-language-and-transcription-design.md`)

## 1. Purpose

During the interview, the face already shows a live MediaPipe mesh overlay. Add the same
kind of live overlay for the **hands** — a hand skeleton drawn on the webcam canvas — plus a
small **gesture label** (e.g. "Right: Open_Palm"). This makes the hand tracking visible to
the user, matching the face-mesh experience. Frontend-only; no report/metric changes.

## 2. Core decision

**Approach A:** Replace the current `HandLandmarker` with the MediaPipe **Gesture Recognizer**.
The Gesture Recognizer returns the same 21 hand landmarks (so existing hand metrics — fidget,
face-touch — keep working unchanged) **and** a recognized gesture per hand for the label.
One hand model, not two.

## 3. Behavior

- **Model swap:** `gestureRecognizer` (model `gesture_recognizer.task`, `numHands: 2`,
  `runningMode: "VIDEO"`) replaces `handLandmarker`. Detection stays throttled (~8/sec) in the
  render loop, exactly as hands are now.
- **`pickHands()` unchanged in shape:** it still reads `result.landmarks` (21 points) and the
  handedness field to emit `{handedness, wrist, indexTip, middleTip}` per hand. It is made
  tolerant of the field-name difference (`handedness` vs `handednesses`) between the two models.
  So the `Frame.hands` contract and all backend metrics are **unaffected**.
- **Smooth overlay despite throttling:** the most recent Gesture Recognizer result is cached
  (`lastHandResult`). The hand skeleton (21 landmarks + `HAND_CONNECTIONS`, via `DrawingUtils`)
  is **drawn every frame** from the cache — like the face mesh — so it doesn't flicker at the
  ~8/sec detection rate. When a throttled detection finds no hands, the cache is cleared so the
  overlay disappears (~one throttle interval after the hands leave the frame).
- **Gesture label:** for each detected hand, draw the top gesture's `categoryName` + score on
  the canvas (e.g. "Right: Open_Palm 0.92"). Gestures like `None`/empty render nothing.
- **Draw order each frame:** video → face mesh (fresh) → hand skeleton (cached) → gesture label.

## 4. Scope

- **Visual only.** The gesture name is NOT written to `Frame`, metrics, the report, or saved
  files. (A "gestures used" metric could be added later — out of scope now.)
- **Pose:** no skeleton overlay (metrics-only), per the chosen scope.
- **No backend changes**, no test changes (browser-only canvas drawing).

## 5. Files

- `frontend/config.js` — replace `HAND_MODEL_URL` with `GESTURE_MODEL_URL`
  (`.../gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task`).
- `frontend/app.js` — import `GestureRecognizer` (and keep `HandLandmarker` import only for the
  `HAND_CONNECTIONS` constant used in drawing); create `gestureRecognizer` in `initLandmarker`
  instead of `handLandmarker`; in the throttled block, call `gestureRecognizer.detectForVideo`,
  update `lastHandResult`; each frame draw the cached hand skeleton + gesture label.
- `frontend/landmarks.js` — `pickHands` reads `result.handedness || result.handednesses` so it
  works with the Gesture Recognizer result shape.

## 6. Error handling

- No hands detected → cache cleared → no hand overlay/label (face mesh unaffected).
- Detection throwing (e.g., during model warm-up) is already caught in the throttled block and
  logged; the loop continues.
- If `HAND_CONNECTIONS` is not exposed on the imported class at the pinned version, fall back to
  drawing landmark dots only (still a visible overlay). Verify during implementation.

## 7. Out of scope

Recording/labeling gestures in the report, pose skeleton overlay, custom-trained gestures,
multi-person hands.
