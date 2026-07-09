# Face Analysis Reaction Effects Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a toggleable floating-emoji reaction layer to the Face Analysis page (`/facial`) that bursts matching emoji when the camera reads a strong facial emotion or a hand gesture, with both reacting at the same time.

**Architecture:** A pure, unit-tested trigger core (`reaction-trigger.js`) decides which emoji to burst from per-frame `{ bs, gestures }` samples using debounce + cooldown. A DOM overlay module (`face-effects.js`) renders floating-emoji bursts and composes the trigger. `vision.js` becomes capability-based so the face detector (emotion) and gesture recognizer run together while effects are on. `facial.js` mounts the overlay, adds the toggle, and feeds each frame in.

**Tech Stack:** Vanilla ES modules (browser), MediaPipe `tasks-vision` (already loaded), Node's built-in `node:test` runner for the pure logic. No new runtime dependencies.

## Global Constraints

- Feature lives on `/facial` only — do NOT touch `/live` or the interview engine.
- Purely cosmetic: no new network calls; no change to the blendshape bars, the Expression Analysis panel, or the HSEmotion/DeepFace track.
- Effects **OFF** must reproduce today's `vision.js` behavior exactly (one detector per frame).
- Emotion set (emoji): happy 😄, sad 😢, surprise 😮, angry 😠, disgust 🤢, fear 😨, contempt 😒. `neutral` → nothing.
- Gesture set (MediaPipe `categoryName` → emoji): `Thumb_Up` 👍, `Thumb_Down` 👎, `Victory` ✌️, `Open_Palm` ✋, `Closed_Fist` ✊, `Pointing_Up` ☝️, `ILoveYou` 🤟. `None` → nothing.
- Trigger constants: `EMOTION_MIN_SCORE = 50`, `SUSTAIN_FRAMES = 3`, `EMOTION_COOLDOWN_MS = 2500`, `GESTURE_COOLDOWN_MS = 1500`.
- Render constants: `PARTICLES = 6`, `MAX_ACTIVE = 24`, animation ~1400ms; honor `prefers-reduced-motion`.
- Effects-only detection throttle: `EFFECTS_INTERVAL_MS = 100` (~10 fps).
- Default: effects toggle **ON**.
- Active stylesheet is `frontend/styles/clean-studio.css` (linked from `frontend/index.html`). Do NOT edit the legacy `frontend/style.css`.
- Work on a feature branch (repo is currently on `main`).

---

### Task 0: Feature branch

- [ ] **Step 1: Create the branch**

```bash
git checkout -b feat/face-analysis-reaction-effects
```

---

### Task 1: Pure reaction-trigger core (TDD)

Decides which emoji to burst from per-frame samples. No DOM. This is the only unit-tested unit.

**Files:**
- Create: `frontend/package.json`
- Create: `frontend/reaction-trigger.js`
- Test: `frontend/reaction-trigger.test.js`

**Interfaces:**
- Consumes: `dominantEmotion(bs) -> { emotion, value, scores }` from `frontend/emotion.js` (existing, pure).
- Produces:
  - `EMOTION_EMOJI: Record<string,string>`, `GESTURE_EMOJI: Record<string,string>`
  - `createReactionTrigger(opts?) -> { feed({ bs?, gestures?, t }) -> string[], reset() }`
    - `opts.classify` (default `dominantEmotion`) — override for tests; called as `classify(bs) -> { emotion, value }`.
    - `opts.emotionMinScore`, `opts.sustainFrames`, `opts.emotionCooldownMs`, `opts.gestureCooldownMs` — override constants for tests.
    - `feed` returns the emoji to burst THIS call (possibly empty). `bs` undefined → skip emotion. `gestures` undefined → skip gesture handling (do not reset the active-gesture set). `gestures` `[]` → hands are down.

- [ ] **Step 1: Create `frontend/package.json`** (marks `frontend/*.js` as ESM so `node:test` can import them)

