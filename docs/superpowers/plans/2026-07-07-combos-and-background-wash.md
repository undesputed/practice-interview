# Two-Hand Combos + Background Wash Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add recognized two-hand gesture combos (with proper per-hand callouts) and a full-frame emotion-colored background wash to the Face Analysis reaction effects.

**Architecture:** A new pure `fx/combos.js` (combo table + `detectCombo`) and pure `fx/wash.js` (emotion→color + eased vignette). The trigger's gesture path becomes hand-aware and combo-aware, returning `{ activeEmotion, gestureOnsets:[{gesture,hand}], comboOnsets:[id] }`. The canvas engine anchors each callout to its own hand, draws combo callouts (bigger) between the hands, and paints the wash under the emitters.

**Tech Stack:** Vanilla ES modules (browser), Canvas 2D, MediaPipe `tasks-vision` (already loaded), Node's built-in `node:test`. No new runtime dependencies.

## Global Constraints

- Continue on the existing branch `feat/face-analysis-reaction-effects`. Do NOT create a new branch. (`main` has advanced with an unrelated PR #2 that also touched `clean-studio.css`; that merge conflict is handled at merge time, NOT here — this plan does not touch `clean-studio.css`.)
- Feature is `/facial` ONLY. Do NOT touch `/live`, `interview-engine.js`, `deepgram-client.js`, the backend, or any `.py`.
- Purely cosmetic: NO new network calls; the wash draws ONLY on the overlay canvas (never the analysis canvas), so the blendshape bars, Expression Analysis panel, HSEmotion/DeepFace track, and all scoring are unchanged. Effects OFF stays unchanged.
- Combo set (id → gestures → text → color): `awesome`→[Thumb_Up,Thumb_Up]→"AWESOME!"→`#3ddc84`; `big_no`→[Thumb_Down,Thumb_Down]→"BIG NO"→`#ff5c5c`; `peace`→[Victory,Victory]→"PEACE ✌"→`#ffd54a`; `pumped`→[Closed_Fist,Closed_Fist]→"PUMPED!"→`#ff9f43`; `woo`→[Open_Palm,Open_Palm]→"WOO!"→`#7fc7ff`; `love`→[ILoveYou,ILoveYou]→"LOVE!!"→`#c98bff`; `mixed`→[Thumb_Up,Thumb_Down]→"MIXED"→`#ffe08a`.
- Emotion → wash color: angry `#ff3b30`, happy `#ffcf40`, sad `#3b6dff`, surprise `#ffffff`, disgust `#6fd23a`, fear `#8a5cff`, confused `#ffb84d`.
- Trigger return shape: `{ activeEmotion: string|null, gestureOnsets: Array<{gesture:string, hand:number}>, comboOnsets: string[] }`. A combo frame suppresses individual onsets. Combo cooldown = 1500ms. Emotion state machine unchanged.
- Wash constants: `WASH_BASE = 0.38`, `WASH_EASE_MS = 250`, `PULSE_PEAK = 0.3`, `PULSE_LIFE_MS = 500`. Vignette: inner radius `0.35·max(w,h)` → outer `0.78·max(w,h)`.
- `frontend/package.json` already sets `{"type":"module"}`, so files under `frontend/` (incl. `frontend/fx/`) run as ESM under `node --test`.
- Each task commits ONLY its own files. The repo has unrelated pre-existing uncommitted changes (`deploy/*`) and untracked docs — never stage those.

---

### Task 1: Pure combo module

**Files:**
- Create: `frontend/fx/combos.js`
- Test: `frontend/fx/combos.test.js`

**Interfaces:**
- Produces:
  - `GESTURE_COMBOS: { [id]: { gestures: [string, string], text: string, color: string } }` (the 7 combos above).
  - `detectCombo(gestures: string[]) -> string|null` — filters out `None`/null, order-independent multiset match; returns the first matching combo id or null.

- [ ] **Step 1: Write the failing test**

Create `frontend/fx/combos.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectCombo, GESTURE_COMBOS } from './combos.js';

test('both thumbs up matches awesome', () => {
  assert.equal(detectCombo(['Thumb_Up', 'Thumb_Up']), 'awesome');
});

test('mixed matches order-independently', () => {
  assert.equal(detectCombo(['Thumb_Up', 'Thumb_Down']), 'mixed');
  assert.equal(detectCombo(['Thumb_Down', 'Thumb_Up']), 'mixed');
});

test('a non-combo pair returns null', () => {
  assert.equal(detectCombo(['Thumb_Up', 'Victory']), null);
});

test('fewer than two real gestures returns null', () => {
  assert.equal(detectCombo(['Thumb_Up']), null);
  assert.equal(detectCombo([]), null);
  assert.equal(detectCombo(['Thumb_Up', 'None']), null); // None filtered -> only 1 real
});

test('GESTURE_COMBOS has the 7 ids with exact text/color', () => {
  assert.deepEqual(Object.keys(GESTURE_COMBOS).sort(),
    ['awesome', 'big_no', 'love', 'mixed', 'peace', 'pumped', 'woo']);
  assert.deepEqual(GESTURE_COMBOS.awesome, { gestures: ['Thumb_Up', 'Thumb_Up'], text: 'AWESOME!', color: '#3ddc84' });
  assert.deepEqual(GESTURE_COMBOS.mixed.gestures, ['Thumb_Up', 'Thumb_Down']);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test frontend/fx/combos.test.js`
Expected: FAIL — `Cannot find module './combos.js'`.

- [ ] **Step 3: Write the implementation**

Create `frontend/fx/combos.js`:

```js
// frontend/fx/combos.js
// Two-hand gesture combos: pure data (gesture pair -> id/text/color) + a matcher. No DOM.
export const GESTURE_COMBOS = {
  awesome: { gestures: ['Thumb_Up', 'Thumb_Up'], text: 'AWESOME!', color: '#3ddc84' },
  big_no:  { gestures: ['Thumb_Down', 'Thumb_Down'], text: 'BIG NO', color: '#ff5c5c' },
  peace:   { gestures: ['Victory', 'Victory'], text: 'PEACE ✌', color: '#ffd54a' },
  pumped:  { gestures: ['Closed_Fist', 'Closed_Fist'], text: 'PUMPED!', color: '#ff9f43' },
  woo:     { gestures: ['Open_Palm', 'Open_Palm'], text: 'WOO!', color: '#7fc7ff' },
  love:    { gestures: ['ILoveYou', 'ILoveYou'], text: 'LOVE!!', color: '#c98bff' },
  mixed:   { gestures: ['Thumb_Up', 'Thumb_Down'], text: 'MIXED', color: '#ffe08a' },
};

// Order-independent multiset match over the two hands' gestures. Returns a combo id or null.
export function detectCombo(gestures) {
  const active = (gestures || []).filter((g) => g && g !== 'None');
  if (active.length < 2) return null;
  const sorted = [...active].sort();
  for (const id in GESTURE_COMBOS) {
    const want = [...GESTURE_COMBOS[id].gestures].sort();
    if (want.length === sorted.length && want.every((g, i) => g === sorted[i])) return id;
  }
  return null;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test frontend/fx/combos.test.js`
Expected: PASS — `# pass 5`, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add frontend/fx/combos.js frontend/fx/combos.test.js
git commit -m "feat(facial): two-hand gesture combo table + detector"
```

---

### Task 2: Pure background-wash module

**Files:**
- Create: `frontend/fx/wash.js`
- Test: `frontend/fx/wash.test.js`

**Interfaces:**
- Produces:
  - `EMOTION_WASH: { [emotion]: hexColor }` (the 7 emotions above).
  - `createWash() -> { setEmotion(emotion|null), pulse(hexColor), update(dt), draw(ctx, w, h), intensity(), pulseCount(), clear() }`.

- [ ] **Step 1: Write the failing test**

Create `frontend/fx/wash.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWash, EMOTION_WASH } from './wash.js';

