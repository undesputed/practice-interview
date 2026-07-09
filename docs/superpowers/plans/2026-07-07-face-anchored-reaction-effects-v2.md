# Face-Anchored Reaction Effects (v2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the generic bottom-burst overlay on `/facial` with a canvas particle engine that renders distinct, custom-drawn effects pinned to the face and hands — tears under the eyes when sad, fire above the head when angry, question marks when confused, sparkles/surprise/disgust/fear, and a labeled callout per hand gesture.

**Architecture:** A pure state-machine trigger picks the single active emotion (with hysteresis) and gesture onsets. A hand-rolled canvas particle engine (`fx/particles.js`) plus one custom-drawing emitter per effect (`fx/emitters.js`) render onto a `<canvas>` overlay, anchored to MediaPipe face/hand landmarks (`fx/anchors.js`, mirrored to match the selfie video). `vision.js` surfaces the landmark arrays; `facial.js` owns the toggle and feeds frames.

**Tech Stack:** Vanilla ES modules (browser), Canvas 2D, MediaPipe `tasks-vision` (already loaded from CDN), Node's built-in `node:test` for the pure logic. No new runtime dependencies.

## Global Constraints

- Continue on the existing branch `feat/face-analysis-reaction-effects` (do NOT create a new branch; the v1 code is already there and is being reworked).
- Feature lives on `/facial` ONLY. Do NOT touch `/live`, `interview-engine.js`, `deepgram-client.js`, or any backend/`.py` file.
- Purely cosmetic: NO new network calls; must NOT change the blendshape bars, the Expression Analysis panel, the HSEmotion/DeepFace track, or any scoring.
- Effects OFF must reproduce the original `vision.js` single-detector-per-mode behavior exactly.
- Emotion effects: exactly ONE active at a time. Set = happy, sad, surprise, angry, disgust, fear, confused. `neutral` and `contempt` produce nothing.
- Gesture callouts (MediaPipe `categoryName` → text/color): `Thumb_Up`→"OK!" `#3ddc84`; `Thumb_Down`→"Nope" `#ff5c5c`; `Victory`→"Nice!" `#ffd54a`; `Open_Palm`→"Hi!" `#7fc7ff`; `Closed_Fist`→"Strong!" `#ff9f43`; `Pointing_Up`→"Idea! 💡" `#ffe08a`; `ILoveYou`→"Love! 💜" `#c98bff`. `None`→nothing.
- Trigger constants: `EMOTION_ENTER_SCORE = 45`, `EMOTION_EXIT_SCORE = 25`, `SUSTAIN_FRAMES = 3`, `GESTURE_COOLDOWN_MS = 1500`. Confused heuristic: `CONFUSED_BROW_MIN = 0.35`, `CONFUSED_SCORE_SCALE = 130`.
- Render constants: `MAX_PER_EMITTER = 120` (only the active emotion spawns, so live particles stay well bounded). Coordinate mapping mirrors X (`x → 1 - x`) to match the CSS-mirrored video canvas (`.fa-stage canvas { transform: scaleX(-1) }`); backing store scaled by `devicePixelRatio`. Honor `prefers-reduced-motion` (lower spawn rates, no flicker/orbit).
- Default: reaction-effects toggle ON.
- Active stylesheet is `frontend/styles/clean-studio.css`. Do NOT touch legacy `frontend/style.css`.
- `frontend/package.json` already sets `{"type":"module"}`, so files under `frontend/` (including `frontend/fx/`) run as ESM under `node --test`.
- Each task commits ONLY its own files. The repo has unrelated pre-existing uncommitted changes (`README.md`, `deploy/*`) — never stage those.

---

### Task 1: Rework the trigger into an emotion state machine

Replace the v1 onset-emoji trigger with a state machine that returns the single active emotion (hysteresis) plus gesture onsets, and computes a `confused` heuristic.

**Files:**
- Modify (rewrite): `frontend/reaction-trigger.js`
- Modify (rewrite): `frontend/reaction-trigger.test.js`

**Interfaces:**
- Produces: `createReactionTrigger(opts?) -> { feed({ bs?, gestures?, t }) -> { activeEmotion: string|null, gestureOnsets: string[] } }`
  - `opts.scores` (default `emotionScores` from `emotion.js`) → `{happy,sad,surprise,angry,disgust,fear,...}` on 0-100.
  - `opts.confusedScore` (default internal) → number 0-100 from blendshapes.
  - `opts.enterScore/exitScore/sustainFrames/gestureCooldownMs` override constants (for tests).
  - `bs` undefined → skip emotion update; `gestures` undefined → skip gesture handling without resetting the active-gesture set.
- Consumes: `emotionScores(bs)` from `frontend/emotion.js` (existing, pure).

- [ ] **Step 1: Rewrite the test file**

Replace the entire contents of `frontend/reaction-trigger.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReactionTrigger } from './reaction-trigger.js';

// Inject scores directly: the sample's bs IS the score object; confused comes from bs.confused.
const opts = { scores: (bs) => bs, confusedScore: (bs) => bs.confused || 0 };
const S = (o) => ({ happy: 0, sad: 0, surprise: 0, angry: 0, disgust: 0, fear: 0, confused: 0, ...o });

test('no emotion until a score sustains >= enter for SUSTAIN_FRAMES', () => {
  const t = createReactionTrigger(opts);
  assert.equal(t.feed({ bs: S({ sad: 80 }), t: 0 }).activeEmotion, null);
  assert.equal(t.feed({ bs: S({ sad: 80 }), t: 10 }).activeEmotion, null);
  assert.equal(t.feed({ bs: S({ sad: 80 }), t: 20 }).activeEmotion, 'sad'); // 3rd frame
});

test('stays active through the hysteresis band, exits below exit score', () => {
  const t = createReactionTrigger(opts);
  for (const ts of [0, 10, 20]) t.feed({ bs: S({ sad: 80 }), t: ts }); // active = sad
  assert.equal(t.feed({ bs: S({ sad: 30 }), t: 30 }).activeEmotion, 'sad'); // 30 in [25,45) -> hold
  assert.equal(t.feed({ bs: S({ sad: 20 }), t: 40 }).activeEmotion, null);  // < 25 -> exit
});

test('switches to a stronger different emotion after SUSTAIN_FRAMES', () => {
  const t = createReactionTrigger(opts);
  for (const ts of [0, 10, 20]) t.feed({ bs: S({ sad: 80 }), t: ts }); // active = sad
  // angry now dominant & >= enter; sad still above exit so it holds until the switch commits
  assert.equal(t.feed({ bs: S({ sad: 30, angry: 80 }), t: 30 }).activeEmotion, 'sad');
  assert.equal(t.feed({ bs: S({ sad: 30, angry: 80 }), t: 40 }).activeEmotion, 'sad');
  assert.equal(t.feed({ bs: S({ sad: 30, angry: 80 }), t: 50 }).activeEmotion, 'angry');
});

test('neutral / below-enter never activates', () => {
  const t = createReactionTrigger(opts);
  for (let i = 0; i < 5; i++)
    assert.equal(t.feed({ bs: S({ happy: 30 }), t: i * 10 }).activeEmotion, null); // 30 < 45
});

test('confused is selected when it is the strongest score', () => {
  const t = createReactionTrigger(opts);
  for (const ts of [0, 10, 20])
    assert.equal(t.feed({ bs: S({ confused: 70, angry: 20 }), t: ts }).activeEmotion, ts === 20 ? 'confused' : null);
});

test('gesture fires once on onset and respects cooldown', () => {
  const t = createReactionTrigger(opts);
  assert.deepEqual(t.feed({ gestures: ['Thumb_Up'], t: 0 }).gestureOnsets, ['Thumb_Up']);
  assert.deepEqual(t.feed({ gestures: ['Thumb_Up'], t: 16 }).gestureOnsets, []); // held
  assert.deepEqual(t.feed({ gestures: [], t: 32 }).gestureOnsets, []);
  assert.deepEqual(t.feed({ gestures: ['Thumb_Up'], t: 1000 }).gestureOnsets, []); // within cooldown
  assert.deepEqual(t.feed({ gestures: ['Thumb_Up'], t: 1600 }).gestureOnsets, ['Thumb_Up']); // after
});

test('undefined gestures does not reset the active set', () => {
  const t = createReactionTrigger(opts);
  assert.deepEqual(t.feed({ gestures: ['Open_Palm'], t: 0 }).gestureOnsets, ['Open_Palm']);
  assert.deepEqual(t.feed({ t: 10 }).gestureOnsets, []);                       // throttled frame
  assert.deepEqual(t.feed({ gestures: ['Open_Palm'], t: 20 }).gestureOnsets, []); // still held -> no refire
});

test('None gesture is ignored', () => {
  const t = createReactionTrigger(opts);
  assert.deepEqual(t.feed({ gestures: ['None'], t: 0 }).gestureOnsets, []);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test frontend/reaction-trigger.test.js`