```json
{
  "name": "molave-frontend",
  "private": true,
  "type": "module"
}
```

- [ ] **Step 2: Write the failing test**

Create `frontend/reaction-trigger.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReactionTrigger } from './reaction-trigger.js';

// classify stub: the sample's bs already carries { emotion, value }.
const stub = { classify: (bs) => bs };
const happy = { emotion: 'happy', value: 80 };

test('emotion fires only after SUSTAIN_FRAMES above threshold', () => {
  const trig = createReactionTrigger(stub);
  assert.deepEqual(trig.feed({ bs: happy, t: 0 }), []);   // 1
  assert.deepEqual(trig.feed({ bs: happy, t: 10 }), []);  // 2
  assert.deepEqual(trig.feed({ bs: happy, t: 20 }), ['😄']); // 3 -> fire
});

test('neutral never fires', () => {
  const trig = createReactionTrigger(stub);
  const neutral = { emotion: 'neutral', value: 100 };
  for (let i = 0; i < 5; i++) assert.deepEqual(trig.feed({ bs: neutral, t: i * 10 }), []);
});

test('below-threshold emotion never fires', () => {
  const trig = createReactionTrigger(stub);
  const weak = { emotion: 'happy', value: 40 };
  for (let i = 0; i < 5; i++) assert.deepEqual(trig.feed({ bs: weak, t: i * 10 }), []);
});

test('emotion respects cooldown', () => {
  const trig = createReactionTrigger(stub);
  trig.feed({ bs: happy, t: 0 }); trig.feed({ bs: happy, t: 10 });
  assert.deepEqual(trig.feed({ bs: happy, t: 20 }), ['😄']);        // fires
  // must re-sustain AND clear cooldown; still within 2500ms -> no fire
  trig.feed({ bs: happy, t: 30 }); trig.feed({ bs: happy, t: 40 });
  assert.deepEqual(trig.feed({ bs: happy, t: 50 }), []);
  // after cooldown, a fresh sustained streak fires again
  trig.feed({ bs: happy, t: 2600 }); trig.feed({ bs: happy, t: 2610 });
  assert.deepEqual(trig.feed({ bs: happy, t: 2620 }), ['😄']);
});

test('gesture fires once on onset, not while held', () => {
  const trig = createReactionTrigger(stub);
  assert.deepEqual(trig.feed({ gestures: ['Thumb_Up'], t: 0 }), ['👍']);
  assert.deepEqual(trig.feed({ gestures: ['Thumb_Up'], t: 16 }), []);  // held
  assert.deepEqual(trig.feed({ gestures: [], t: 32 }), []);            // released
});

test('gesture re-onset blocked within cooldown, allowed after', () => {
  const trig = createReactionTrigger(stub);
  trig.feed({ gestures: ['Victory'], t: 0 });          // fires
  trig.feed({ gestures: [], t: 16 });                  // released
  assert.deepEqual(trig.feed({ gestures: ['Victory'], t: 500 }), []);    // within 1500ms
  trig.feed({ gestures: [], t: 516 });
  assert.deepEqual(trig.feed({ gestures: ['Victory'], t: 1600 }), ['✌️']); // after cooldown
});

test('undefined gestures does not reset the active set', () => {
  const trig = createReactionTrigger(stub);
  assert.deepEqual(trig.feed({ gestures: ['Open_Palm'], t: 0 }), ['✋']); // onset
  assert.deepEqual(trig.feed({ t: 10 }), []);                            // throttled frame, no gesture info
  assert.deepEqual(trig.feed({ gestures: ['Open_Palm'], t: 20 }), []);  // still held -> no re-fire
});

test('None gesture is ignored', () => {
  const trig = createReactionTrigger(stub);
  assert.deepEqual(trig.feed({ gestures: ['None'], t: 0 }), []);
});

test('emotion and gesture can fire together', () => {
  const trig = createReactionTrigger(stub);
  trig.feed({ bs: happy, t: 0 }); trig.feed({ bs: happy, t: 10 });
  const out = trig.feed({ bs: happy, gestures: ['Thumb_Up'], t: 20 });
  assert.deepEqual(out.sort(), ['👍', '😄'].sort());
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `node --test frontend/reaction-trigger.test.js`
Expected: FAIL — `Cannot find module './reaction-trigger.js'` (file not created yet).

- [ ] **Step 4: Write the implementation**

Create `frontend/reaction-trigger.js`:

```js
// frontend/reaction-trigger.js
// Pure decision core for the Face Analysis reaction effects. Given per-frame
// { bs, gestures, t } samples, decides which emoji to burst, with debounce +
// cooldown so a held expression/gesture fires once. No DOM — unit-tested.
import { dominantEmotion } from './emotion.js';