test('EMOTION_WASH has the 7 emotions', () => {
  assert.deepEqual(Object.keys(EMOTION_WASH).sort(),
    ['angry', 'confused', 'disgust', 'fear', 'happy', 'sad', 'surprise']);
});

test('intensity rises toward base while an emotion is set', () => {
  const w = createWash();
  assert.equal(w.intensity(), 0);
  w.setEmotion('angry');
  for (let i = 0; i < 80; i++) w.update(16);
  assert.ok(w.intensity() > 0.3, `expected > 0.3, got ${w.intensity()}`);
});

test('intensity decays to ~0 after the emotion clears', () => {
  const w = createWash();
  w.setEmotion('angry');
  for (let i = 0; i < 80; i++) w.update(16);
  w.setEmotion(null);
  for (let i = 0; i < 120; i++) w.update(16);
  assert.ok(w.intensity() < 0.03, `expected < 0.03, got ${w.intensity()}`);
});

test('a pulse decays and is removed', () => {
  const w = createWash();
  w.pulse('#ff0000');
  assert.equal(w.pulseCount(), 1);
  for (let i = 0; i < 40; i++) w.update(16); // 640ms > 500ms life
  assert.equal(w.pulseCount(), 0);
});

test('an unknown emotion produces no wash', () => {
  const w = createWash();
  w.setEmotion('neutral');
  for (let i = 0; i < 80; i++) w.update(16);
  assert.equal(w.intensity(), 0);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test frontend/fx/wash.test.js`
Expected: FAIL — `Cannot find module './wash.js'`.

- [ ] **Step 3: Write the implementation**

Create `frontend/fx/wash.js`:

```js
// frontend/fx/wash.js
// Full-frame background wash: an edge vignette tinted by the active emotion (eased in/out)
// plus brief colored pulses on gesture/combo onsets. Pure maps + easing; draw() paints a 2D
// context. Unit-tested for the maps + easing (the visual look is verified on camera).
export const EMOTION_WASH = {
  angry: '#ff3b30', happy: '#ffcf40', sad: '#3b6dff', surprise: '#ffffff',
  disgust: '#6fd23a', fear: '#8a5cff', confused: '#ffb84d',
};
const WASH_BASE = 0.38;
const WASH_EASE_MS = 250;
const PULSE_PEAK = 0.3;
const PULSE_LIFE_MS = 500;

function hexToRgb(hex) {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

export function createWash() {
  let targetColor = null; // hex string, or null
  let intensity = 0;      // 0..1, eased toward the target
  const pulses = [];      // { rgb:[r,g,b], age }

  function vignette(ctx, w, h, rgb, alpha) {
    const cx = w / 2, cy = h / 2, R = Math.max(w, h);
    const grad = ctx.createRadialGradient(cx, cy, R * 0.35, cx, cy, R * 0.78);
    grad.addColorStop(0, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0)`);
    grad.addColorStop(1, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${alpha})`);
    ctx.fillStyle = grad; ctx.fillRect(0, 0, w, h);
  }

  return {
    setEmotion(emotion) { targetColor = emotion ? (EMOTION_WASH[emotion] || null) : null; },
    pulse(hex) { if (hex) pulses.push({ rgb: hexToRgb(hex), age: 0 }); },
    update(dt) {
      const target = targetColor ? WASH_BASE : 0;
      intensity += (target - intensity) * Math.min(1, dt / WASH_EASE_MS);
      for (let i = pulses.length - 1; i >= 0; i--) { pulses[i].age += dt; if (pulses[i].age >= PULSE_LIFE_MS) pulses.splice(i, 1); }
    },
    draw(ctx, w, h) {
      if (targetColor && intensity > 0.01) vignette(ctx, w, h, hexToRgb(targetColor), intensity);
      for (const p of pulses) vignette(ctx, w, h, p.rgb, PULSE_PEAK * (1 - p.age / PULSE_LIFE_MS));
    },
    intensity() { return intensity; },
    pulseCount() { return pulses.length; },
    clear() { targetColor = null; intensity = 0; pulses.length = 0; },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test frontend/fx/wash.test.js`
Expected: PASS — `# pass 5`, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add frontend/fx/wash.js frontend/fx/wash.test.js
git commit -m "feat(facial): background color-wash module (emotion vignette + pulses)"
```

---

### Task 3: Make the trigger hand- and combo-aware

**Files:**
- Modify: `frontend/reaction-trigger.js`
- Modify (rewrite): `frontend/reaction-trigger.test.js`

**Interfaces:**
- Consumes: `detectCombo` from `./fx/combos.js` (Task 1).
- Produces: `feed(...)` now returns `{ activeEmotion, gestureOnsets: Array<{gesture, hand}>, comboOnsets: string[] }`.

- [ ] **Step 1: Rewrite the test file**

Replace the entire contents of `frontend/reaction-trigger.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReactionTrigger } from './reaction-trigger.js';

// Inject scores directly: the sample's bs IS the score object; confused comes from bs.confused.
const opts = { scores: (bs) => bs, confusedScore: (bs) => bs.confused || 0 };
const S = (o) => ({ happy: 0, sad: 0, surprise: 0, angry: 0, disgust: 0, fear: 0, confused: 0, ...o });

// ── emotion state machine (unchanged behavior) ──
test('emotion activates only after SUSTAIN_FRAMES >= enter', () => {
  const t = createReactionTrigger(opts);
  assert.equal(t.feed({ bs: S({ sad: 80 }), t: 0 }).activeEmotion, null);
  assert.equal(t.feed({ bs: S({ sad: 80 }), t: 10 }).activeEmotion, null);
  assert.equal(t.feed({ bs: S({ sad: 80 }), t: 20 }).activeEmotion, 'sad');
});

test('emotion holds through hysteresis, exits below exit', () => {
  const t = createReactionTrigger(opts);
  for (const ts of [0, 10, 20]) t.feed({ bs: S({ sad: 80 }), t: ts });
  assert.equal(t.feed({ bs: S({ sad: 30 }), t: 30 }).activeEmotion, 'sad');
  assert.equal(t.feed({ bs: S({ sad: 20 }), t: 40 }).activeEmotion, null);
});

test('confused is selected when strongest', () => {
  const t = createReactionTrigger(opts);
  for (const ts of [0, 10, 20])
    assert.equal(t.feed({ bs: S({ confused: 70 }), t: ts }).activeEmotion, ts === 20 ? 'confused' : null);
});

// ── individual (per-hand) gesture onsets ──
test('single gesture fires once per-hand and respects cooldown', () => {
  const t = createReactionTrigger(opts);
  assert.deepEqual(t.feed({ gestures: ['Thumb_Up'], t: 0 }).gestureOnsets, [{ gesture: 'Thumb_Up', hand: 0 }]);
  assert.deepEqual(t.feed({ gestures: ['Thumb_Up'], t: 16 }).gestureOnsets, []);
  assert.deepEqual(t.feed({ gestures: [], t: 32 }).gestureOnsets, []);
  assert.deepEqual(t.feed({ gestures: ['Thumb_Up'], t: 1000 }).gestureOnsets, []); // within cooldown
  assert.deepEqual(t.feed({ gestures: ['Thumb_Up'], t: 1600 }).gestureOnsets, [{ gesture: 'Thumb_Up', hand: 0 }]);
});

test('two different gestures fire per-hand onsets with correct hand index', () => {
  const t = createReactionTrigger(opts);
  const r = t.feed({ gestures: ['Thumb_Up', 'Victory'], t: 0 });
  assert.deepEqual(r.gestureOnsets, [{ gesture: 'Thumb_Up', hand: 0 }, { gesture: 'Victory', hand: 1 }]);
  assert.deepEqual(r.comboOnsets, []);
});

test('a continuously held gesture never re-fires', () => {
  const t = createReactionTrigger(opts);
  assert.deepEqual(t.feed({ gestures: ['Open_Palm'], t: 0 }).gestureOnsets, [{ gesture: 'Open_Palm', hand: 0 }]);
  assert.deepEqual(t.feed({ gestures: ['Open_Palm'], t: 800 }).gestureOnsets, []);
  assert.deepEqual(t.feed({ gestures: ['Open_Palm'], t: 1600 }).gestureOnsets, []); // held
});

test('undefined gestures does not reset the active set', () => {
  const t = createReactionTrigger(opts);
  assert.deepEqual(t.feed({ gestures: ['Open_Palm'], t: 0 }).gestureOnsets, [{ gesture: 'Open_Palm', hand: 0 }]);
  assert.deepEqual(t.feed({ t: 10 }).gestureOnsets, []);
  assert.deepEqual(t.feed({ gestures: ['Open_Palm'], t: 20 }).gestureOnsets, []);
});

test('None is ignored', () => {
  const t = createReactionTrigger(opts);
  const r = t.feed({ gestures: ['None'], t: 0 });
  assert.deepEqual(r.gestureOnsets, []);
  assert.deepEqual(r.comboOnsets, []);
});

// ── two-hand combos ──
test('both thumbs up fires the awesome combo and suppresses individuals', () => {
  const t = createReactionTrigger(opts);
  const r = t.feed({ gestures: ['Thumb_Up', 'Thumb_Up'], t: 0 });
  assert.deepEqual(r.comboOnsets, ['awesome']);
  assert.deepEqual(r.gestureOnsets, []);
});

test('a combo fires once while held and re-arms after cooldown', () => {
  const t = createReactionTrigger(opts);
  assert.deepEqual(t.feed({ gestures: ['Thumb_Up', 'Thumb_Up'], t: 0 }).comboOnsets, ['awesome']);
  assert.deepEqual(t.feed({ gestures: ['Thumb_Up', 'Thumb_Up'], t: 100 }).comboOnsets, []); // held
  t.feed({ gestures: [], t: 200 });
  assert.deepEqual(t.feed({ gestures: ['Thumb_Up', 'Thumb_Up'], t: 300 }).comboOnsets, []); // within cooldown
  t.feed({ gestures: [], t: 400 });
  assert.deepEqual(t.feed({ gestures: ['Thumb_Up', 'Thumb_Up'], t: 1600 }).comboOnsets, ['awesome']); // after
});

test('the mixed combo (up + down) suppresses individuals', () => {
  const t = createReactionTrigger(opts);
  const r = t.feed({ gestures: ['Thumb_Up', 'Thumb_Down'], t: 0 });
  assert.deepEqual(r.comboOnsets, ['mixed']);
  assert.deepEqual(r.gestureOnsets, []);
});

test('emotion and gesture fire together', () => {
  const t = createReactionTrigger(opts);
  t.feed({ bs: S({ sad: 80 }), t: 0 }); t.feed({ bs: S({ sad: 80 }), t: 10 });
  const r = t.feed({ bs: S({ sad: 80 }), gestures: ['Thumb_Up'], t: 20 });
  assert.equal(r.activeEmotion, 'sad');
  assert.deepEqual(r.gestureOnsets, [{ gesture: 'Thumb_Up', hand: 0 }]);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test frontend/reaction-trigger.test.js`
Expected: FAIL — the current `feed` returns `gestureOnsets` as strings and has no `comboOnsets`.

- [ ] **Step 3: Update the implementation**

In `frontend/reaction-trigger.js`, add the import + constant near the top. After the existing
`import { emotionScores } from './emotion.js';` line add:

```js
import { detectCombo } from './fx/combos.js';
```

After `const GESTURE_COOLDOWN_MS = 1500;` add:

```js
const GESTURE_COMBO_COOLDOWN_MS = 1500;
```

In `createReactionTrigger`, after `const gestCooldown = opts.gestureCooldownMs ?? GESTURE_COOLDOWN_MS;` add:

```js
  const comboCooldown = opts.comboCooldownMs ?? GESTURE_COMBO_COOLDOWN_MS;
```

After `const lastGestureAt = {};` add:

```js
  let activeCombo = null;
  const lastComboAt = {};
```

Then replace the entire gesture block (from `const gestureOnsets = [];` through the `return { activeEmotion: active, gestureOnsets };` line) with:

```js
      const gestureOnsets = []; // [{ gesture, hand }]
      const comboOnsets = [];   // [comboId]
      if (gestures !== undefined) {
        const comboId = detectCombo(gestures);
        const current = new Set((gestures || []).filter((g) => g && g !== 'None'));
        if (comboId) {
          // Fire once per formation (subject to cooldown); suppress individual onsets.
          if (comboId !== activeCombo && (lastComboAt[comboId] == null || t - lastComboAt[comboId] >= comboCooldown)) {
            lastComboAt[comboId] = t; comboOnsets.push(comboId);
          }
          activeCombo = comboId;
          // Mark current gestures as seen so breaking the combo (hands still up) doesn't
          // spuriously fire individuals next frame.
          activeGestures = current;
        } else {
          activeCombo = null;
          for (const g of current) {
            if (!activeGestures.has(g)) {
              const last = lastGestureAt[g];
              if (last == null || t - last >= gestCooldown) {
                lastGestureAt[g] = t;
                gestureOnsets.push({ gesture: g, hand: gestures.indexOf(g) });
                activeGestures.add(g);
              }
            }
          }
          for (const g of activeGestures) { if (!current.has(g)) activeGestures.delete(g); }
        }
      }

      return { activeEmotion: active, gestureOnsets, comboOnsets };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test frontend/reaction-trigger.test.js`
Expected: PASS — `# pass 12`, `# fail 0`, output pristine.

- [ ] **Step 5: Commit**

```bash
git add frontend/reaction-trigger.js frontend/reaction-trigger.test.js
git commit -m "feat(facial): hand-aware gesture onsets + two-hand combo detection"
```

---

### Task 4: Bigger combo callouts (sizeMul)

**Files:**
- Modify: `frontend/fx/emitters.js` (the callout layer)
- Modify: `frontend/fx/emitters.test.js` (add a sizeMul test)

**Interfaces:**
- Produces: `createCalloutLayer().spawn(text, color, anchor, w, h, sizeMul = 1)` — combo callouts pass `sizeMul` (≈1.6) to render larger; existing 5-arg calls are unchanged (default 1).

Note: `sizeMul` only affects the drawn scale, which a pure test can't observe — the added test is a
contract/regression guard (6-arg spawn works, draw tolerates it); the actual larger size is verified
on camera in Task 6. So this task wires the param and adds the guard together (not strict red-green).

- [ ] **Step 1: Wire sizeMul through spawn + draw**

In `frontend/fx/emitters.js`, find the callout `spawn` (inside `createCalloutLayer`):

```js
    spawn(text, color, anchor, w, h) {
      const x = anchor ? anchor.x : w / 2;
      const y = anchor ? anchor.y - 70 : h * 0.14;
      items.push({ text, color, x, y, age: 0 });
    },
```

Replace it with:

```js
    spawn(text, color, anchor, w, h, sizeMul = 1) {
      const x = anchor ? anchor.x : w / 2;
      const y = anchor ? anchor.y - 70 : h * 0.14;
      items.push({ text, color, x, y, age: 0, sizeMul });
    },
```

Then in the callout `draw`, find the scale line:

```js
        const scale = k < 0.18 ? k / 0.18 : 1;        // scale-in over first 18%
```

Replace it with:

```js
        const scale = (k < 0.18 ? k / 0.18 : 1) * (it.sizeMul || 1); // scale-in, then combo size boost
```

- [ ] **Step 2: Add the guard test**

Append to `frontend/fx/emitters.test.js`:

```js
test('callout spawn accepts a sizeMul without breaking count/draw', () => {
  const c = createCalloutLayer();
  c.spawn('AWESOME!', '#3ddc84', { x: 100, y: 100 }, 400, 400, 1.6);
  assert.equal(c.count(), 1);
  c.draw(mockCtx()); // must not throw with the larger size
});
```

- [ ] **Step 3: Run the tests to verify they pass**

Run: `node --test frontend/fx/emitters.test.js`
Expected: PASS — `# pass 13`, `# fail 0` (the prior 12 + the new sizeMul guard).

- [ ] **Step 4: Commit**

```bash
git add frontend/fx/emitters.js frontend/fx/emitters.test.js
git commit -m "feat(facial): callout sizeMul for bigger combo callouts"
```

---

### Task 5: Integrate into the canvas engine

**Files:**
- Modify (rewrite): `frontend/face-effects.js`

**Interfaces:**
- Consumes: `GESTURE_COMBOS` (Task 1), `createWash` (Task 2), the new trigger return shape (Task 3), callout `sizeMul` (Task 4).

- [ ] **Step 1: Rewrite the module**

Replace the entire contents of `frontend/face-effects.js`:

```js
// frontend/face-effects.js
// Canvas overlay + render loop for the Face Analysis reaction effects. Composes the pure
// trigger (active emotion + per-hand gesture onsets + two-hand combos) with per-effect
// emitters, per-hand/combo callouts, and a full-frame emotion wash. No network, no scoring.
import { createReactionTrigger } from './reaction-trigger.js';
import { EMOTION_EMITTERS, GESTURE_CALLOUTS, createCalloutLayer } from './fx/emitters.js';
import { GESTURE_COMBOS } from './fx/combos.js';
import { createWash } from './fx/wash.js';
import { extractAnchors, mapPoint } from './fx/anchors.js';

export function createFaceEffects(canvas) {
  const ctx = canvas.getContext('2d');
  const trigger = createReactionTrigger();
  const emitters = {};
  for (const name in EMOTION_EMITTERS) emitters[name] = EMOTION_EMITTERS[name]();
  const callouts = createCalloutLayer();
  const wash = createWash();

  let enabled = false, rafId = 0, lastT = 0;
  let activeEmotion = null;
  let latest = null; // last fed sample

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(canvas.clientWidth * dpr));
    canvas.height = Math.max(1, Math.round(canvas.clientHeight * dpr));
  }

  function clearAll() {
    activeEmotion = null;
    for (const k in emitters) emitters[k].clear();
    callouts.clear();
    wash.clear();
    if (canvas.width && canvas.height) ctx.clearRect(0, 0, canvas.width, canvas.height);
  }

  // Wrist (landmark 0) of hand i, mapped + mirrored, or null.
  function handAnchor(handLandmarks, i) {
    if (!handLandmarks || !handLandmarks[i] || !handLandmarks[i].length) return null;
    return mapPoint(handLandmarks[i][0], canvas.width, canvas.height);
  }
  // Midpoint between the two hands' wrists (falls back to whichever hand is present, or null).
  function comboAnchor(handLandmarks) {
    const a = handAnchor(handLandmarks, 0), b = handAnchor(handLandmarks, 1);
    if (a && b) return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    return a || b || null;
  }

  function loop(now) {
    if (!enabled) return;
    const dt = lastT ? Math.min(50, now - lastT) : 16;
    lastT = now;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    // Background wash first (under the particles/callouts).
    wash.setEmotion(activeEmotion);
    wash.update(dt);
    wash.draw(ctx, canvas.width, canvas.height);
    const anchors = latest && latest.faceLandmarks
      ? extractAnchors(latest.faceLandmarks, canvas.width, canvas.height) : null;
    // Only the ACTIVE emitter receives anchors; inactive ones drain and fade.
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
      on = !!on;
      if (on === enabled) return; // idempotent: never stack a second rAF loop
      enabled = on;
      if (enabled) { resize(); lastT = 0; rafId = requestAnimationFrame(loop); window.addEventListener('resize', resize); }
      else { cancelAnimationFrame(rafId); window.removeEventListener('resize', resize); clearAll(); }
    },
    feed(sample) {
      if (!enabled) return;
      latest = sample;
      const { activeEmotion: ae, gestureOnsets, comboOnsets } = trigger.feed({
        bs: sample.bs, gestures: sample.gestures, t: sample.t,
      });
      activeEmotion = ae;
      // Individual callouts anchored to each hand; also flash the wash.
      for (const o of gestureOnsets) {
        const c = GESTURE_CALLOUTS[o.gesture];
        if (c) {
          callouts.spawn(c.text, c.color, handAnchor(sample.handLandmarks, o.hand), canvas.width, canvas.height);
          wash.pulse(c.color);
        }
      }
      // Combo callouts: bigger, centered between the hands.
      for (const id of comboOnsets) {
        const c = GESTURE_COMBOS[id];
        if (c) {
          callouts.spawn(c.text, c.color, comboAnchor(sample.handLandmarks), canvas.width, canvas.height, 1.6);
          wash.pulse(c.color);
        }
      }
    },
    clear() { clearAll(); },
    destroy() { enabled = false; cancelAnimationFrame(rafId); window.removeEventListener('resize', resize); clearAll(); },
  };
}
```

- [ ] **Step 2: Verify syntax**

Run: `node --check frontend/face-effects.js` → expect exit 0. (It imports browser-only modules and uses `window`, so it can't run under Node — `--check` validates syntax only; behavior is verified in Task 6.)

- [ ] **Step 3: Commit**

```bash
git add frontend/face-effects.js
git commit -m "feat(facial): per-hand + combo callouts and background wash in the engine"
```

---

### Task 6: Verification + docs

**Files:**
- Modify: `README.md` (extend the reaction-effects bullet)

- [ ] **Step 1: Re-run the full pure test suite**

Run:
```bash
node --test frontend/reaction-trigger.test.js frontend/fx/particles.test.js frontend/fx/anchors.test.js frontend/fx/emitters.test.js frontend/fx/combos.test.js frontend/fx/wash.test.js
```
Expected: all pass, output pristine.

- [ ] **Step 2: On-camera check** (start `uvicorn backend.main:app --reload --port 8000`, open `http://localhost:8000/#/facial`, Start camera, effects ON)

- [ ] Two hands, **both 👍** → one big **"AWESOME!"** centered between your hands (not two "OK!"). **👍 + 👎** → **"MIXED"**.
- [ ] Two hands, **different** gestures (e.g. 👍 + ✌️) → **"OK!"** near one hand and **"Nice!"** near the other (each at its own hand, no overlap).
- [ ] One hand → its callout at that hand, as before.
- [ ] Make each emotion → the **whole frame tints** its color (angry red, happy gold, sad blue, …), easing in and out as the expression changes; a gesture/combo briefly **flashes** its color. The tint is an edge vignette (face stays clear).
- [ ] The wash sits **under** the tears/fire/callouts (they're still visible on top).
- [ ] Blendshape bars + Expression Analysis panel unchanged; toggle Off clears everything; navigate away and back is clean; no new network requests.

- [ ] **Step 3: Update the README**

In `README.md`, extend the "Reaction effects (Face Analysis screen)" bullet to mention the two additions, e.g. append a sentence:

> Two hands trigger combos (e.g. both 👍 → "AWESOME!"), and the whole frame washes with the emotion's color (red for angry, gold for happy, …) as you emote.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: two-hand combos + background wash in reaction effects"
```

---

## Notes for the implementer

- Pure logic (`fx/combos.js`, `fx/wash.js`, `reaction-trigger.js`) is TDD/unit-tested. `face-effects.js` is browser-only (canvas + `window`) — `node --check` for syntax, behavior verified on camera in Task 6.
- Keep the trigger's individual-gesture "add-on-fire + prune" logic (do NOT switch it to `activeGestures = current` in the non-combo branch) — it is what lets a held gesture re-arm correctly after its cooldown.
- The wash draws only on the overlay canvas; never draw it on the analysis canvas (`fa-canvas`).