Expected: FAIL — the current `feed` returns an array, not `{ activeEmotion, gestureOnsets }`, so assertions on `.activeEmotion`/`.gestureOnsets` fail.

- [ ] **Step 3: Rewrite the implementation**

Replace the entire contents of `frontend/reaction-trigger.js`:

```js
// frontend/reaction-trigger.js
// Pure decision core for the Face Analysis reaction effects. Tracks the single
// active emotion with enter/exit hysteresis (so effects don't flicker) and reports
// gesture onsets (debounced by a cooldown). No DOM — unit-tested.
import { emotionScores } from './emotion.js';

const EMOTION_ENTER_SCORE = 45;
const EMOTION_EXIT_SCORE = 25;
const SUSTAIN_FRAMES = 3;
const GESTURE_COOLDOWN_MS = 1500;
const CONFUSED_BROW_MIN = 0.35;
const CONFUSED_SCORE_SCALE = 130;

// The seven emotions that have effects (order = priority for ties). 'confused' is
// synthetic; 'contempt'/'neutral' from the classifier are intentionally excluded.
const EFFECT_EMOTIONS = ['angry', 'disgust', 'fear', 'happy', 'sad', 'surprise', 'confused'];

// Best-effort 'confused' from blendshapes: a furrowed brow (with a little mouth press).
// Not a real classifier class — approximate and tunable.
export function confusedScore(bs) {
  bs = bs || {};
  const brow = Math.max(bs.browDownLeft || 0, bs.browDownRight || 0);
  if (brow < CONFUSED_BROW_MIN) return 0;
  const press = Math.max(bs.mouthPressLeft || 0, bs.mouthPressRight || 0);
  return Math.min(100, (brow * 0.8 + press * 0.4) * CONFUSED_SCORE_SCALE);
}

export function createReactionTrigger(opts = {}) {
  const scoresFn = opts.scores || emotionScores;
  const confusedFn = opts.confusedScore || confusedScore;
  const enter = opts.enterScore ?? EMOTION_ENTER_SCORE;
  const exit = opts.exitScore ?? EMOTION_EXIT_SCORE;
  const sustain = opts.sustainFrames ?? SUSTAIN_FRAMES;
  const gestCooldown = opts.gestureCooldownMs ?? GESTURE_COOLDOWN_MS;

  let active = null;            // currently-active emotion, or null
  let candidate = null, streak = 0;   // building toward acquire/switch
  let activeGestures = new Set();
  const lastGestureAt = {};

  // Combined 0-100 scores across the seven effect emotions.
  function combined(bs) {
    const s = scoresFn(bs) || {};
    return {
      happy: s.happy || 0, sad: s.sad || 0, surprise: s.surprise || 0,
      angry: s.angry || 0, disgust: s.disgust || 0, fear: s.fear || 0,
      confused: confusedFn(bs),
    };
  }
  function top(scores) {
    let best = null, val = -1;
    for (const e of EFFECT_EMOTIONS) { if (scores[e] > val) { val = scores[e]; best = e; } }
    return { emotion: best, value: val };
  }

  return {
    feed({ bs, gestures, t } = {}) {
      if (bs) {
        const scores = combined(bs);
        // Phase A: fade the active emotion out first (hysteresis: exit < enter).
        if (active && scores[active] < exit) { active = null; candidate = null; streak = 0; }
        // Phase B: acquire (from null) or switch (to a clearly stronger different emotion).
        const tp = top(scores);
        const strong = tp.value >= enter;
        if (active) {
          if (strong && tp.emotion !== active) {
            if (candidate === tp.emotion) streak++; else { candidate = tp.emotion; streak = 1; }
            if (streak >= sustain) { active = tp.emotion; candidate = null; streak = 0; }
          } else { candidate = null; streak = 0; }
        } else {
          if (strong) {
            if (candidate === tp.emotion) streak++; else { candidate = tp.emotion; streak = 1; }
            if (streak >= sustain) { active = tp.emotion; candidate = null; streak = 0; }
          } else { candidate = null; streak = 0; }
        }
      }

      const gestureOnsets = [];
      if (gestures !== undefined) {
        const current = new Set((gestures || []).filter((g) => g && g !== 'None'));
        for (const g of current) {
          if (!activeGestures.has(g)) {
            const last = lastGestureAt[g];
            if (last == null || t - last >= gestCooldown) { lastGestureAt[g] = t; gestureOnsets.push(g); }
          }
        }
        activeGestures = current;
      }

      return { activeEmotion: active, gestureOnsets };
    },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test frontend/reaction-trigger.test.js`
Expected: PASS — `# pass 8`, `# fail 0`, output pristine.

- [ ] **Step 5: Commit**

```bash
git add frontend/reaction-trigger.js frontend/reaction-trigger.test.js
git commit -m "feat(facial): state-machine trigger (active emotion + gesture onsets)"
```

