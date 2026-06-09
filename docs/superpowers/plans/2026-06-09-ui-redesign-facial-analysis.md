# UI Redesign — Facial Analysis Screen Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the live Facial Analysis screen (`#/facial`): open the camera, run MediaPipe (Face / Pose / Hands) in the browser, draw the overlay on a canvas, and stream a live "Expression Analysis" panel (blendshape bars + a dominant-emotion readout) — nothing saved, all client-side.

**Architecture:** A self-contained `vision.js` module owns the MediaPipe tasks, camera, render loop, and overlay (separate task instances from the interview engine — `app.js`/`legacy.html` are untouched). A small `emotion.js` ports the backend blendshape→emotion formula so the live "dominant emotion" matches the report's MediaPipe track. The `screens/facial.js` render module wires the control rail (engine toggle, mode, start/stop, status), the camera stage, and the expression panel, and tears the camera down on Stop or navigation. Engine toggle MediaPipe↔DeepFace is present but **DeepFace is stubbed** (both show MediaPipe-derived data; DeepFace shows a "stubbed" badge), per the approved design.

**Tech Stack:** Vanilla ES modules, MediaPipe tasks-vision 0.10.35 (same CDN/WASM the interview app uses, from `config.js`). No build step. Backend serving verified by pytest; the live camera behavior verified manually in a browser with a webcam.

**Depends on:** Plan 1 (shell/router/`util.js`/`esc`). Independent of Plans 2–3 and the Live/New-interview work.

---

## Verified facts about the existing MediaPipe usage (reuse these patterns)

- Import (ESM, no build): `import { FaceLandmarker, PoseLandmarker, HandLandmarker, GestureRecognizer, FilesetResolver, DrawingUtils } from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35";`
- Init: `const fileset = await FilesetResolver.forVisionTasks(CONFIG.WASM_BASE);` then `FaceLandmarker.createFromOptions(fileset, { baseOptions:{ modelAssetPath: CONFIG.MODEL_URL }, runningMode:"VIDEO", numFaces:1, outputFaceBlendshapes:true })`. Pose: `PoseLandmarker.createFromOptions(..., { modelAssetPath: CONFIG.POSE_MODEL_URL, runningMode:"VIDEO", numPoses:1 })`. Hands: `GestureRecognizer.createFromOptions(..., { modelAssetPath: CONFIG.GESTURE_MODEL_URL, runningMode:"VIDEO", numHands:2 })`.
- Per-frame: `tasks.face.detectForVideo(video, performance.now())` → `result.faceLandmarks` (array) and `result.faceBlendshapes[0].categories` (array of `{categoryName, score}`). Pose → `result.landmarks`. Gestures → `recognizer.recognizeForVideo(video, now)` → `result.landmarks`.
- Draw: `const draw = new DrawingUtils(ctx); draw.drawConnectors(landmarks, FaceLandmarker.FACE_LANDMARKS_TESSELATION, {color, lineWidth}); draw.drawLandmarks(landmarks, {color, radius});` Pose connections: `PoseLandmarker.POSE_CONNECTIONS`. Hand connections: `HandLandmarker.HAND_CONNECTIONS`.
- Camera: `navigator.mediaDevices.getUserMedia({ video:{width:1280,height:720,facingMode:"user"}, audio:false })`; assign to a `<video>` (`muted=true; await video.play()`).
- Blendshape names are full Left/Right keys (e.g. `mouthSmileLeft`). `config.js` `CONFIG.BLENDSHAPES` is the curated list; `CONFIG.WASM_BASE` / model URLs are there too.
- The backend emotion formula (`backend/analysis.py`): `EMOTION_WEIGHTS` (grouped names like `mouthSmile`, averaged across Left/Right by `_bs_avg`), `NEUTRAL_BASE = 0.15`, classes `["angry","disgust","fear","happy","sad","surprise","neutral"]`. This plan ports it to JS verbatim.

---

## File Structure

**Create:**
- `frontend/emotion.js` — ported blendshape→emotion scorer (`emotionScores`, `dominantEmotion`).
- `frontend/vision.js` — MediaPipe wrapper: `start(canvas, mode, onFrame)`, `setMode`, `stop`, `isRunning`.
- `frontend/screens/facial.js` — the Facial Analysis screen render module.

