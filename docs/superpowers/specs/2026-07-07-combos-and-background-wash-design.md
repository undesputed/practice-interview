# Two-hand gesture combos + background color wash — design

- **Date:** 2026-07-07
- **Status:** Approved (ready for implementation plan)
- **Screen:** `/facial` — the Face Analysis page ([frontend/screens/facial.js](../../../frontend/screens/facial.js))
- **Builds on:** the face-anchored reaction effects
  ([2026-07-07-face-anchored-reaction-effects-v2-design.md](2026-07-07-face-anchored-reaction-effects-v2-design.md)),
  same branch `feat/face-analysis-reaction-effects`.

## Problem / goal

Two additions to the reaction-effects layer, requested together:

1. **Two-hand gesture combos + proper per-hand callouts.** The gesture recognizer already runs
   with `numHands: 2`, but the trigger dedupes gestures into a set (so both 👍 collapse to one
   callout) and anchors every callout to the first hand (so two different gestures overlap). Fix
   the per-hand handling AND add recognized two-hand **combos** with their own bigger callout.
2. **Background color wash.** Beyond the local effect at the face/hand, tint the **whole frame**
   to react — a translucent edge-vignette glow colored by the active emotion (sustained) plus a
   quick color flash on each gesture/combo onset.

Both are `/facial`-only, purely cosmetic (the wash tints the *displayed* video on the overlay
canvas; the analysis reads the raw camera, so no scoring/analysis changes), behind the existing
"Reaction effects" toggle, and add no new MediaPipe model.

### Non-goals
- No real background replacement / body segmentation (explicitly chose the color wash over that).
- No change to `/live`, the interview engine, the backend, or any scoring/analysis.
- No new detection: `vision.js` already surfaces per-hand `gestures` and `handLandmarks`.

## Feature A — two-hand combos + per-hand callouts

### Combo set
| Both hands | id | callout | color |
|---|---|---|---|
| 👍 + 👍 | `awesome` | AWESOME! | `#3ddc84` |
| 👎 + 👎 | `big_no` | BIG NO | `#ff5c5c` |
| ✌️ + ✌️ | `peace` | PEACE ✌ | `#ffd54a` |
| ✊ + ✊ | `pumped` | PUMPED! | `#ff9f43` |
| ✋ + ✋ | `woo` | WOO! | `#7fc7ff` |
| 🤟 + 🤟 | `love` | LOVE!! | `#c98bff` |
| 👍 + 👎 | `mixed` | MIXED | `#ffe08a` |

### Behavior
- Each frame, if both hands' gestures form a combo → fire one **combo onset** (bigger callout,
  centered between the two hands) and **suppress the individual callouts** that frame.
- Otherwise → each hand fires its **own** callout anchored at **that hand**.
- One hand → one callout at that hand (as today, but anchored to the real hand).
- Combos get their own `GESTURE_COMBO_COOLDOWN_MS` (1500) so they fire once per formation.

### New pure module `frontend/fx/combos.js`
Pure data + matcher, unit-tested:
```
export const GESTURE_COMBOS = { <id>: { gestures: [g1, g2], text, color }, ... }  // the table above
export function detectCombo(gestures) -> string|null
  // filter out None/null; order-independent multiset match against each combo's pair;
  // returns the first matching combo id, else null.
```

### `frontend/reaction-trigger.js` (gesture path becomes hand-aware)
`feed({ bs, gestures, t })` return shape changes:
```
{ activeEmotion: string|null,
  gestureOnsets: Array<{ gesture: string, hand: number }>,   // individual; hand = index into gestures/handLandmarks
  comboOnsets: string[] }                                     // combo ids
```
Logic (emotion state machine unchanged):
- `comboId = detectCombo(gestures)`.
- If `comboId`: fire it (once) when it differs from the currently-held combo and its cooldown has
  elapsed; set the held combo; **skip individual onsets** this frame but still refresh the
  individual active-gesture set to the current gestures (so breaking the combo while hands stay
  up doesn't spuriously fire individuals).
- Else: clear the held combo; for each hand showing a gesture, fire an individual onset when that
  gesture name is newly present + its per-name cooldown; `hand = gestures.indexOf(gesture)` for
  anchoring. (Two different gestures → two onsets at two hands; same non-combo gesture on both
  hands → one onset — combos cover the same-gesture pairs.)
- `undefined` gestures → skip gesture handling without resetting state (unchanged).

### `frontend/face-effects.js`
- `handAnchor(handLandmarks, i)` → wrist (`landmarks[i][0]`) of hand `i` via `mapPoint`, or null.
- Individual onsets: spawn each callout at `handAnchor(sample.handLandmarks, onset.hand)` using
  `GESTURE_CALLOUTS[onset.gesture]`.
- Combo onsets: spawn a **bigger** callout at the **midpoint** of the two hands' wrists (fallback
  top-center) using `GESTURE_COMBOS[comboId]`.

