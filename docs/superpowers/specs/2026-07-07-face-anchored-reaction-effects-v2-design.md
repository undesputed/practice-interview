# Face-anchored reaction effects (v2) — design

- **Date:** 2026-07-07
- **Status:** Approved (ready for implementation plan)
- **Screen:** `/facial` — the Face Analysis page ([frontend/screens/facial.js](../../../frontend/screens/facial.js))
- **Supersedes:** the generic bottom-burst overlay from
  [2026-07-07-face-analysis-reaction-effects-design.md](2026-07-07-face-analysis-reaction-effects-design.md).
  This is an enhancement on the same branch (`feat/face-analysis-reaction-effects`).

## Problem / goal

The first version bursts generic emoji up from the bottom of the video. The user wants effects
that are **clear, literal, and pinned to the face**, tracking it while the expression holds:
- 😢 **Sad** → tears welling and falling from under both eyes
- 😠 **Angry** → fire flickering above the head
- 😕 **Confused** → question marks bobbing above the head
- 👍 **Thumbs up** → an "OK!" callout (and a labeled callout for every gesture)

This is a **bigger build**: a real canvas-based particle engine with custom-drawn art (not plain
emoji), anchored to MediaPipe face/hand landmarks. Still `/facial`-only and purely cosmetic.

### Non-goals
- No change to the live interview screen (`/live`) or any scoring/analysis/network path.
- No change to the blendshape bars, the Expression Analysis panel, or the HSEmotion/DeepFace track.
- No third-party particle library — the engine is hand-rolled on `<canvas>` (keeps the project's
  "no build, no npm" property; MediaPipe stays the only CDN dependency).

## Effect map

**Emotions** — a sustained emitter that runs while the expression is the active emotion, anchored
to face landmarks, fading in/out on enter/exit:

| Signal | Effect | Anchor landmark(s) |
|---|---|---|
| Sad | blue teardrop particles welling then falling under the eyes | under-eye L/R |
| Angry | rising flame particles (yellow→orange→red→smoke), flicker | above forehead |
| Confused | 3 "?" glyphs bobbing/orbiting | above forehead |
| Happy | twinkling star/sparkle particles scaling in/out | around face bounds |
| Surprise | a bobbing "!" plus a one-shot expanding ring on enter | above forehead |
| Disgust | greenish wavy particles drifting | near the mouth |
| Fear | cold-sweat droplets sliding down | temples L/R |

Only ONE emotion effect is active at a time (the dominant one). `neutral` → nothing.

**Gestures** — a one-shot labeled callout (rounded badge, scale-in → hold → fade-out over ~1s),
anchored near the detected hand (falls back to top-center if no hand landmarks):

| Gesture | Callout |
|---|---|
| Thumb_Up | "OK!" (green) |
| Thumb_Down | "Nope" (red) |
| Victory | "Nice!" |
| Open_Palm | "Hi!" |
| Closed_Fist | "Strong!" |
| Pointing_Up | "Idea! 💡" |
| ILoveYou | "Love! 💜" |

## Detection model change

The v1 trigger emitted a one-shot emoji array on onset. v2 splits into two behaviors:

- **Emotions are state-based.** The trigger tracks the currently-active emotion with hysteresis:
  - *Enter:* a non-neutral emotion is dominant AND ≥ `EMOTION_ENTER_SCORE` for `SUSTAIN_FRAMES`
    consecutive feeds.
  - *Exit:* the active emotion drops below `EMOTION_EXIT_SCORE` (a lower bar than enter — hysteresis
    to avoid flicker), or a different emotion satisfies the enter condition and replaces it.
  - The effects engine renders the active emotion's emitter continuously while active, so the effect
    tracks the face frame-to-frame; on exit it fades out.
- **Gestures stay one-shot** (onset + `GESTURE_COOLDOWN_MS`), unchanged from v1.

### "Confused" is approximated
`confused` is NOT a class the emotion detector produces. Compute a `confusedScore` from blendshapes:
a furrowed brow (`browDownLeft`/`browDownRight`) combined with a slight mouth press/asymmetry and the
ABSENCE of a strong happy/sad/surprise read. Fold it into the active-emotion selection: if
`confusedScore` clears its own threshold and no real emotion is stronger, the active emotion is
`confused`. This is a best-effort heuristic and will sometimes misfire — accepted by the user. Its
threshold/weights are tunable constants, kept alongside the other trigger constants.

## Architecture

### New: `frontend/reaction-trigger.js` (reworked)
Pure, unit-tested. `feed({ bs, gestures, t })` now returns:
```
{ activeEmotion: string | null,   // one of the 7 emotions or 'confused', or null
  gestureOnsets: string[] }        // gesture categoryNames that just fired (post-cooldown)
```
Holds the emotion state machine (enter/exit hysteresis), the `confusedScore` heuristic, and the
gesture onset/cooldown logic. `undefined` gestures → skip gesture handling without resetting state.
Constants (all tunable): `EMOTION_ENTER_SCORE`, `EMOTION_EXIT_SCORE`, `SUSTAIN_FRAMES`,
`GESTURE_COOLDOWN_MS`, `CONFUSED_*` weights/threshold.