---

### Task 2: Pure particle engine

**Files:**
- Create: `frontend/fx/particles.js`
- Test: `frontend/fx/particles.test.js`

**Interfaces:**
- Produces:
  - `createParticle({ x, y, vx?, vy?, ax?, ay?, life, size?, color?, rot?, vr?, data? }) -> particle`
  - `stepParticle(p, dt) -> boolean` (advances by `dt` ms; returns `true` while alive)
  - `lifeProgress(p) -> number` (0..1 through its life)

- [ ] **Step 1: Write the failing test**

Create `frontend/fx/particles.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createParticle, stepParticle, lifeProgress } from './particles.js';

test('integrates position from velocity over dt', () => {
  const p = createParticle({ x: 0, y: 0, vx: 100, vy: 0, life: 1000 }); // 100 px/s
  stepParticle(p, 100); // 0.1s
  assert.ok(Math.abs(p.x - 10) < 1e-9);
});

test('gravity (ay) increases downward velocity', () => {
  const p = createParticle({ x: 0, y: 0, vy: 0, ay: 200, life: 1000 });
  stepParticle(p, 500); // 0.5s
  assert.ok(p.vy > 0 && Math.abs(p.vy - 100) < 1e-9);
});

test('expires at end of life', () => {
  const p = createParticle({ x: 0, y: 0, life: 100 });
  assert.equal(stepParticle(p, 50), true);
  assert.equal(stepParticle(p, 60), false); // age 110 >= 100
});

test('lifeProgress goes 0 -> 1 and clamps', () => {
  const p = createParticle({ x: 0, y: 0, life: 100 });
  assert.equal(lifeProgress(p), 0);
  stepParticle(p, 50);
  assert.ok(Math.abs(lifeProgress(p) - 0.5) < 1e-9);
  stepParticle(p, 999);
  assert.equal(lifeProgress(p), 1);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test frontend/fx/particles.test.js`
Expected: FAIL — `Cannot find module './particles.js'`.

- [ ] **Step 3: Write the implementation**

Create `frontend/fx/particles.js`:

```js
// frontend/fx/particles.js
// Pure particle model for the reaction-effects engine. No canvas — unit-tested.
// Units: positions in px, velocities px/s, accelerations px/s^2, life in ms.
export function createParticle({ x, y, vx = 0, vy = 0, ax = 0, ay = 0, life,
                                 size = 4, color = '#ffffff', rot = 0, vr = 0, data = null }) {
  return { x, y, vx, vy, ax, ay, age: 0, life, size, color, rot, vr, data };
}

export function stepParticle(p, dt) {
  const s = dt / 1000;
  p.vx += p.ax * s; p.vy += p.ay * s;
  p.x += p.vx * s; p.y += p.vy * s;
  p.rot += p.vr * s;
  p.age += dt;
  return p.age < p.life;
}

export function lifeProgress(p) {
  return Math.max(0, Math.min(1, p.age / p.life));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test frontend/fx/particles.test.js`
Expected: PASS — `# pass 4`, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add frontend/fx/particles.js frontend/fx/particles.test.js
git commit -m "feat(facial): pure particle engine core"
```

---

### Task 3: Landmark → canvas anchor mapping

**Files:**
- Create: `frontend/fx/anchors.js`
- Test: `frontend/fx/anchors.test.js`

**Interfaces:**
- Produces:
  - `mapPoint(norm, w, h) -> { x, y }` — normalized `{x,y}` → canvas px, MIRRORED in X (`x → 1-x`).
  - `extractAnchors(landmarks, w, h) -> anchors | null` where `anchors = { leftEye, rightEye, foreheadTop, leftTemple, rightTemple, mouth, faceBox:{x,y,w,h}, scale }` (all px; `scale` ≈ face height / half canvas, clamped 0.4..2.5). Returns `null` if `landmarks` is missing or has < 468 points.
  - `FACE_IDX` — the landmark-index map (exported so the calibration step can tune it).

- [ ] **Step 1: Write the failing test**

Create `frontend/fx/anchors.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapPoint, extractAnchors, FACE_IDX } from './anchors.js';

test('mapPoint scales and mirrors X', () => {
  assert.deepEqual(mapPoint({ x: 0.25, y: 0.5 }, 1000, 400), { x: 750, y: 200 }); // (1-0.25)*1000
  assert.deepEqual(mapPoint({ x: 0, y: 0 }, 1000, 400), { x: 1000, y: 0 });
});

test('extractAnchors returns null for too few landmarks', () => {
  assert.equal(extractAnchors(null, 100, 100), null);
  assert.equal(extractAnchors([{ x: 0.5, y: 0.5 }], 100, 100), null);
});