### `frontend/fx/emitters.js`
`createCalloutLayer().spawn(text, color, anchor, w, h, sizeMul = 1)` — add `sizeMul` so combo
callouts render larger (≈1.6×); the draw multiplies the font/badge by it.

## Feature B — background color wash

### Emotion → wash color
| angry | happy | sad | surprise | disgust | fear | confused |
|---|---|---|---|---|---|---|
| `#ff3b30` | `#ffcf40` | `#3b6dff` | `#ffffff` | `#6fd23a` | `#8a5cff` | `#ffb84d` |

### Style
An **edge vignette**: a radial gradient, transparent in the center → the wash color at the edges,
so the face stays clear while the ambience shifts. Sustained while an emotion is active (eases in
on enter, out on exit). Gesture/combo onsets add a brief **pulse** in the gesture/combo's color.

### New pure module `frontend/fx/wash.js`
```
export const EMOTION_WASH = { <emotion>: '#rrggbb', ... }   // the table above
export function createWash() -> {
  setEmotion(emotion|null),   // target color; null = fade out
  pulse(hexColor),            // add a decaying flash (~500ms)
  update(dt),                 // ease intensity toward target; decay pulses
  draw(ctx, w, h),            // vignette gradient at current intensity + pulse flashes
  intensity(),                // current 0..1 (for tests)
  clear(),
}
```
Constants: `WASH_BASE = 0.38` (edge alpha while an emotion is active), `WASH_EASE_MS ≈ 250`,
`PULSE_PEAK = 0.3`, `PULSE_LIFE_MS = 500`. Vignette inner radius ≈ 0.35·maxDim (clear center),
outer ≈ 0.78·maxDim. A pure `hexToRgb` helper handles color parsing.

### `frontend/face-effects.js` integration
- Own a `wash = createWash()`.
- In the render loop, **before** drawing the emitters: `wash.setEmotion(activeEmotion);
  wash.update(dt); wash.draw(ctx, canvas.width, canvas.height);` (so the wash sits under the
  particles/callouts).
- In `feed`, on each individual onset → `wash.pulse(GESTURE_CALLOUTS[gesture].color)`; on each
  combo onset → `wash.pulse(GESTURE_COMBOS[id].color)`.
- `clear()`/`destroy()` also clear the wash.

## Scope guarantee
Purely client-side and cosmetic: no new network calls; the wash draws only on the overlay canvas
(never on the analysis canvas), so blendshape bars, the Expression Analysis panel, the
HSEmotion/DeepFace track, and all scoring are unchanged. Effects OFF is unchanged.

## Testing
Unit tests (`node:test`):
- `fx/combos.js`: `detectCombo` matches each pair order-independently; non-combo pairs → null;
  `<2` gestures or `None` → null; `GESTURE_COMBOS` has the 7 ids with the exact text/color.
- `reaction-trigger.js`: combo onset fires once per formation + respects cooldown; a combo frame
  suppresses individual onsets; non-combo two-hand frame yields per-hand onsets with correct
  `hand` indices; `undefined` gestures don't reset; emotion state machine still passes.
- `fx/wash.js`: `EMOTION_WASH` has the 7 keys; `intensity()` rises toward base while an emotion is
  set and decays to ~0 after `setEmotion(null)`; a `pulse` decays to 0.
- Canvas visuals (vignette look, per-hand/combo callout placement) verified on camera.

## Docs to update
- README.md — extend the reaction-effects bullet to mention two-hand combos and the background wash.