**Modify:**
- `frontend/styles/clean-studio.css` — append Facial Analysis component styles.
- `frontend/screens/registry.js` — point `/facial` at the real module.
- `tests/test_shell.py` — assert the new modules are served.

**Untouched:** `app.js` and the rest of the interview engine, `config.js` (imported, not changed), `backend/`.

---

## Task 1: `emotion.js` (port the blendshape→emotion formula) + CSS

**Files:**
- Create: `frontend/emotion.js`
- Modify: `frontend/styles/clean-studio.css` (append)

- [ ] **Step 1: Create `frontend/emotion.js`**

```js
// Live blendshape -> emotion scorer. Ported VERBATIM from backend/analysis.py
// (EMOTION_WEIGHTS / _bs_avg / NEUTRAL_BASE / _frame_emotion_scores) so this
// screen's live "dominant emotion" matches the report's MediaPipe track.
// KEEP IN SYNC with backend/analysis.py if the weights change.

export const EMOTION_CLASSES = ['angry', 'disgust', 'fear', 'happy', 'sad', 'surprise', 'neutral'];

const EMOTION_WEIGHTS = {
  happy:    { mouthSmile: 1.0, cheekSquint: 0.6 },
  sad:      { mouthFrown: 1.0, browInnerUp: 0.6, browDown: 0.3 },
  angry:    { browDown: 1.0, mouthPress: 0.6, eyeSquint: 0.5 },
  surprise: { browInnerUp: 0.7, browOuterUp: 0.7, eyeWide: 0.8, jawOpen: 0.6 },
  fear:     { browInnerUp: 0.6, browOuterUp: 0.6, browDown: 0.5,
              eyeWide: 0.7, mouthStretch: 0.7, jawOpen: 0.4 },
  disgust:  { noseSneer: 1.0, mouthUpperUp: 0.8 },
};
const NEUTRAL_BASE = 0.15;

// Average the Left/Right variants that are present; a one-sided value counts at
// full strength. Falls back to the bare key, then 0.
function bsAvg(bs, name){
  const sides = [];
  const l = bs[name + 'Left'], r = bs[name + 'Right'];
  if (l != null) sides.push(l);
  if (r != null) sides.push(r);
  if (sides.length) return sides.reduce((a, b) => a + b, 0) / sides.length;
  return bs[name] != null ? bs[name] : 0;
}

// 7-class 0-100 distribution for one frame's blendshapes.
export function emotionScores(bs){
  bs = bs || {};
  const raw = {};
  let maxExpressive = 0;
  for (const emo in EMOTION_WEIGHTS){
    let s = 0;
    const w = EMOTION_WEIGHTS[emo];
    for (const name in w) s += w[name] * bsAvg(bs, name);
    raw[emo] = s;
    if (s > maxExpressive) maxExpressive = s;
  }
  raw.neutral = Math.max(0, NEUTRAL_BASE - maxExpressive);
  const total = EMOTION_CLASSES.reduce((a, c) => a + (raw[c] || 0), 0);
  const out = {};
  if (total <= 0){
    for (const c of EMOTION_CLASSES) out[c] = c === 'neutral' ? 100 : 0;
    return out;
  }
  for (const c of EMOTION_CLASSES) out[c] = Math.round(1000 * (raw[c] || 0) / total) / 10;
  return out;
}

// { emotion, value, scores } for the highest-scoring class.
export function dominantEmotion(bs){
  const scores = emotionScores(bs);
  let best = 'neutral', val = -1;
  for (const c of EMOTION_CLASSES){ if (scores[c] > val){ val = scores[c]; best = c; } }
  return { emotion: best, value: val, scores };
}
```

- [ ] **Step 2: Append Facial Analysis styles to `frontend/styles/clean-studio.css`**

Append exactly this to the END of the file:

```css

/* ---- Facial Analysis screen ---- */
.fa-grid{display:grid;grid-template-columns:220px 1fr;gap:16px;align-items:start}
.fa-rail{background:var(--card);border:1px solid var(--line);border-radius:var(--radius);padding:14px}
.fa-rail .lab{font-size:10.5px;letter-spacing:.12em;text-transform:uppercase;color:var(--ink-3);font-weight:700;margin:4px 0 8px}
.seg{display:flex;background:var(--bg);border:1px solid var(--line);border-radius:var(--radius-sm);padding:3px;margin-bottom:4px}
.seg button{flex:1;border:none;background:transparent;font-family:inherit;font-size:12px;font-weight:600;color:var(--ink-2);padding:7px 6px;border-radius:7px;cursor:pointer}
.seg button.on{background:var(--green);color:#fff}
.seg-note{font-size:10.5px;color:var(--ink-3);margin-top:6px;line-height:1.35}
.mode{display:flex;align-items:center;gap:8px;padding:8px 11px;border:1px solid var(--line);border-radius:var(--radius-sm);font-size:12.5px;margin-bottom:6px;color:var(--ink-2);background:none;width:100%;text-align:left;cursor:pointer;font-family:inherit}
.mode.on{background:var(--green-soft);border-color:var(--green);color:var(--green-deep);font-weight:600}
.mode .r{width:12px;height:12px;border-radius:50%;border:2px solid var(--line);flex:none}
.mode.on .r{border-color:var(--green);background:var(--green)}
.fa-btn{width:100%;border:none;border-radius:var(--radius-sm);padding:10px;font-family:inherit;font-weight:600;font-size:12.5px;margin-top:10px;cursor:pointer}
.fa-btn.start{background:var(--green);color:#fff}
.fa-btn.stop{background:var(--card);color:var(--ink-2);border:1px solid var(--line)}
.fa-stat{display:flex;justify-content:space-between;font-size:12px;color:var(--ink-3);padding:7px 0;border-bottom:1px dashed var(--line)}
.fa-stat b{color:var(--ink-2)} .fa-stat:last-of-type{border-bottom:none}
.fa-stage{background:#0f1113;border-radius:var(--radius);overflow:hidden;position:relative;aspect-ratio:16/9;display:grid;place-items:center}
.fa-stage canvas{width:100%;height:100%;object-fit:cover;display:block;transform:scaleX(-1)}
.fa-stage .ph{position:absolute;color:#6f767c;font-size:13px;text-align:center;padding:0 20px}
.fa-live{position:absolute;top:10px;left:10px;background:rgba(20,18,16,.6);color:#fff;font-size:10.5px;font-weight:600;letter-spacing:.08em;padding:4px 9px;border-radius:100px;display:none;align-items:center;gap:6px;z-index:2}
.fa-live.on{display:flex} .fa-live .dot{width:6px;height:6px;border-radius:50%;background:#7ad6a0}
.fa-panel{margin-top:14px;background:var(--card);border:1px solid var(--line);border-radius:var(--radius);padding:16px 18px}
.fa-panel .phead{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:12px}
.fa-panel .phead h3{font-size:14px;font-weight:700}
.fa-panel .phead .desc{font-size:11px;color:var(--ink-3);max-width:380px;margin-top:3px}
.fa-dom{text-align:right} .fa-dom .e{font-size:16px;font-weight:700;color:var(--green-deep);text-transform:capitalize} .fa-dom .v{font-size:11px;color:var(--ink-3)}
.bs-bars{display:grid;grid-template-columns:1fr 1fr;gap:4px 26px}
.bs-row{display:grid;grid-template-columns:96px 1fr 36px;align-items:center;gap:10px;font-size:12px;padding:3px 0}
.bs-row .nm{color:var(--ink-2)} .bs-row .track{height:7px;border-radius:100px;background:var(--line);overflow:hidden}
.bs-row .fill{height:100%;border-radius:100px;background:var(--green)} .bs-row .pct{text-align:right;font-variant-numeric:tabular-nums;color:var(--ink-3);font-size:11px}
.fa-note{font-size:12px;color:var(--ink-3);padding:6px 0}
@media(max-width:820px){.fa-grid{grid-template-columns:1fr}.bs-bars{grid-template-columns:1fr}}
```

- [ ] **Step 3: Manual verify served**

Run `uvicorn backend.main:app --port 8000`; open `http://localhost:8000/emotion.js` (200) and confirm `clean-studio.css` now contains `.fa-grid`.