export const EMOTION_EMOJI = {
  happy: '😄', sad: '😢', surprise: '😮', angry: '😠',
  disgust: '🤢', fear: '😨', contempt: '😒',
};
export const GESTURE_EMOJI = {
  Thumb_Up: '👍', Thumb_Down: '👎', Victory: '✌️', Open_Palm: '✋',
  Closed_Fist: '✊', Pointing_Up: '☝️', ILoveYou: '🤟',
};

const EMOTION_MIN_SCORE = 50;
const SUSTAIN_FRAMES = 3;
const EMOTION_COOLDOWN_MS = 2500;
const GESTURE_COOLDOWN_MS = 1500;

export function createReactionTrigger(opts = {}) {
  const classify = opts.classify || dominantEmotion;
  const minScore = opts.emotionMinScore ?? EMOTION_MIN_SCORE;
  const sustain = opts.sustainFrames ?? SUSTAIN_FRAMES;
  const emoCooldown = opts.emotionCooldownMs ?? EMOTION_COOLDOWN_MS;
  const gestCooldown = opts.gestureCooldownMs ?? GESTURE_COOLDOWN_MS;

  let candidate = null;   // emotion currently building a streak
  let streak = 0;
  const lastEmotionAt = {};
  let activeGestures = new Set();
  const lastGestureAt = {};

  return {
    feed({ bs, gestures, t } = {}) {
      const out = [];

      // ── emotion (sustain + cooldown) ──
      if (bs) {
        const dom = classify(bs);
        const emo = dom && dom.emotion;
        if (emo && emo !== 'neutral' && dom.value >= minScore) {
          if (candidate === emo) streak += 1;
          else { candidate = emo; streak = 1; }
          if (streak >= sustain) {
            const last = lastEmotionAt[emo];
            if (last == null || t - last >= emoCooldown) {
              lastEmotionAt[emo] = t;
              if (EMOTION_EMOJI[emo]) out.push(EMOTION_EMOJI[emo]);
            }
            candidate = null; streak = 0;   // must re-sustain before firing again
          }
        } else {
          candidate = null; streak = 0;
        }
      }

      // ── gestures (fire on onset + cooldown) ──
      // undefined = no info this frame (throttled) → leave the active set untouched.
      if (gestures !== undefined) {
        const current = new Set((gestures || []).filter((g) => g && g !== 'None'));
        for (const g of current) {
          if (!activeGestures.has(g)) {
            const last = lastGestureAt[g];
            if (last == null || t - last >= gestCooldown) {
              lastGestureAt[g] = t;
              if (GESTURE_EMOJI[g]) out.push(GESTURE_EMOJI[g]);
            }
          }
        }
        activeGestures = current;
      }

      return out;
    },
    reset() { candidate = null; streak = 0; activeGestures = new Set(); },
  };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --test frontend/reaction-trigger.test.js`
Expected: PASS — `# pass 9`, `# fail 0`.

- [ ] **Step 6: Commit**

```bash
git add frontend/package.json frontend/reaction-trigger.js frontend/reaction-trigger.test.js
git commit -m "feat(facial): pure reaction-trigger core with debounce/cooldown"
```

---

### Task 2: Emoji overlay module + styles

Renders floating-emoji bursts and composes the trigger. DOM-only; verified visually (Task 5).

**Files:**
- Create: `frontend/face-effects.js`
- Modify: `frontend/styles/clean-studio.css` (append effect styles)

**Interfaces:**
- Consumes: `createReactionTrigger` from `frontend/reaction-trigger.js`.
- Produces:
  - `createFaceEffects(container: HTMLElement) -> { setEnabled(on), feed({ bs, gestures, t }), clear(), destroy() }`
    - `feed` forwards the sample to the trigger and bursts each returned emoji; no-op while disabled.
    - CSS classes used: `.fx-emoji` (with optional `.reduced`); container is expected to be `.fa-fx`.

- [ ] **Step 1: Create the overlay module**

Create `frontend/face-effects.js`:

```js
// frontend/face-effects.js
// Floating-emoji reaction overlay for the Face Analysis page. Composes the pure
// reaction-trigger and renders each returned emoji as a short burst of DOM spans
// animated by CSS. No network, no scoring — purely cosmetic.
import { createReactionTrigger } from './reaction-trigger.js';

const PARTICLES = 6;
const MAX_ACTIVE = 24;

export function createFaceEffects(container) {
  const trigger = createReactionTrigger();
  let enabled = false;
  let active = 0;
  const reduceMotion = typeof matchMedia === 'function'
    && matchMedia('(prefers-reduced-motion: reduce)').matches;

  function clear() {
    container.innerHTML = '';
    active = 0;
  }

  function burst(emoji) {
    const count = reduceMotion ? 2 : PARTICLES;
    for (let i = 0; i < count; i++) {
      if (active >= MAX_ACTIVE) break;
      const el = document.createElement('span');
      el.className = 'fx-emoji' + (reduceMotion ? ' reduced' : '');
      el.textContent = emoji;
      el.style.left = (40 + Math.random() * 20).toFixed(1) + '%';           // start near center
      el.style.setProperty('--x', (Math.random() * 60 - 30).toFixed(0) + 'px');
      el.style.setProperty('--dx', (Math.random() * 80 - 40).toFixed(0) + 'px'); // drift
      el.style.setProperty('--rot', (Math.random() * 40 - 20).toFixed(0) + 'deg');
      el.style.setProperty('--scale', (0.8 + Math.random() * 0.6).toFixed(2));
      active += 1;
      el.addEventListener('animationend', () => { el.remove(); active -= 1; }, { once: true });
      container.appendChild(el);
    }
  }

  return {
    setEnabled(on) {
      enabled = !!on;
      if (!enabled) clear();
    },
    feed(sample) {
      if (!enabled) return;
      for (const emoji of trigger.feed(sample)) burst(emoji);
    },
    clear,
    destroy() { clear(); },
  };
}
```

- [ ] **Step 2: Append the effect styles**

Add to the END of `frontend/styles/clean-studio.css`:

```css
/* ── Face Analysis reaction effects overlay ───────────────────────────── */
.fa-fx{position:absolute;inset:0;overflow:hidden;pointer-events:none;z-index:3}
.fx-emoji{
  position:absolute;bottom:8%;font-size:34px;line-height:1;
  will-change:transform,opacity;opacity:0;
  animation:fxFloat 1400ms ease-out forwards;
}
.fx-emoji.reduced{animation-duration:900ms}
@keyframes fxFloat{
  0%{opacity:0;transform:translate(var(--x,0),0) scale(.6) rotate(0)}
  15%{opacity:1}
  100%{opacity:0;transform:translate(calc(var(--x,0) + var(--dx,0)),-160px) scale(var(--scale,1)) rotate(var(--rot,0))}
}
@media (prefers-reduced-motion: reduce){
  .fx-emoji{animation-duration:900ms}
}
```

- [ ] **Step 3: Sanity-check the module imports (no runtime error)**

Run: `node --input-type=module -e "await import('./frontend/reaction-trigger.js'); console.log('trigger import OK')"`
Expected: `trigger import OK` (confirms the trigger dependency resolves; `face-effects.js` itself needs a DOM, so it is exercised in Task 5).

- [ ] **Step 4: Commit**

```bash
git add frontend/face-effects.js frontend/styles/clean-studio.css
git commit -m "feat(facial): floating-emoji overlay module + styles"
```

---

### Task 3: Capability-based detection in vision.js

Run the face detector (emotion) and gesture recognizer together while effects are on, without changing the OFF path. Surface `blendshapes` + `gestures` on each frame.

**Files:**
- Modify: `frontend/vision.js` (imports/constants, add `setEffects`, rewrite the loop body in `launch`, extend the session object)

**Interfaces:**
- Produces:
  - `setEffects(on: boolean)` — export; toggles combined detection.
  - `onFrame(out)` payload gains `out.gestures` (`string[]` of top `categoryName` per hand, or `undefined` when the recognizer did not run this frame) and populates `out.blendshapes` whenever the face detector ran.
- Consumes (Task 4 relies on): `out.blendshapes`, `out.gestures`.

- [ ] **Step 1: Add the effects flag, constant, and setter**

In `frontend/vision.js`, just below `let session = null;` (currently line 6), add:

```js
let effectsOn = false;   // when true, run face + gesture together for the reaction overlay
const EFFECTS_INTERVAL_MS = 100;   // throttle effects-only detectors to ~10 fps
```

And add this export next to the other exports (e.g. after `export function setMode(mode){ ... }`):

```js
// Enable/disable combined face+gesture detection for the reaction-effects overlay.
// OFF keeps the classic single-detector-per-mode behavior.
export function setEffects(on){ effectsOn = !!on; }
```

- [ ] **Step 2: Extend the session object**

In `launch(...)`, change the session initializer (currently line 129) to add throttle timestamps:

```js
session = { stream, video, mode, running: true, rafId: 0, fps: 0, _t: performance.now(), _n: 0, _face: null, _fxFaceTs: 0, _fxGestTs: 0 };
```

- [ ] **Step 3: Replace the per-frame detection block**

In the `loop` inside `launch(...)`, replace the whole `const out = {...}; try { ... } catch (e){ ... }` block (currently lines 137–168) with:

```js
    const out = { mode: session.mode, detections: 0, fps: session.fps, blendshapes: null, gestures: undefined };
    const m = session.mode;
    const faceMode = m === 'face', poseMode = m === 'pose', handsMode = m === 'hands';
    // The current mode's detector runs every frame (as before). Effects-only
    // detectors run throttled so combined detection stays cheap.
    const faceDue = faceMode || (effectsOn && now - session._fxFaceTs >= EFFECTS_INTERVAL_MS);
    const gestDue = handsMode || (effectsOn && now - session._fxGestTs >= EFFECTS_INTERVAL_MS);

    try {
      if (faceDue){
        const r = tasks.face.detectForVideo(video, now);
        const faces = r.faceLandmarks || [];
        session._face = faces[0] || null;
        if (faceMode){
          out.detections = faces.length;
          for (const fl of faces){
            draw.drawConnectors(fl, FaceLandmarker.FACE_LANDMARKS_TESSELATION, { color: '#15794c66', lineWidth: 0.5 });
          }
        } else {
          session._fxFaceTs = now;
        }
        if (r.faceBlendshapes && r.faceBlendshapes[0]){
          out.blendshapes = pickBlendshapes(r.faceBlendshapes[0].categories);
        }
      }

      if (gestDue){
        const r = tasks.hands.recognizeForVideo(video, now);
        const hands = r.landmarks || [];
        if (handsMode){
          out.detections = hands.length;
          for (const lm of hands){
            draw.drawConnectors(lm, HandLandmarker.HAND_CONNECTIONS, { color: '#ffffffcc', lineWidth: 2 });
            draw.drawLandmarks(lm, { color: '#157a4c', radius: 2 });
          }
        } else {
          session._fxGestTs = now;
        }
        out.gestures = (r.gestures || []).map((g) => g && g[0] && g[0].categoryName).filter(Boolean);
      }

      if (poseMode){
        const r = tasks.pose.detectForVideo(video, now);
        const poses = r.landmarks || [];
        out.detections = poses.length;
        for (const lm of poses){
          draw.drawConnectors(lm, PoseLandmarker.POSE_CONNECTIONS, { color: '#157a4c', lineWidth: 2 });
          draw.drawLandmarks(lm, { color: '#0f5c39', radius: 2 });
        }
      }
    } catch (e){ /* a single bad frame must not kill the loop */ }
```

- [ ] **Step 4: Manually verify OFF-path parity and ON-path payload**

Run the app (project's usual command, e.g. `uvicorn backend.main:app --reload`) and open `http://localhost:8000/#/facial`. In the browser devtools console, temporarily run:

```js
// with effects OFF (default in this task, since facial.js isn't wired yet):
// Face mode should still show blendshape bars and mesh exactly as before.
```

Expected: Face/Pose/Hands modes behave exactly as before this task (effects flag defaults to `false`, so no behavior change yet). No console errors.

- [ ] **Step 5: Commit**

```bash
git add frontend/vision.js
git commit -m "feat(facial): capability-based face+gesture detection in vision.js"
```

---

### Task 4: Wire the overlay + toggle into facial.js

Mount the overlay, add the On/Off control, feed frames, and tear down cleanly. Default ON.

**Files:**
- Modify: `frontend/screens/facial.js` (import, module state, markup, wiring, `onFrame`, teardown)

**Interfaces:**
- Consumes: `createFaceEffects` (Task 2); `vision.setEffects`, `out.blendshapes`, `out.gestures` (Task 3).

- [ ] **Step 1: Import the effects module**

At the top of `frontend/screens/facial.js`, add after the existing imports (after line 5):

```js
import { createFaceEffects } from '../face-effects.js';
```

- [ ] **Step 2: Add module state + default**

Below `let mode = 'face';` (currently line 18), add:

```js
let effects = null;        // active reaction-effects overlay, or null
let effectsOn = true;      // reaction effects default ON
```

- [ ] **Step 3: Feed frames in `onFrame`**

Replace `onFrame` (currently line 119):

```js
function onFrame(out){
  lastFrame = out;
  setStatus(out);
  paintPanel(out);
  if (effects && effectsOn){
    effects.feed({ bs: out.blendshapes, gestures: out.gestures, t: performance.now() });
  }
}
```

- [ ] **Step 4: Reset the default and tear down on navigate-away**

In `facial()`, update the reset line and the `leave` handler (currently lines 152–158) to:

```js
  engine = 'mediapipe'; mode = 'face'; effectsOn = true;
  window.addEventListener('hashchange', function leave(){
    if (location.hash.replace(/^#/, '') !== '/facial'){
      vision.stop(); stopDeepface(); vision.setEffects(false);
      if (effects){ effects.destroy(); effects = null; }
      window.removeEventListener('hashchange', leave);
    }
  });
```

- [ ] **Step 5: Create the overlay + wire the toggle**

Inside the `queueMicrotask(() => { ... })` block in `facial()`, after `if (!root) return;` (currently line 162), add:

```js
    // Reaction effects overlay (default ON).
    const fxLayer = document.getElementById('fa-fx');
    if (fxLayer){
      effects = createFaceEffects(fxLayer);
      effects.setEnabled(effectsOn);
      vision.setEffects(effectsOn);
    }
    root.querySelectorAll('[data-fx]').forEach((b) => b.addEventListener('click', () => {
      effectsOn = b.getAttribute('data-fx') === 'on';
      root.querySelectorAll('[data-fx]').forEach((x) => x.classList.toggle('on', x === b));
      vision.setEffects(effectsOn);
      if (effects) effects.setEnabled(effectsOn);
    }));
```

- [ ] **Step 6: Add the overlay mount point + the rail toggle to the markup**

In the returned HTML string of `facial()`:

(a) Add the overlay div inside `.fa-stage`, right after the `<canvas id="fa-canvas"></canvas>` (currently line 205):

```js
        '<canvas id="fa-canvas"></canvas>' +
        '<div class="fa-fx" id="fa-fx"></div>' +
```

(b) Add the toggle to the left rail, right after the Detection-mode buttons — insert between the `data-mode="hands"` button and the `<button class="fa-btn start" ...>` (currently between lines 196 and 197):

```js
        '<button class="mode" data-mode="hands"><span class="r"></span> Hand landmarks</button>' +
        '<div class="lab" style="margin-top:16px">Reaction effects</div>' +
        '<div class="seg"><button data-fx="on" class="on">On</button><button data-fx="off">Off</button></div>' +
        '<button class="fa-btn start" id="fa-start">Start camera</button>' +
```

- [ ] **Step 7: Manual verification (see Task 5)**

Deferred to Task 5's full checklist.

- [ ] **Step 8: Commit**

```bash
git add frontend/screens/facial.js
git commit -m "feat(facial): wire reaction-effects overlay + On/Off toggle"
```

---

### Task 5: Manual verification + docs

**Files:**
- Modify: `README.md` (Face Analysis section)

- [ ] **Step 1: Run the app and walk the checklist**

Start the app (e.g. `uvicorn backend.main:app --reload`) and open `http://localhost:8000/#/facial`. Verify:

- [ ] Start camera in **Face** mode: smiling produces a 😄 burst; a clear frown/sad face → 😢; look surprised → 😮. Bursts float up and fade, and don't machine-gun (cooldown holds).
- [ ] With the camera still in Face mode, a **thumbs up** → 👍 and **thumbs down** → 👎 burst — confirming face + hands react together in the same mode.
- [ ] Blendshape bars and the Expression Analysis panel still update exactly as before (unchanged).
- [ ] Toggle **Reaction effects → Off**: bursts stop immediately and any on-screen emoji clear. Toggle back **On**: bursts resume.
- [ ] Switch to **Hands** mode: gesture emoji still burst; switch to **Pose** mode: no crash, pose landmarks draw, emotion/gesture emoji still burst (effects run headless).
- [ ] Switch **HSEmotion** engine: no errors; effects still work; the DeepFace panel is unchanged.
- [ ] Navigate away to another screen and back to `/facial`: no duplicate overlays, no console errors, camera releases.
- [ ] Confirm no new network requests fire for effects (Network tab shows only the existing calls).

- [ ] **Step 2: Re-run the unit tests**

Run: `node --test frontend/reaction-trigger.test.js`
Expected: PASS — `# pass 9`, `# fail 0`.

- [ ] **Step 3: Update the README**

In `README.md`, find the Face Analysis section and add a sentence describing the new feature, e.g.:

> **Reaction effects (Face Analysis):** Toggle-on floating-emoji reactions that burst when the camera reads a strong facial emotion (happy/sad/surprise/angry/disgust/fear/contempt) or a hand gesture (👍 👎 ✌️ ✋ ✊ ☝️ 🤟). On by default; turn it off with the "Reaction effects" control in the left rail. Purely visual — it doesn't change any analysis or scoring.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: describe Face Analysis reaction effects"
```

---

## Notes for the implementer

- The pure logic (Task 1) is the only unit-tested unit — keep DOM out of `reaction-trigger.js`. `face-effects.js` and the `vision.js`/`facial.js` changes are verified by the Task 5 checklist because they need a real camera + DOM.
- Do not lower or remove the `try/catch` around the per-frame detectors in `vision.js` — a single bad frame must never kill the loop.
- If combined detection feels janky on a slow machine, the follow-up (out of scope here) is raising `EFFECTS_INTERVAL_MS` or adding `delegate: 'GPU'` in `vision.js`'s `ensureTasks()`; do not change the delegate as part of this plan.
