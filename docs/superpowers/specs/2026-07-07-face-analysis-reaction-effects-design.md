# Face Analysis reaction effects — design

- **Date:** 2026-07-07
- **Status:** Approved (ready for implementation plan)
- **Screen:** `/facial` — the Face Analysis page ([frontend/screens/facial.js](../../../frontend/screens/facial.js))

## Problem / goal

Give the Face Analysis page a playful, real-time reaction layer: when the camera reads a
strong facial emotion **or** a hand gesture, a short burst of matching emoji floats up over
the video and fades out. Facial emotions and hand gestures react **at the same time**. The
whole layer is behind an on/off toggle.

This is a self-contained, cosmetic addition. It does **not** change any scoring, any server
call, or the existing analysis panels.

### Non-goals

- No change to the live interview screen (`/live`) — this feature lives on `/facial` only.
- No "confused" emotion and no head nod/shake reactions (explicitly out of scope).
- No change to the blendshape bars, the Expression Analysis panel, or the HSEmotion / DeepFace track.
- No new backend endpoint and no persisted state.

## Signal → emoji map

Facial emotions come from the existing blendshape classifier
([frontend/emotion.js](../../../frontend/emotion.js) `dominantEmotion`). Hand gestures come
from MediaPipe's `GestureRecognizer`.

| Emotion | Emoji | Gesture (`categoryName`) | Emoji |
|---|---|---|---|
| happy | 😄 | `Thumb_Up` | 👍 |
| sad | 😢 | `Thumb_Down` | 👎 |
| surprise | 😮 | `Victory` | ✌️ |
| angry | 😠 | `Open_Palm` | ✋ |
| disgust | 🤢 | `Closed_Fist` | ✊ |
| fear | 😨 | `Pointing_Up` | ☝️ |
| contempt | 😒 | `ILoveYou` | 🤟 |

`neutral` → no burst. `None` gesture → no burst.

## The core change — run face + hands together

Today [frontend/vision.js](../../../frontend/vision.js) runs exactly **one** detector per
frame, chosen by the Face / Pose / Hands mode radio. Reacting to emotions and gestures at the
same time needs the face detector (blendshapes → emotion) **and** the gesture recognizer
running together. All three MediaPipe tasks are already created in `ensureTasks()`
(`tasks.face`, `tasks.pose`, `tasks.hands`), so no new models are needed — only the loop
changes.

Make the loop **capability-based** instead of strictly single-mode:

- **Effects OFF** → behavior is unchanged. One detector runs, exactly as today. This is the
  safe default path and keeps the analysis tool identical when effects aren't wanted.
- **Effects ON** → each frame:
  - `runFace   = (mode === 'face')  || effectsOn`
  - `runGesture= (mode === 'hands') || effectsOn`
  - `runPose   = (mode === 'pose')`
  - The detector that matches the current draw mode runs **every frame** (as today). A
    detector needed only for effects (not the current mode) runs **throttled to ~10 fps**
    (`EFFECTS_INTERVAL_MS = 100`). Bursts have cooldowns and don't need 30 fps, so this caps
    the extra CPU cost.
  - Overlay drawing is unchanged: mesh drawn only in `face` mode, hand landmarks only in
    `hands` mode, pose only in `pose` mode. The effects-only detectors run headless (no draw).

The `onFrame(out)` payload gains two fields:

- `out.blendshapes` — set whenever the face detector ran this frame (already present in face
  mode; now also present, throttled, when effects are on in other modes).
- `out.gestures` — array of top gesture `categoryName` per detected hand (e.g.
  `['Thumb_Up']`), set whenever the gesture recognizer ran this frame; `undefined` on frames
  where it didn't run.

`undefined` vs. empty array matters for the trigger logic (see below): `undefined` = "no new
info this frame" (a throttled frame), `[]` = "hands are down".

## Architecture

Three touch points; the effects logic is isolated in one new file.

### New: `frontend/face-effects.js`

Self-contained. Owns the emoji overlay and the trigger logic. No imports from the scoring
path except `dominantEmotion` from `emotion.js`.

```
createFaceEffects(containerEl) -> {
  setEnabled(on: boolean),        // show/hide the layer; when turned off, clears active emoji
  feed({ bs, gestures, t }),      // called per (throttled) frame while enabled
  clear(),                        // remove all active emoji immediately
  destroy(),                      // remove listeners + DOM, full teardown
}
```