- [ ] **Step 4: Commit**

```bash
git add frontend/emotion.js frontend/styles/clean-studio.css
git commit -m "feat(ui): add live emotion scorer (ported) and facial-analysis styles"
```

---

## Task 2: `vision.js` (MediaPipe wrapper — camera, loop, overlay)

**Files:**
- Create: `frontend/vision.js`

> **Post-review note (applied):** the `start()`/`stop()` below were hardened after code review (commit `54f14de`) with an in-flight start token (so a double-Start supersedes and releases the older stream instead of leaking a webcam track + running two loops) and a `try/catch` that releases the camera if model loading throws. The loop body moved into a `launch()` helper. The shipped `frontend/vision.js` is the source of truth; the **Audio twin must reuse `vision.js`'s lifecycle**, not re-implement it.

- [ ] **Step 1: Create `frontend/vision.js`**

```js
import { FaceLandmarker, PoseLandmarker, HandLandmarker, GestureRecognizer, FilesetResolver, DrawingUtils }
  from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35";
import { CONFIG } from './config.js';

let tasks = null;     // { face, pose, hands } — created once, reused
let session = null;   // active camera/loop, or null

// Create the three MediaPipe tasks once (downloads WASM + models on first call).
async function ensureTasks(){
  if (tasks) return tasks;
  const fileset = await FilesetResolver.forVisionTasks(CONFIG.WASM_BASE);
  const face = await FaceLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: CONFIG.MODEL_URL },
    runningMode: 'VIDEO', numFaces: 1, outputFaceBlendshapes: true,
  });
  const pose = await PoseLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: CONFIG.POSE_MODEL_URL },
    runningMode: 'VIDEO', numPoses: 1,
  });
  const hands = await GestureRecognizer.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: CONFIG.GESTURE_MODEL_URL },
    runningMode: 'VIDEO', numHands: 2,
  });
  tasks = { face, pose, hands };
  return tasks;
}

function pickBlendshapes(categories){
  const out = {};
  for (const k of CONFIG.BLENDSHAPES) out[k] = 0;
  if (categories) for (const c of categories){
    if (CONFIG.BLENDSHAPES.includes(c.categoryName)) out[c.categoryName] = c.score;
  }
  return out;
}

export function isRunning(){ return !!(session && session.running); }

export function setMode(mode){ if (session) session.mode = mode; }

// Stop the camera + loop and release the webcam. Idempotent.
export function stop(){
  if (!session) return;
  session.running = false;
  if (session.rafId) cancelAnimationFrame(session.rafId);
  if (session.stream) session.stream.getTracks().forEach((t) => t.stop());
  session = null;
}

// Start the camera and detection loop. `onFrame({mode, detections, fps, blendshapes})`
// is called once per frame; `blendshapes` is non-null only in face mode.
export async function start(canvas, mode, onFrame){
  stop();
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { width: 1280, height: 720, facingMode: 'user' }, audio: false,
  });
  const video = document.createElement('video');
  video.srcObject = stream; video.muted = true; video.playsInline = true;
  await video.play();
  await ensureTasks();
  if (!document.body.contains(canvas)){   // navigated away during model load
    stream.getTracks().forEach((t) => t.stop());
    return;
  }
  canvas.width = 1280; canvas.height = 720;
  const ctx = canvas.getContext('2d');
  const draw = new DrawingUtils(ctx);
  session = { stream, video, mode, running: true, rafId: 0, fps: 0, _t: performance.now(), _n: 0 };

  const loop = () => {
    if (!session || !session.running) return;
    if (!document.body.contains(canvas)){ stop(); return; }   // left the screen
    const now = performance.now();
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const out = { mode: session.mode, detections: 0, fps: session.fps, blendshapes: null };

    try {
      if (session.mode === 'face'){
        const r = tasks.face.detectForVideo(video, now);
        const faces = r.faceLandmarks || [];
        out.detections = faces.length;
        for (const fl of faces){
          draw.drawConnectors(fl, FaceLandmarker.FACE_LANDMARKS_TESSELATION, { color: '#15794c66', lineWidth: 0.5 });
        }
        if (r.faceBlendshapes && r.faceBlendshapes[0]){
          out.blendshapes = pickBlendshapes(r.faceBlendshapes[0].categories);
        }
      } else if (session.mode === 'pose'){
        const r = tasks.pose.detectForVideo(video, now);
        const poses = r.landmarks || [];
        out.detections = poses.length;
        for (const lm of poses){
          draw.drawConnectors(lm, PoseLandmarker.POSE_CONNECTIONS, { color: '#157a4c', lineWidth: 2 });
          draw.drawLandmarks(lm, { color: '#0f5c39', radius: 2 });
        }
      } else { // hands
        const r = tasks.hands.recognizeForVideo(video, now);
        const hands = r.landmarks || [];
        out.detections = hands.length;
        for (const lm of hands){
          draw.drawConnectors(lm, HandLandmarker.HAND_CONNECTIONS, { color: '#ffffffcc', lineWidth: 2 });
          draw.drawLandmarks(lm, { color: '#157a4c', radius: 2 });
        }
      }
    } catch (e){ /* a single bad frame must not kill the loop */ }

    session._n++;
    if (now - session._t > 500){
      session.fps = Math.round(session._n * 1000 / (now - session._t));
      session._n = 0; session._t = now;
    }
    out.fps = session.fps;
    onFrame(out);
    session.rafId = requestAnimationFrame(loop);
  };
  session.rafId = requestAnimationFrame(loop);
}
```