test('extractAnchors maps named indices and computes a positive scale', () => {
  // Build 468 landmarks all at center, then set a few named ones + spread for the box.
  const lm = Array.from({ length: 468 }, () => ({ x: 0.5, y: 0.5 }));
  lm[FACE_IDX.foreheadTop] = { x: 0.5, y: 0.2 };
  lm[0] = { x: 0.4, y: 0.3 };   // contributes to face box bounds
  lm[1] = { x: 0.6, y: 0.7 };
  const a = extractAnchors(lm, 1000, 400);
  assert.ok(a && a.foreheadTop);
  assert.equal(a.foreheadTop.y, 80);          // 0.2 * 400
  assert.equal(a.foreheadTop.x, 500);         // (1-0.5)*1000
  assert.ok(a.scale > 0 && a.scale <= 2.5);
  assert.ok(a.faceBox.w > 0 && a.faceBox.h > 0);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test frontend/fx/anchors.test.js`
Expected: FAIL — `Cannot find module './anchors.js'`.

- [ ] **Step 3: Write the implementation**

Create `frontend/fx/anchors.js`:

```js
// frontend/fx/anchors.js
// Map MediaPipe face landmarks (normalized [0,1]) into canvas pixel anchor points for
// the reaction effects. X is mirrored to match the selfie-mirrored video canvas
// (.fa-stage canvas { transform: scaleX(-1) }). Pure — unit-tested.
//
// Indices are MediaPipe Face Mesh (468/478). STARTING VALUES — verify/tune in-browser
// (see the plan's calibration step); they are exported so tuning is a one-line change.
export const FACE_IDX = {
  underEyeL: 145, underEyeR: 374, foreheadTop: 10,
  templeL: 234, templeR: 454, mouth: 13,
};

export function mapPoint(norm, w, h) {
  return { x: (1 - norm.x) * w, y: norm.y * h };
}

export function extractAnchors(landmarks, w, h) {
  if (!landmarks || landmarks.length < 468) return null;
  const P = (i) => mapPoint(landmarks[i], w, h);
  let minX = 1, minY = 1, maxX = 0, maxY = 0;
  for (const p of landmarks) {
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
  }
  const faceH = (maxY - minY) * h;
  return {
    leftEye: P(FACE_IDX.underEyeL), rightEye: P(FACE_IDX.underEyeR),
    foreheadTop: P(FACE_IDX.foreheadTop),
    leftTemple: P(FACE_IDX.templeL), rightTemple: P(FACE_IDX.templeR),
    mouth: P(FACE_IDX.mouth),
    // Mirror flips the X extents, so the display-left edge is (1-maxX).
    faceBox: { x: (1 - maxX) * w, y: minY * h, w: (maxX - minX) * w, h: faceH },
    scale: Math.max(0.4, Math.min(2.5, faceH / (h * 0.5))),
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test frontend/fx/anchors.test.js`
Expected: PASS — `# pass 3`, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add frontend/fx/anchors.js frontend/fx/anchors.test.js
git commit -m "feat(facial): landmark->canvas anchor mapping (mirrored)"
```

---

### Task 4: Emitter framework + the three named emitters (tears, fire, confused)

**Files:**
- Create: `frontend/fx/emitters.js`
- Test: `frontend/fx/emitters.test.js`

**Interfaces:**
- Produces (each emitter): `create<X>Emitter() -> { update(anchors, dt), draw(ctx), clear(), count() }`
  - `update(anchors, dt)`: spawn (only if `anchors` present) + step + drop dead particles.
  - `draw(ctx)`: custom Canvas-2D art.
  - `count()`: live particle count (for tests).
  - `anchors` shape from Task 3's `extractAnchors`.
- Consumes: `createParticle`, `stepParticle`, `lifeProgress` from `./particles.js`.

- [ ] **Step 1: Write the failing test**

Create `frontend/fx/emitters.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTearsEmitter, createFireEmitter, createConfusedEmitter } from './emitters.js';

// Minimal Canvas-2D stand-in: records nothing, never throws.
function mockCtx() {
  const grad = { addColorStop() {} };
  return new Proxy({}, {
    get: (_t, k) => {
      if (k === 'createLinearGradient' || k === 'createRadialGradient') return () => grad;
      if (k === 'measureText') return () => ({ width: 10 }); // callout draw reads .width
      return () => {};
    },
    set: () => true,
  });
}
const anchors = {
  leftEye: { x: 100, y: 100 }, rightEye: { x: 200, y: 100 },
  foreheadTop: { x: 150, y: 40 }, leftTemple: { x: 80, y: 90 }, rightTemple: { x: 220, y: 90 },
  mouth: { x: 150, y: 160 }, faceBox: { x: 80, y: 40, w: 140, h: 160 }, scale: 1,
};

for (const [name, make] of [['tears', createTearsEmitter], ['fire', createFireEmitter], ['confused', createConfusedEmitter]]) {
  test(`${name}: spawns with an anchor, draws without throwing, drains when anchor is gone`, () => {
    const e = make();
    for (let i = 0; i < 30; i++) e.update(anchors, 16);
    assert.ok(e.count() > 0, `${name} should have live particles`);
    e.draw(mockCtx()); // must not throw
    for (let i = 0; i < 400; i++) e.update(null, 16); // no anchor -> no new spawns, existing expire
    assert.equal(e.count(), 0, `${name} should drain to 0`);
  });
}

test('clear() empties an emitter', () => {
  const e = createFireEmitter();
  for (let i = 0; i < 20; i++) e.update(anchors, 16);
  e.clear();
  assert.equal(e.count(), 0);
});
```

Note: `createConfusedEmitter`'s "?" glyphs are persistent while the anchor is present; when the anchor is gone it must remove them so `count()` reaches 0 — implement its `update(null, ...)` to drop its glyphs.

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test frontend/fx/emitters.test.js`
Expected: FAIL — `Cannot find module './emitters.js'`.

- [ ] **Step 3: Write the implementation**

Create `frontend/fx/emitters.js`:

```js
// frontend/fx/emitters.js
// One emitter per emotion (custom Canvas-2D art) + the gesture callout layer.
// Each emitter: { update(anchors, dt), draw(ctx), clear(), count() }.
// Visual constants are intentionally simple starting points — tune in-browser.
import { createParticle, stepParticle, lifeProgress } from './particles.js';

const REDUCED = typeof matchMedia === 'function'
  && matchMedia('(prefers-reduced-motion: reduce)').matches;
const MAX_PER_EMITTER = 120;

// Spawn/step/cull helper shared by particle emitters.
function baseEmitter(spawn, render) {
  const parts = [];
  let acc = 0; // fractional spawn accumulator
  return {
    _parts: parts,
    update(anchors, dt) {
      if (anchors) acc = spawn(parts, anchors, dt, acc);
      for (let i = parts.length - 1; i >= 0; i--) if (!stepParticle(parts[i], dt)) parts.splice(i, 1);
      if (parts.length > MAX_PER_EMITTER) parts.splice(0, parts.length - MAX_PER_EMITTER);
    },
    draw(ctx) { render(ctx, parts); },
    clear() { parts.length = 0; acc = 0; },
    count() { return parts.length; },
  };
}
function rate(dt, perSec, acc) { return acc + (dt / 1000) * (REDUCED ? perSec * 0.4 : perSec); }

// ── Sad: blue teardrops welling under the eyes and falling ──
export function createTearsEmitter() {
  return baseEmitter(
    (parts, a, dt, acc) => {
      acc = rate(dt, 8, acc);
      while (acc >= 1) {
        acc -= 1;
        const eye = Math.random() < 0.5 ? a.leftEye : a.rightEye;
        parts.push(createParticle({
          x: eye.x + (Math.random() * 6 - 3), y: eye.y + 6 * a.scale,
          vy: 18 * a.scale, ay: 130 * a.scale, life: 1300, size: 3.2 * a.scale, color: '#7fc7ff',
        }));
      }
      return acc;
    },
    (ctx, parts) => {
      for (const p of parts) {
        const k = lifeProgress(p);
        ctx.globalAlpha = (1 - k) * 0.85;
        ctx.fillStyle = p.color;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2); ctx.fill();
      }
      ctx.globalAlpha = 1;
    });
}

// ── Angry: flames rising above the forehead (color by life), additive ──
export function createFireEmitter() {
  return baseEmitter(
    (parts, a, dt, acc) => {
      acc = rate(dt, 26, acc);
      while (acc >= 1) {
        acc -= 1;
        parts.push(createParticle({
          x: a.foreheadTop.x + (Math.random() * 40 - 20) * a.scale,
          y: a.foreheadTop.y - 6 * a.scale,
          vx: (Math.random() * 24 - 12) * a.scale, vy: -(70 + Math.random() * 50) * a.scale,
          ay: -30 * a.scale, life: 620 + Math.random() * 260, size: (10 + Math.random() * 8) * a.scale,
        }));
      }
      return acc;
    },
    (ctx, parts) => {
      ctx.globalCompositeOperation = 'lighter';
      for (const p of parts) {
        const k = lifeProgress(p);
        // yellow -> orange -> red -> fade
        const r = 255, g = Math.round(200 * (1 - k)), b = Math.round(40 * (1 - k));
        ctx.globalAlpha = (1 - k) * 0.5;
        ctx.fillStyle = `rgb(${r},${g},${b})`;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.size * (1 - k * 0.5), 0, Math.PI * 2); ctx.fill();
      }
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    });
}

// ── Confused: three "?" glyphs bobbing/orbiting above the head ──
export function createConfusedEmitter() {
  const glyphs = []; // persistent while the face is present
  let phase = 0;
  return {
    update(anchors, dt) {
      if (!anchors) { glyphs.length = 0; return; } // drop when the face is gone
      if (glyphs.length === 0)
        for (let i = 0; i < 3; i++) glyphs.push({ base: (i - 1), size: 20 * anchors.scale });
      phase += (REDUCED ? 0 : dt / 1000);
      for (const g of glyphs) {
        g.x = anchors.foreheadTop.x + g.base * 28 * anchors.scale + Math.sin(phase * 2 + g.base) * 6;
        g.y = anchors.foreheadTop.y - 24 * anchors.scale + Math.cos(phase * 2 + g.base) * 6;
        g.size = 20 * anchors.scale;
      }
    },
    draw(ctx) {
      ctx.fillStyle = '#ffd54a';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      for (const g of glyphs) {
        ctx.font = `bold ${Math.round(g.size)}px sans-serif`;
        ctx.fillText('?', g.x, g.y);
      }
    },
    clear() { glyphs.length = 0; phase = 0; },
    count() { return glyphs.length; },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test frontend/fx/emitters.test.js`
Expected: PASS — `# pass 4`, `# fail 0` (3 emitter cases + `clear()`).

- [ ] **Step 5: Commit**

```bash
git add frontend/fx/emitters.js frontend/fx/emitters.test.js
git commit -m "feat(facial): emitter framework + tears/fire/confused"
```

---

### Task 5: The four remaining emotion emitters (happy, surprise, disgust, fear)

**Files:**
- Modify: `frontend/fx/emitters.js` (append four factories)
- Modify: `frontend/fx/emitters.test.js` (extend the parametrized loop)

**Interfaces:**
- Produces: `createSparkleEmitter`, `createSurpriseEmitter`, `createDisgustEmitter`, `createFearEmitter` — same `{ update, draw, clear, count }` shape as Task 4.

- [ ] **Step 1: Extend the failing test**

In `frontend/fx/emitters.test.js`, update the import line and the parametrized array to include the four new emitters:

```js
import { createTearsEmitter, createFireEmitter, createConfusedEmitter,
         createSparkleEmitter, createSurpriseEmitter, createDisgustEmitter, createFearEmitter } from './emitters.js';
```

and change the `for (const [name, make] of [...])` array to:

```js
for (const [name, make] of [
  ['tears', createTearsEmitter], ['fire', createFireEmitter], ['confused', createConfusedEmitter],
  ['sparkle', createSparkleEmitter], ['surprise', createSurpriseEmitter],
  ['disgust', createDisgustEmitter], ['fear', createFearEmitter],
]) {
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test frontend/fx/emitters.test.js`
Expected: FAIL — the four new imports are `undefined`, so `make()` throws.

- [ ] **Step 3: Append the implementations**

Append to `frontend/fx/emitters.js`:

```js
// ── Happy: twinkling sparkles scattered around the face box ──
export function createSparkleEmitter() {
  return baseEmitter(
    (parts, a, dt, acc) => {
      acc = rate(dt, 14, acc);
      while (acc >= 1) {
        acc -= 1;
        const b = a.faceBox;
        parts.push(createParticle({
          x: b.x + Math.random() * b.w, y: b.y + Math.random() * b.h,
          life: 700 + Math.random() * 400, size: (4 + Math.random() * 4) * a.scale,
          color: '#fff3b0', vr: Math.random() * 4 - 2, rot: Math.random() * Math.PI,
        }));
      }
      return acc;
    },
    (ctx, parts) => {
      for (const p of parts) {
        const k = lifeProgress(p);
        const s = p.size * Math.sin(k * Math.PI); // scale in then out (twinkle)
        ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot);
        ctx.globalAlpha = Math.sin(k * Math.PI); ctx.fillStyle = p.color;
        ctx.beginPath();
        for (let i = 0; i < 8; i++) { const r = i % 2 ? s * 0.4 : s; const ang = (i / 8) * Math.PI * 2;
          const fn = i ? 'lineTo' : 'moveTo'; ctx[fn](Math.cos(ang) * r, Math.sin(ang) * r); }
        ctx.closePath(); ctx.fill(); ctx.restore();
      }
      ctx.globalAlpha = 1;
    });
}

// ── Surprise: a bobbing "!" plus expanding rings above the head ──
export function createSurpriseEmitter() {
  return baseEmitter(
    (parts, a, dt, acc) => {
      acc = rate(dt, 3, acc); // slow ring cadence
      while (acc >= 1) {
        acc -= 1;
        parts.push(createParticle({ x: a.foreheadTop.x, y: a.foreheadTop.y - 26 * a.scale,
          life: 700, size: 6 * a.scale, color: '#ffd54a', data: 'ring' }));
      }
      return acc;
    },
    (ctx, parts) => {
      for (const p of parts) {
        const k = lifeProgress(p);
        ctx.globalAlpha = (1 - k) * 0.8; ctx.strokeStyle = p.color; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.size + k * 26, 0, Math.PI * 2); ctx.stroke();
      }
      ctx.globalAlpha = 1;
      // The "!" itself: anchored, drawn once, only when there are anchors (rings imply anchors).
      if (parts.length) {
        const p = parts[parts.length - 1];
        ctx.fillStyle = '#ffd54a'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.font = `bold ${Math.round(p.size * 4)}px sans-serif`; ctx.fillText('!', p.x, p.y);
      }
    });
}

// ── Disgust: greenish wavy particles drifting sideways near the mouth ──
export function createDisgustEmitter() {
  return baseEmitter(
    (parts, a, dt, acc) => {
      acc = rate(dt, 10, acc);
      while (acc >= 1) {
        acc -= 1;
        const dir = Math.random() < 0.5 ? -1 : 1;
        parts.push(createParticle({ x: a.mouth.x, y: a.mouth.y + 6 * a.scale,
          vx: dir * 26 * a.scale, vy: -6 * a.scale, life: 900, size: (5 + Math.random() * 4) * a.scale,
          color: '#8bd44f', rot: Math.random() * Math.PI }));
      }
      return acc;
    },
    (ctx, parts) => {
      for (const p of parts) {
        const k = lifeProgress(p);
        ctx.globalAlpha = (1 - k) * 0.6; ctx.fillStyle = p.color;
        ctx.beginPath(); ctx.ellipse(p.x, p.y, p.size, p.size * 0.6, p.rot, 0, Math.PI * 2); ctx.fill();
      }
      ctx.globalAlpha = 1;
    });
}

// ── Fear: cold-sweat droplets sliding down from the temples ──
export function createFearEmitter() {
  return baseEmitter(
    (parts, a, dt, acc) => {
      acc = rate(dt, 5, acc);
      while (acc >= 1) {
        acc -= 1;
        const t = Math.random() < 0.5 ? a.leftTemple : a.rightTemple;
        parts.push(createParticle({ x: t.x, y: t.y, vy: 30 * a.scale, ay: 90 * a.scale,
          vx: (Math.random() * 6 - 3), life: 1100, size: 3 * a.scale, color: '#bfe6ff' }));
      }
      return acc;
    },
    (ctx, parts) => {
      for (const p of parts) {
        const k = lifeProgress(p);
        ctx.globalAlpha = (1 - k) * 0.8; ctx.fillStyle = p.color;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2); ctx.fill();
      }
      ctx.globalAlpha = 1;
    });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test frontend/fx/emitters.test.js`
Expected: PASS — `# pass 8`, `# fail 0` (7 emitter cases + `clear()`).

- [ ] **Step 5: Commit**

```bash
git add frontend/fx/emitters.js frontend/fx/emitters.test.js
git commit -m "feat(facial): happy/surprise/disgust/fear emitters"
```

---

### Task 6: Gesture callout layer + registry exports

**Files:**
- Modify: `frontend/fx/emitters.js` (append callout layer + the `EMOTION_EMITTERS` and `GESTURE_CALLOUTS` exports)
- Modify: `frontend/fx/emitters.test.js` (add callout tests)

**Interfaces:**
- Produces:
  - `createCalloutLayer() -> { spawn(text, color, anchor, w, h), update(dt), draw(ctx), clear(), count() }` — `anchor` is `{x,y}` or `null` (falls back to top-center). Each badge animates scale-in → hold → fade over ~1000ms.
  - `EMOTION_EMITTERS: { [emotion]: factory }` covering all 7 emotions.
  - `GESTURE_CALLOUTS: { [categoryName]: { text, color } }` per the Global Constraints table.

- [ ] **Step 1: Add the failing tests**

First, extend the existing top import line in `frontend/fx/emitters.test.js` to also import
`createCalloutLayer, EMOTION_EMITTERS, GESTURE_CALLOUTS` from `'./emitters.js'` (add them to the
same `import { ... } from './emitters.js'` statement — do NOT add a second import lower in the file).

Then append these tests to `frontend/fx/emitters.test.js`:

```js
test('EMOTION_EMITTERS covers all seven emotions with factories', () => {
  const keys = ['happy', 'sad', 'surprise', 'angry', 'disgust', 'fear', 'confused'];
  for (const k of keys) assert.equal(typeof EMOTION_EMITTERS[k], 'function');
  assert.equal(Object.keys(EMOTION_EMITTERS).length, keys.length);
});

test('GESTURE_CALLOUTS maps Thumb_Up to OK! green', () => {
  assert.deepEqual(GESTURE_CALLOUTS.Thumb_Up, { text: 'OK!', color: '#3ddc84' });
  assert.equal(Object.keys(GESTURE_CALLOUTS).length, 7);
});

test('callout spawns, draws, and expires', () => {
  const c = createCalloutLayer();
  c.spawn('OK!', '#3ddc84', { x: 50, y: 50 }, 200, 200);
  assert.equal(c.count(), 1);
  c.draw(mockCtx()); // must not throw
  for (let i = 0; i < 120; i++) c.update(16); // ~1.9s > 1s life
  assert.equal(c.count(), 0);
});

test('callout falls back to top-center when anchor is null', () => {
  const c = createCalloutLayer();
  c.spawn('Hi!', '#7fc7ff', null, 200, 400);
  c.draw(mockCtx()); // must not throw with a null anchor
  assert.equal(c.count(), 1);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test frontend/fx/emitters.test.js`
Expected: FAIL — `createCalloutLayer`, `EMOTION_EMITTERS`, `GESTURE_CALLOUTS` are `undefined`.

- [ ] **Step 3: Append the implementation**

Append to `frontend/fx/emitters.js`:

```js
// ── Gesture callouts: transient labeled badges (scale-in -> hold -> fade) ──
const CALLOUT_LIFE = 1000;
export function createCalloutLayer() {
  const items = [];
  return {
    spawn(text, color, anchor, w, h) {
      const x = anchor ? anchor.x : w / 2;
      const y = anchor ? anchor.y - 30 : h * 0.18;
      items.push({ text, color, x, y, age: 0 });
    },
    update(dt) {
      for (let i = items.length - 1; i >= 0; i--) { items[i].age += dt; if (items[i].age >= CALLOUT_LIFE) items.splice(i, 1); }
    },
    draw(ctx) {
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      for (const it of items) {
        const k = it.age / CALLOUT_LIFE;
        const scale = k < 0.2 ? k / 0.2 : 1;          // scale-in over first 20%
        const alpha = k > 0.7 ? (1 - k) / 0.3 : 1;    // fade-out over last 30%
        ctx.save(); ctx.translate(it.x, it.y); ctx.scale(scale, scale); ctx.globalAlpha = alpha;
        ctx.font = 'bold 26px sans-serif';
        const wpx = ctx.measureText(it.text).width + 24;
        ctx.fillStyle = 'rgba(20,18,16,0.72)';
        ctx.beginPath(); ctx.roundRect(-wpx / 2, -20, wpx, 40, 12); ctx.fill();
        ctx.fillStyle = it.color; ctx.fillText(it.text, 0, 1);
        ctx.restore();
      }
      ctx.globalAlpha = 1;
    },
    clear() { items.length = 0; },
    count() { return items.length; },
  };
}

export const EMOTION_EMITTERS = {
  happy: createSparkleEmitter, sad: createTearsEmitter, surprise: createSurpriseEmitter,
  angry: createFireEmitter, disgust: createDisgustEmitter, fear: createFearEmitter,
  confused: createConfusedEmitter,
};

export const GESTURE_CALLOUTS = {
  Thumb_Up: { text: 'OK!', color: '#3ddc84' },
  Thumb_Down: { text: 'Nope', color: '#ff5c5c' },
  Victory: { text: 'Nice!', color: '#ffd54a' },
  Open_Palm: { text: 'Hi!', color: '#7fc7ff' },
  Closed_Fist: { text: 'Strong!', color: '#ff9f43' },
  Pointing_Up: { text: 'Idea! 💡', color: '#ffe08a' },
  ILoveYou: { text: 'Love! 💜', color: '#c98bff' },
};
```

Note: `CanvasRenderingContext2D.roundRect` is supported in current browsers; the `mockCtx()` no-op covers it in tests.

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test frontend/fx/emitters.test.js`
Expected: PASS — `# pass 12`, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add frontend/fx/emitters.js frontend/fx/emitters.test.js
git commit -m "feat(facial): gesture callout layer + emitter/callout registries"
```

---

### Task 7: Surface face + hand landmarks from vision.js

**Files:**
- Modify: `frontend/vision.js`

**Interfaces:**
- Produces: `onFrame(out)` gains `out.faceLandmarks` (the raw face landmark array when the face detector ran this frame, else `undefined`) and `out.handLandmarks` (the detected hands' landmark arrays when the gesture recognizer ran, else `undefined`). `out.blendshapes` / `out.gestures` unchanged.
- Consumes: nothing new.

Context: Task 3 of the v1 plan already made the loop capability-based. `tasks.face.detectForVideo` returns `faceLandmarks`; `tasks.hands.recognizeForVideo` returns `landmarks`. The loop already computes `faces`/`hands` locally — just surface them.

- [ ] **Step 1: Add the two fields to the frame payload**

In `frontend/vision.js`, in the loop, find the line that initializes `out` (it currently reads):

```js
    const out = { mode: session.mode, detections: 0, fps: session.fps, blendshapes: null, gestures: undefined };
```

Replace it with:

```js
    const out = { mode: session.mode, detections: 0, fps: session.fps, blendshapes: null, gestures: undefined, faceLandmarks: undefined, handLandmarks: undefined };
```

- [ ] **Step 2: Populate faceLandmarks in the face branch**

In the `if (faceDue){ ... }` block, immediately after `session._face = faces[0] || null;`, add:

```js
        out.faceLandmarks = faces[0] || undefined;
```

- [ ] **Step 3: Populate handLandmarks in the gesture branch**

In the `if (gestDue){ ... }` block, immediately after `const hands = r.landmarks || [];`, add:

```js
        out.handLandmarks = hands.length ? hands : undefined;
```

- [ ] **Step 4: Verify syntax + OFF-path parity (static)**

Run: `node --check frontend/vision.js` → expect exit 0.
Confirm by reading: the two new fields are set only inside the existing `faceDue`/`gestDue` branches, so with effects OFF they populate exactly when the mode's own detector already ran (face mode → `faceLandmarks`; hands mode → `handLandmarks`) and are inert (no consumer reads them when effects are off). No detection calls, drawing, or `out.detections` changed. Live-camera check happens in Task 10.

- [ ] **Step 5: Commit**

```bash
git add frontend/vision.js
git commit -m "feat(facial): surface face+hand landmarks in vision onFrame"
```

---

### Task 8: Canvas engine — rewrite face-effects.js

**Files:**
- Modify (rewrite): `frontend/face-effects.js`

**Interfaces:**
- Produces: `createFaceEffects(canvas) -> { setEnabled(on), feed({ bs, gestures, faceLandmarks, handLandmarks, t }), clear(), destroy() }`.
  - `setEnabled(true)` sizes the canvas, starts the rAF loop; `false` stops it and clears.
  - `feed(sample)` (no-op while disabled) updates the trigger, swaps the active emitter on change, and spawns gesture callouts near the hand.
  - `clear()` empties all emitters/callouts; `destroy()` stops the loop, clears, removes listeners.
- Consumes: `createReactionTrigger` (`./reaction-trigger.js`); `EMOTION_EMITTERS`, `GESTURE_CALLOUTS`, `createCalloutLayer` (`./fx/emitters.js`); `extractAnchors`, `mapPoint` (`./fx/anchors.js`).

- [ ] **Step 1: Rewrite the module**

Replace the entire contents of `frontend/face-effects.js`:

```js
// frontend/face-effects.js
// Canvas overlay + render loop for the Face Analysis reaction effects. Composes the
// pure trigger (which emotion is active + gesture onsets) with per-effect emitters that
// draw custom art anchored to face/hand landmarks. No network, no scoring — cosmetic.
import { createReactionTrigger } from './reaction-trigger.js';
import { EMOTION_EMITTERS, GESTURE_CALLOUTS, createCalloutLayer } from './fx/emitters.js';
import { extractAnchors, mapPoint } from './fx/anchors.js';

export function createFaceEffects(canvas) {
  const ctx = canvas.getContext('2d');
  const trigger = createReactionTrigger();
  const emitters = {};
  for (const name in EMOTION_EMITTERS) emitters[name] = EMOTION_EMITTERS[name]();
  const callouts = createCalloutLayer();

  let enabled = false, rafId = 0, lastT = 0;
  let activeEmotion = null;
  let latest = null; // last fed { faceLandmarks, handLandmarks }

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(canvas.clientWidth * dpr));
    canvas.height = Math.max(1, Math.round(canvas.clientHeight * dpr));
  }

  function clearAll() {
    activeEmotion = null;
    for (const k in emitters) emitters[k].clear();
    callouts.clear();
    if (canvas.width && canvas.height) ctx.clearRect(0, 0, canvas.width, canvas.height);
  }

  function handAnchor(handLandmarks) {
    if (!handLandmarks || !handLandmarks.length || !handLandmarks[0].length) return null;
    return mapPoint(handLandmarks[0][0], canvas.width, canvas.height); // wrist (landmark 0), mirrored
  }

  function loop(now) {
    if (!enabled) return;
    const dt = lastT ? Math.min(50, now - lastT) : 16;
    lastT = now;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const anchors = latest && latest.faceLandmarks
      ? extractAnchors(latest.faceLandmarks, canvas.width, canvas.height) : null;
    // Update/draw every emitter, but only the ACTIVE one receives anchors (spawns). Inactive
    // emitters get null, so they stop spawning and their particles drain and fade out
    // naturally — a smooth exit/switch without an abrupt clear. Idle emitters hold 0 particles.
    for (const name in emitters) {
      emitters[name].update(name === activeEmotion ? anchors : null, dt);
      emitters[name].draw(ctx);
    }
    callouts.update(dt);
    callouts.draw(ctx);
    rafId = requestAnimationFrame(loop);
  }

  return {
    setEnabled(on) {
      enabled = !!on;
      if (enabled) { resize(); lastT = 0; rafId = requestAnimationFrame(loop); window.addEventListener('resize', resize); }
      else { cancelAnimationFrame(rafId); window.removeEventListener('resize', resize); clearAll(); }
    },
    feed(sample) {
      if (!enabled) return;
      latest = sample;
      const { activeEmotion: ae, gestureOnsets } = trigger.feed({
        bs: sample.bs, gestures: sample.gestures, t: sample.t,
      });
      activeEmotion = ae; // on change, the previously-active emitter drains itself in the loop
      for (const g of gestureOnsets) {
        const c = GESTURE_CALLOUTS[g];
        if (c) callouts.spawn(c.text, c.color, handAnchor(sample.handLandmarks), canvas.width, canvas.height);
      }
    },
    clear() { clearAll(); },
    destroy() { enabled = false; cancelAnimationFrame(rafId); window.removeEventListener('resize', resize); clearAll(); },
  };
}
```

- [ ] **Step 2: Verify syntax**

Run: `node --check frontend/face-effects.js` → expect exit 0. (It imports browser-only modules and uses `window`, so it can't run under Node — `--check` validates syntax only. Behavior is verified in Task 10.)

- [ ] **Step 3: Commit**

```bash
git add frontend/face-effects.js
git commit -m "feat(facial): canvas reaction-effects engine (anchored emitters + callouts)"
```

---

### Task 9: Rewire facial.js to the canvas overlay + swap CSS

**Files:**
- Modify: `frontend/screens/facial.js`
- Modify: `frontend/styles/clean-studio.css`

**Interfaces:**
- Consumes: `createFaceEffects(canvasEl)` (Task 8); `out.faceLandmarks`/`out.handLandmarks` (Task 7).

Context: v1 wiring already imports `createFaceEffects`, has `effects`/`effectsOn` state, an `onFrame` feed, a `[data-fx]` toggle, and teardown. Only the mount element (canvas vs div), the feed payload (add landmarks), and the CSS change here.

- [ ] **Step 1: Swap the mount element to a canvas**

In `frontend/screens/facial.js`, in the returned HTML, replace:

```js
        '<div class="fa-fx" id="fa-fx"></div>' +
```
with:
```js
        '<canvas class="fa-fx" id="fa-fx"></canvas>' +
```

- [ ] **Step 2: Feed landmarks into the effects**

Replace the `onFrame` feed call (currently `effects.feed({ bs: out.blendshapes, gestures: out.gestures, t: performance.now() });`) with:

```js
    effects.feed({ bs: out.blendshapes, gestures: out.gestures,
                   faceLandmarks: out.faceLandmarks, handLandmarks: out.handLandmarks,
                   t: performance.now() });
```

- [ ] **Step 3: Replace the CSS overlay rules**

In `frontend/styles/clean-studio.css`, find the v1 block that begins with the comment `/* ── Face Analysis reaction effects overlay ...` and replace that whole block (the `.fa-fx`, `.fx-emoji`, `.fx-emoji.reduced`, `@keyframes fxFloat`, and the `@media (prefers-reduced-motion)` rule) with:

```css
/* ── Face Analysis reaction effects (canvas overlay) ───────────────────── */
.fa-fx{position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:3}
```

- [ ] **Step 4: Verify syntax**

Run: `node --check frontend/screens/facial.js` → expect exit 0.

- [ ] **Step 5: Commit**

```bash
git add frontend/screens/facial.js frontend/styles/clean-studio.css
git commit -m "feat(facial): mount canvas overlay + feed landmarks; swap effect CSS"
```

---

### Task 10: In-browser calibration, verification, and docs

**Files:**
- Modify: `frontend/fx/anchors.js` (only if the calibration pass shows an anchor index is wrong)
- Modify: `README.md`

- [ ] **Step 1: Re-run the full pure test suite**

Run:
```bash
node --test frontend/reaction-trigger.test.js frontend/fx/particles.test.js frontend/fx/anchors.test.js frontend/fx/emitters.test.js
```
Expected: all pass, output pristine.

- [ ] **Step 2: Launch and calibrate anchors on camera**

Start the app (`uvicorn backend.main:app --reload --port 8000`), open `http://localhost:8000/#/facial`, Start camera (Face mode), effects ON. Verify each effect sits where it should:

- [ ] Sad → 💧 tears appear **under the eyes** (not on the brow/cheeks). If misplaced, tune `FACE_IDX.underEyeL/underEyeR` in `frontend/fx/anchors.js`.
- [ ] Angry → 🔥 flames sit **above the head**. If off, tune `FACE_IDX.foreheadTop`.
- [ ] Confused (furrow your brow) → "?" glyphs **above the head**.
- [ ] Fear → sweat at the **temples**; Disgust → waver near the **mouth**; Happy → sparkles around the face; Surprise → "!" + rings above the head. Tune `templeL/templeR`/`mouth` if needed.
- [ ] Effects **track your face** as you move, and stay upright (not mirrored/reversed text). If the effect is on the wrong side (left/right swapped), the mirror in `mapPoint` is correct — recheck the index, not the mirror.

If you edit anchor indices, re-run `node --test frontend/fx/anchors.test.js` and commit with `git add frontend/fx/anchors.js` and message `fix(facial): tune anchor landmark indices`.

- [ ] **Step 3: Verify behavior + scope**

- [ ] Only ONE emotion effect shows at a time; it fades when you return to neutral.
- [ ] 👍 → "OK!" callout near your hand; 👎 → "Nope"; other gestures show their labels. Callouts appear alongside an active emotion effect.
- [ ] Blendshape bars + Expression Analysis panel still update exactly as before; the HSEmotion engine still works.
- [ ] Toggle Reaction effects Off → canvas clears immediately; On → resumes. Resize the window → effects stay aligned.
- [ ] Leave `/facial` and return → no leftover drawing, no console errors, camera releases.
- [ ] Network tab shows no new requests from the effects.

- [ ] **Step 4: Update the README**

In `README.md`, replace the existing "Reaction effects (Face Analysis screen)" bullet's body with a description of the face-anchored version, e.g.:

> - **Reaction effects (Face Analysis screen).** On the Face Analysis page, a toggle-on
>   canvas overlay draws effects pinned to your face: tears under the eyes when you look sad,
>   fire above your head when angry, question marks when confused, plus sparkles, surprise,
>   disgust and fear cues — and a labeled callout (e.g. "OK!" for 👍) for each hand gesture.
>   Effects follow your face in real time. On by default; toggle it off in the left rail.
>   Purely visual, computed in the browser — no network calls, and it changes no analysis or scoring.

(If the pre-existing unrelated README edit is still in your working tree, stage only your bullet change: `git add -p README.md` is unavailable non-interactively — instead the controller isolates it the same way it did for v1. For an interactive run, just `git add README.md`.)

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "docs: describe face-anchored reaction effects (v2)"
```

---

## Notes for the implementer

- Pure logic (`reaction-trigger.js`, `fx/particles.js`, `fx/anchors.js`) is TDD and fully unit-tested. Emitters have behavioral smoke tests (spawn/drain/draw-doesn't-throw) via a mock 2D context; their VISUAL look and the canvas engine are verified on camera in Task 10.
- Do not change the `try/catch` swallow-and-continue in `vision.js`'s per-frame loop — it is intentional (a single bad frame must not kill the loop).
- Keep the render loop (`requestAnimationFrame`, ~60fps) decoupled from `feed()` (driven by the ~30fps detection): the loop reads the latest anchors/active-emotion, so particles stay smooth between detections.
- Visual constants (spawn rates, sizes, colors, life) are starting points — expect to nudge them during Task 10. The anchor indices are the most likely thing to need tuning.
```
