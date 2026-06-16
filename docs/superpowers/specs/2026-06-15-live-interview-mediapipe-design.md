# Live interview — MediaPipe analysis (no audio, no report)

**Date:** 2026-06-15
**Status:** Approved design

## Goal

Wire the `/live` route so that pressing **Start interview** on `/new` opens a working
live interview that runs the MediaPipe analysis. This is the first of three steps:

1. **(this spec)** MediaPipe live analysis on `/live`.
2. Next: add audio (Deepgram voice agent) during the live interview.
3. Later: results/report page + saving the session.

## Out of scope (by request)

- No audio / Deepgram yet.
- No results page.
- No saving the session (no `POST /api/session`, no emotion upload).

## What already exists

- [app.js](../../../frontend/app.js) — the old, proven interview pipeline (face mesh,
  pose, hands+gestures, object detection, blendshapes, action detector). Hard-wired to
  `legacy.html` DOM ids and bundled with Deepgram + emotion upload + report POST.
- [vision.js](../../../frontend/vision.js) — clean MediaPipe module, but runs only one
  modality at a time (powers the `/facial` viewer). Not enough for a real interview.
- [registry.js](../../../frontend/screens/registry.js) — `/live` is a blank placeholder.
- [new.js](../../../frontend/screens/new.js) — "Start interview →" already navigates to
  `#/live`.

## Approach

Reuse the proven app.js pipeline, but decoupled from the DOM and trimmed to MediaPipe-only.

### 1. `frontend/interview-engine.js` (new) — DOM-free capture engine

- Loads the four MediaPipe models once and reuses them across start/stop (same pattern as
  `vision.js`'s `tasks`): FaceLandmarker (blendshapes + transform matrix), PoseLandmarker,
  GestureRecognizer, ObjectDetector. All four use the **GPU delegate** (`delegate: 'GPU'`)
  so inference runs on the GPU instead of saturating the main thread.
- `start(canvas, { onStats, onAction, showOverlay, audio })`:
  - Opens the camera capped at **30fps** (`frameRate: { ideal: 30, max: 30 }`); audio is
    captured for the voice agent unless `audio: false` (vision-only fallback).
  - Runs one `requestAnimationFrame` loop, mirroring app.js's `renderLoop`:
    - **Skips duplicate frames** (rAF ~60fps vs camera ~30fps) so MediaPipe never runs
      twice on the same image — this caps all inference at ~30fps.
    - Per unique frame: face detect → draw face mesh (overlay only), read blendshapes
      (`bs`) and transformation matrix (`m`), face count.
    - Throttled (`CONFIG.POSE_THROTTLE_MS`): hand skeleton + gestures always; **pose
      connectors + object boxes only when `showOverlay` is true** — the live interview
      runs overlay-off, so those two models are skipped to keep video + audio smooth.
    - Feed the action detector (`turn` fixed at `-1`, no transcript yet); emit each event
      via `onAction`.
  - `onStats` is throttled to ~4/s to avoid DOM thrash: `{ elapsedMs, face, faceCount,
    fps, detections }`.
- `stop()` — idempotent: stop loop, release camera tracks. Mirrors vision.js's
  supersede-guard so a double start can't leak a stream.
- `isRunning()`.
- No `frames[]` collection, no emotion crops, no network calls. (Frame capture + report
  bolt on in step 3; the per-frame object is already built, so adding it later is small.)

### 2. `frontend/screens/live.js` (new) — the live screen

- Layout reuses the existing `.fa-*` classes for visual consistency with `/facial`:
  - Left rail: elapsed time, face ✓/✗, FPS, detections (live status), plus a **Stop**
    button and a **Start** button for restarting in place.
  - Stage: big video canvas with a `LIVE` badge and a "Loading model… / Camera blocked"
    placeholder.
  - Below the rail or beside the stage: a **live actions feed** — a scrolling list of
    detected actions (nods, smiles, gestures) with a timestamp + icon, newest at the
    bottom. New class `.live-feed` / `.live-act` in `clean-studio.css`.
- On entry: **auto-start** the engine (the user already clicked Start on `/new`). Show
  "Loading model…" during the multi-second model download, then the live feed.
- **Stop** behavior: tear down the camera, **stay on `/live`**, show a "Stopped — press
  Start" state. Start re-runs the engine in place.
- Auto-teardown on navigate-away (same `hashchange` one-shot pattern as `facial.js` and
  `new.js`).

### 3. `frontend/screens/registry.js` — swap the placeholder

Replace the `/live` placeholder with `import { live } from './live.js'` and `['/live', live]`.

### 4. `frontend/styles/clean-studio.css` — small additions

Add `.live-feed` (scroll container) and `.live-act` (one row: time · icon · label) styles,
matching the existing card/rail tokens. Reuse `.fa-grid`, `.fa-rail`, `.fa-stage`,
`.fa-live`, `.fa-panel`, `.fa-stat`, `.fa-btn`, `.lab` as-is.

## Data flow

```
/new  --Start interview-->  #/live
                              |
                              v
                live.js  --start(canvas, {onStats, onAction})-->  interview-engine.js
                   ^                                                   |
   onStats (4/s) ──┘  updates rail        onAction ──> appends to live actions feed
                              draws overlay on canvas every frame
```

## Error handling

- Camera blocked / `getUserMedia` rejects: show "Camera unavailable: <message>" in the
  stage placeholder; the Start button re-enables for a retry. (Same shape as facial.js.)
- A single bad detection frame must not kill the loop (try/catch inside the loop, like
  app.js and vision.js).
- Navigating away mid-load must release the stream (supersede guard).

## Testing

- Manual: from `/new`, click Start → camera opens, face mesh draws, rail updates, smiling
  / nodding / a thumbs-up appears in the actions feed. Stop → camera releases (webcam
  light off), screen shows the stopped state, Start restarts. Navigate away → camera
  releases.
- No automated frontend test harness exists for the vision screens (they need a camera),
  so this stays manual, consistent with `/facial`.

## Why this shape

- Reusing the proven app.js detection logic de-risks the core analysis.
- A DOM-free engine keeps the per-frame logic testable and lets the `/live` screen own
  only layout + wiring — and lets step 2 (audio) and step 3 (report) attach to the engine
  without rewriting the screen.
- Keeping `vision.js` untouched avoids regressing the `/facial` viewer.