- [ ] **Step 2: Manual verify served**

Run the server; open `http://localhost:8000/vision.js` → 200 (JS). (Full behavior is verified in Task 4 with a camera.)

- [ ] **Step 3: Commit**

```bash
git add frontend/vision.js
git commit -m "feat(ui): add MediaPipe vision wrapper (camera, loop, overlay)"
```

---

## Task 3: `screens/facial.js` (the screen) + registry wiring

**Files:**
- Create: `frontend/screens/facial.js`
- Modify: `frontend/screens/registry.js`

- [ ] **Step 1: Create `frontend/screens/facial.js`**

```js
import * as vision from '../vision.js';
import { dominantEmotion } from '../emotion.js';
import { esc } from '../util.js';

// Curated blendshapes shown as bars, with friendly labels.
const DISPLAY = [
  ['mouthSmileLeft', 'Smile L'], ['mouthSmileRight', 'Smile R'],
  ['eyeBlinkLeft', 'Blink L'], ['eyeBlinkRight', 'Blink R'],
  ['browInnerUp', 'Brow Inner Up'], ['jawOpen', 'Jaw Open'],
  ['browDownLeft', 'Brow Down L'], ['browDownRight', 'Brow Down R'],
  ['mouthFrownLeft', 'Frown L'], ['mouthFrownRight', 'Frown R'],
  ['eyeWideLeft', 'Eye Wide L'], ['eyeWideRight', 'Eye Wide R'],
];

let engine = 'mediapipe';   // 'mediapipe' | 'deepface' (deepface stubbed)
let mode = 'face';          // 'face' | 'pose' | 'hands'

function bsBars(bs){
  return DISPLAY.map((d) => {
    const v = Math.max(0, Math.min(1, bs[d[0]] || 0));
    return '<div class="bs-row"><span class="nm">' + d[1] + '</span>' +
      '<span class="track"><span class="fill" style="width:' + Math.round(v * 100) + '%"></span></span>' +
      '<span class="pct">' + Math.round(v * 100) + '%</span></div>';
  }).join('');
}

function paintPanel(out){
  const panel = document.getElementById('fa-panel');
  if (!panel) return;
  if (out && out.mode !== 'face'){
    panel.innerHTML = '<div class="phead"><div><h3>Expression Analysis</h3>' +
      '<div class="desc">Switch to <b>Face</b> mode to see blendshapes and emotion.</div></div></div>' +
      '<div class="fa-note">' + (out.mode === 'pose' ? 'Pose' : 'Hand') + ' landmarks: ' + (out ? out.detections : 0) + ' detected.</div>';
    return;
  }
  const bs = (out && out.blendshapes) || {};
  const dom = dominantEmotion(bs);
  const engineLabel = engine === 'deepface' ? 'DeepFace (stubbed)' : 'MediaPipe · blendshapes';
  panel.innerHTML =
    '<div class="phead"><div><h3>Expression Analysis</h3>' +
      '<div class="desc">' + esc(engineLabel) + ' — 52 face-muscle coefficients, computed live in your browser.</div></div>' +
      '<div class="fa-dom"><div class="e">' + esc(dom.emotion) + '</div><div class="v">' + Math.round(dom.value) + '%</div></div></div>' +
    '<div class="bs-bars">' + bsBars(bs) + '</div>';
}

function setStatus(out){
  const st = document.getElementById('fa-state'); if (st) st.textContent = vision.isRunning() ? 'Detecting' : 'Stopped';
  const fp = document.getElementById('fa-fps'); if (fp) fp.textContent = out ? out.fps : 0;
  const dt = document.getElementById('fa-det'); if (dt) dt.textContent = out ? out.detections : 0;
  const live = document.getElementById('fa-live'); if (live) live.classList.toggle('on', vision.isRunning());
}

function onFrame(out){ setStatus(out); paintPanel(out); }

async function startCamera(){
  const canvas = document.getElementById('fa-canvas');
  const ph = document.getElementById('fa-ph');
  if (ph) ph.textContent = 'Loading model…';
  try {
    await vision.start(canvas, mode, onFrame);
    if (ph) ph.style.display = 'none';
    setStatus(null);
  } catch (e){
    if (ph){ ph.style.display = ''; ph.textContent = 'Camera unavailable: ' + (e && e.message ? e.message : e); }
  }
}

function stopCamera(){
  vision.stop();
  const ph = document.getElementById('fa-ph');
  if (ph){ ph.style.display = ''; ph.textContent = 'Camera stopped. Press Start to resume.'; }
  setStatus(null);
  paintPanel({ mode: mode, detections: 0, blendshapes: null });
}

export function facial(){
  // Stop any camera left running, then re-arm a one-shot teardown for when the
  // user navigates away from this screen.
  vision.stop();
  engine = 'mediapipe'; mode = 'face';
  window.addEventListener('hashchange', function leave(){
    if (location.hash.replace(/^#/, '') !== '/facial'){
      vision.stop();
      window.removeEventListener('hashchange', leave);
    }
  });

  queueMicrotask(() => {
    const root = document.getElementById('facial-body');
    if (!root) return;
    // wire engine toggle
    root.querySelectorAll('[data-engine]').forEach((b) => b.addEventListener('click', () => {
      engine = b.getAttribute('data-engine');
      root.querySelectorAll('[data-engine]').forEach((x) => x.classList.toggle('on', x === b));
      const note = document.getElementById('fa-engine-note');
      if (note) note.textContent = engine === 'deepface'
        ? 'DeepFace runs on the server and is stubbed for now — showing MediaPipe-derived data.'
        : 'MediaPipe runs live in your browser, every frame.';
      paintPanel({ mode: mode, blendshapes: null });
    }));
    // wire mode radios
    root.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => {
      mode = b.getAttribute('data-mode');
      root.querySelectorAll('[data-mode]').forEach((x) => x.classList.toggle('on', x === b));
      vision.setMode(mode);
      if (!vision.isRunning()) paintPanel({ mode: mode, blendshapes: null });
    }));
    document.getElementById('fa-start').addEventListener('click', startCamera);
    document.getElementById('fa-stop').addEventListener('click', stopCamera);
  });

  return '<div class="screen"><div class="screen-head"><h1>Facial Analysis</h1>' +
    '<span class="muted" style="font-size:12px">live · nothing is saved</span></div>' +
    '<div id="facial-body"><div class="fa-grid">' +
      '<div class="fa-rail">' +
        '<div class="lab">Emotion engine</div>' +
        '<div class="seg"><button data-engine="mediapipe" class="on">MediaPipe</button>' +
          '<button data-engine="deepface">DeepFace</button></div>' +
        '<div class="seg-note" id="fa-engine-note">MediaPipe runs live in your browser, every frame.</div>' +
        '<div class="lab" style="margin-top:16px">Detection mode</div>' +
        '<button class="mode on" data-mode="face"><span class="r"></span> Face landmarks</button>' +
        '<button class="mode" data-mode="pose"><span class="r"></span> Pose landmarks</button>' +
        '<button class="mode" data-mode="hands"><span class="r"></span> Hand landmarks</button>' +
        '<button class="fa-btn start" id="fa-start">Start camera</button>' +
        '<button class="fa-btn stop" id="fa-stop">Stop</button>' +
        '<div class="lab" style="margin-top:16px">Status</div>' +
        '<div class="fa-stat"><span>State</span><b id="fa-state">Stopped</b></div>' +
        '<div class="fa-stat"><span>FPS</span><b id="fa-fps">0</b></div>' +
        '<div class="fa-stat"><span>Detections</span><b id="fa-det">0</b></div>' +
      '</div>' +
      '<div><div class="fa-stage"><div class="fa-live" id="fa-live"><span class="dot"></span> LIVE</div>' +
        '<canvas id="fa-canvas"></canvas>' +
        '<div class="ph" id="fa-ph">Press “Start camera” to begin. Video stays on your device.</div></div>' +
        '<div class="fa-panel" id="fa-panel"></div></div>' +
    '</div></div></div>';
}
```