`feed()` behavior:

- If `bs` is present → run the **emotion trigger** (below).
- If `gestures` is an array → run the **gesture trigger** (below). If `gestures` is
  `undefined`, skip gesture handling this call (throttled frame, no new info — do **not** reset
  the active-gesture set).
- `t` is the caller's timestamp (`performance.now()`), passed in so the trigger cooldowns are
  testable without a real clock.

**Emotion trigger** (debounced, one burst per onset):

- `EMOTION_MIN_SCORE = 50` (percent, from `dominantEmotion(bs).value`)
- `SUSTAIN_FRAMES = 3` — the same non-neutral emotion must be dominant and above threshold for
  this many consecutive `feed()` calls before it fires.
- `EMOTION_COOLDOWN_MS = 2500` per emotion — blocks repeat bursts of the same emotion.
- `neutral` never fires.

**Gesture trigger** (fire on onset):

- Track the set of active gesture names. A gesture fires when it appears and was not in the
  previous set (set-diff), subject to `GESTURE_COOLDOWN_MS = 1500` per gesture.
- Filter out `None` / null.

**Burst rendering** (floating emoji):

- `burst(emoji)` spawns `PARTICLES = 6` emoji `<span>`s near the bottom-centre of the overlay,
  each with randomized x offset, drift, rotation, and size, animated up + fading over
  `~1400 ms` via CSS transform/opacity, removed on `animationend`.
- `MAX_ACTIVE = 24` concurrent emoji; new bursts are dropped (or trim oldest) past the cap.
- `prefers-reduced-motion: reduce` → fewer particles (2–3) and a shorter, gentler animation.
- The overlay is a **DOM layer** (not drawn on the canvas), so canvas mirroring doesn't flip
  the emoji and the analysis canvas is untouched.

Emoji CSS lives with the existing styles (`frontend/style.css` or `frontend/styles/`; decided
during planning to match how `.fa-*` classes are currently loaded).

### Changed: `frontend/vision.js`

- Add `export function setEffects(on)` — sets the module/session `effectsOn` flag read by the
  loop.
- Loop becomes capability-based (see above); add throttle timestamps to the session.
- Add `out.gestures`; ensure `out.blendshapes` is populated whenever the face detector ran.
- Effects OFF path stays byte-for-byte equivalent to today.

### Changed: `frontend/screens/facial.js`

- Render an overlay mount point inside `.fa-stage` (e.g. `<div class="fa-fx" id="fa-fx">`).
- In `queueMicrotask`, `createFaceEffects(...)` on that element; add a "Reaction effects"
  on/off toggle to the left rail; wire it to `effectsOn`, `vision.setEffects(...)`, and
  `effects.setEnabled(...)`. Turning it off calls `effects.clear()`.
- In `onFrame(out)`, when effects are on, call
  `effects.feed({ bs: out.blendshapes, gestures: out.gestures, t: performance.now() })`.
- On the existing navigate-away teardown (the `hashchange` `leave` handler) and on `stopCamera`,
  call `effects.destroy()` / `effects.clear()` so nothing leaks between screens.

## Toggle + default

A "Reaction effects" On/Off control in the left rail (same `.seg` button style as the emotion
engine switch). **Default: ON** — the feature is the point; the user flips it off when reading
raw blendshapes. Toggling is instant and independent of Start/Stop.

## Scope guarantee

Purely client-side and cosmetic:

- No new network calls. No change to `/api/emotion/frame` or any endpoint.
- No change to the blendshape bars, the Expression Analysis panel, or the HSEmotion/DeepFace
  reading. The effects layer only adds a DOM overlay and, when on, some extra throttled
  inference.
- Effects OFF reproduces today's behavior exactly.

## Testing

- Unit-test the pure trigger logic in `face-effects.js` by driving `feed()` with synthetic
  `{ bs, gestures, t }` sequences:
  - emotion fires only after `SUSTAIN_FRAMES` above threshold, and not again within
    `EMOTION_COOLDOWN_MS`;
  - `neutral` never fires;
  - a gesture fires once on onset and not again within `GESTURE_COOLDOWN_MS`;
  - a throttled frame (`gestures === undefined`) does not reset the active-gesture set.
- Confirm the frontend test setup during planning (repo currently has a Python/pytest suite;
  verify whether a JS runner exists or add a minimal one for this pure module).

## Docs to update

- README.md — Face Analysis section: mention the reaction-effects toggle.