### New: `frontend/fx/particles.js`
A small hand-rolled particle engine, DOM-free and unit-testable for its pure math:
- `createParticle(cfg)`, an update step `stepParticle(p, dt)` (position, velocity, gravity, life),
  and helpers for spawning. No canvas calls here — pure state so it can be tested.

### New: `frontend/fx/emitters.js`
One emitter per emotion + the gesture-callout animation. Each emitter is a factory:
`createTearsEmitter()`, `createFireEmitter()`, `createConfusedEmitter()`, `createSparkleEmitter()`,
`createSurpriseEmitter()`, `createDisgustEmitter()`, `createFearEmitter()`. Each exposes
`update(anchors, dt)` (spawns/steps its particles) and `draw(ctx)` (custom canvas art:
gradient flames, highlighted droplets, twinkling stars, "?" glyphs, badges). Emitters own their
particle arrays and spawn rates; the engine calls the active one each frame.

### New: `frontend/face-effects.js` (reworked from v1)
Owns the `<canvas>` overlay and the render loop. `createFaceEffects(canvasEl)` returns
`{ setEnabled(on), feed({ bs, gestures, faceLandmarks, handLandmarks, t }), clear(), destroy() }`.
Responsibilities:
- Size the canvas backing store to the stage's client size × `devicePixelRatio`; recompute on resize.
- Map normalized landmarks → canvas pixels, **mirrored** (`x → 1 - x`) to match the selfie-mirrored
  video (`.fa-stage canvas` is `transform:scaleX(-1)`); mirror in code so drawn text/art is not reversed.
- Extract anchor points from `faceLandmarks` (indices below) each frame.
- Compose the trigger + emitters: run the active emotion's emitter and fire gesture callouts;
  `requestAnimationFrame` render loop; `clear()`/`destroy()` stop the loop and wipe the canvas.

**Anchor landmark indices** (MediaPipe Face Mesh; starting values — TUNE in-browser during the
plan's calibration step): under-eye L `145`, under-eye R `374`, forehead-top `10`, temple L `234`,
temple R `454`, mouth `13`, eye corners `33`/`263` (for optional roll). Face bounds from the min/max
of all landmarks. Hand anchor: wrist landmark `0` of the first detected hand.

### Changed: `frontend/vision.js`
Extend the per-frame `onFrame(out)` payload (built in Task 3 of v1) to also surface:
- `out.faceLandmarks` — the raw face landmark array (`session._face`) when the face detector ran, else `undefined`.
- `out.handLandmarks` — the detected hands' landmark arrays when the gesture recognizer ran, else `undefined`.
`out.blendshapes` and `out.gestures` stay as-is. Effects OFF path stays unchanged.

### Changed: `frontend/screens/facial.js`
Replace the v1 `<div class="fa-fx">` with `<canvas id="fa-fx-canvas" class="fa-fx">` inside `.fa-stage`.
Feed `{ bs: out.blendshapes, gestures: out.gestures, faceLandmarks: out.faceLandmarks,
handLandmarks: out.handLandmarks, t: performance.now() }`. The "Reaction effects" toggle, default-ON,
and navigate-away teardown carry over from v1.

### Styles: `frontend/styles/clean-studio.css`
Replace the v1 `.fa-fx`/`.fx-emoji` DOM rules with canvas-overlay rules: `.fa-fx{position:absolute;
inset:0;pointer-events:none;z-index:3}` (a canvas element). Remove the now-unused emoji keyframes.

## Coordinate mapping details
- The stage is `aspect-ratio:16/9`; the video canvas is 1280×720 (also 16/9) with `object-fit:cover`,
  so the full frame is shown with no cropping → normalized coords map linearly to the displayed area.
- Overlay pixel: `px = (1 - norm.x) * cssW * dpr`, `py = norm.y * cssH * dpr` (x mirrored; scale by
  `devicePixelRatio` since the backing store is DPR-scaled). Re-read `cssW/cssH` on resize.

## Performance
- Cap total live particles (e.g. `MAX_PARTICLES = 300`); each emitter has a bounded spawn rate.
- Only the ONE active emotion emitter runs; inactive emitters hold no particles.
- The render loop runs only while effects are enabled and the screen is mounted; `destroy()` cancels it.
- Honor `prefers-reduced-motion`: lower spawn rates and disable the flicker/orbit motion.

## Scope guarantee
Purely client-side and cosmetic: no new network calls; the blendshape bars, Expression Analysis panel,
and DeepFace track are untouched; effects OFF reproduces today's `vision.js` behavior exactly.

## Testing
- Unit-test (Node `node:test`) the pure logic:
  - `reaction-trigger.js`: emotion enter after `SUSTAIN_FRAMES` ≥ enter-score; stays active through
    the hysteresis band; exits below exit-score; switches when a stronger emotion enters; `neutral`/
    below-threshold → null; `confusedScore` selects `confused` when brow-down dominates and no real
    emotion is stronger; gesture onset fires once + respects cooldown; `undefined` gestures don't reset.
  - `fx/particles.js`: `stepParticle` integrates position/velocity/gravity and expires at end of life.
- Canvas rendering, anchoring, and the visual look are verified by the human in-browser (camera), incl.
  an anchor-index calibration/tuning pass.

## Docs to update
- README.md — update the Face Analysis reaction-effects bullet to describe the face-anchored effects.