- [ ] **Step 2: Wire it in `frontend/screens/registry.js`**

Add import: `import { facial } from './facial.js';`
Change the `'/facial'` entry to:
```js
  ['/facial',      facial],
```

- [ ] **Step 3: Commit**

```bash
git add frontend/screens/facial.js frontend/screens/registry.js
git commit -m "feat(ui): live Facial Analysis screen (Face/Pose/Hands, engine toggle)"
```

---

## Task 4: Serving test + verification

**Files:**
- Modify: `tests/test_shell.py`

- [ ] **Step 1: Extend served-modules assertion**

In `tests/test_shell.py` `test_router_and_shell_modules_served`, add to the tuple:
`"/emotion.js", "/vision.js", "/screens/facial.js"`

- [ ] **Step 2: Run tests**

Run: `pytest tests/test_shell.py -v` then `pytest -q`. Expected: all green.

- [ ] **Step 3: Manual smoke (requires a webcam)**

Run the server, open `http://localhost:8000/#/facial`:
- Click **Start camera**, grant permission → "Loading model…" then live video with a green face mesh; LIVE badge shows; State=Detecting, FPS counts, Detections=1.
- The **Expression Analysis** panel shows live blendshape bars and a dominant emotion that reacts (smile → happy rises; open mouth/raise brows → surprise; frown/brow-down → angry/sad).
- Switch **Pose** / **Hands** → overlay changes; panel shows the "switch to Face mode" note with a landmark count. Switch back to **Face**.
- Toggle **DeepFace** → the panel description/badge changes and the note explains it's stubbed (data stays MediaPipe-derived). Toggle back to **MediaPipe**.
- Click **Stop** → camera light turns off, video stops, State=Stopped.
- Navigate to **Dashboard** while running → confirm the webcam light turns off (camera released on navigation). Return to `#/facial` → it's back to the idle "Press Start" state.
- Confirm `/legacy.html` interview still works and other placeholder routes still render.

- [ ] **Step 4: Commit**

```bash
git add tests/test_shell.py
git commit -m "test(ui): assert facial-analysis modules are served"
```

---

## Done — Definition of Done

- `#/facial` opens the camera on demand, runs MediaPipe Face/Pose/Hands live with a canvas overlay, and streams a live Expression Analysis panel (blendshape bars + dominant emotion derived by the ported formula).
- Engine toggle present; DeepFace is clearly stubbed (MediaPipe-derived data + badge).
- The camera is released on Stop and on navigating away (no lingering webcam light).
- Nothing is saved; `app.js`/`legacy.html` untouched. `pytest -q` green.

**Notes / follow-ups:**
- `emotion.js` duplicates the backend `EMOTION_WEIGHTS` table (documented, with a "keep in sync" comment). If the weights change often, a future refactor could serve them from one shared source.
- `engine`/`mode` are module-level (reset on each `facial()` render, mirroring the History fix) — acceptable for this single-instance screen.
- Audio & Transcript Analysis is the twin screen, planned separately.
```
