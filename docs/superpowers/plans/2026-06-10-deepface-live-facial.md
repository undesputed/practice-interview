# Live DeepFace on the Facial Analysis Screen — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the DeepFace engine toggle on the live Facial Analysis screen actually work — periodically snapshot the user's face, score it with the real DeepFace model on the server, and show that result beside the live MediaPipe heuristic (so "fear"/"scared" is actually detected).

**Architecture:** DeepFace is a heavy server-side TensorFlow model, so it can't run per-frame. When the user selects the **DeepFace** engine, the browser captures a face crop ~every 2s, POSTs it to a new lightweight single-frame endpoint `POST /api/emotion/frame`, and renders the returned 7-class scores in a "DeepFace (server)" panel beside the per-frame MediaPipe bars. Selecting **MediaPipe** stops the server calls (heuristic only). The existing batch `/api/emotion` (post-interview) is untouched.

**Tech Stack:** FastAPI + the existing `backend/emotion.py` (`score_emotions`, DeepFace lazy import); vanilla-JS ES modules (`vision.js` MediaPipe loop, `facial.js` screen, `api.js`); pytest for the backend endpoint; manual browser verification for the live UI (frontend has no JS test runner by design).

**Key constraints / facts the executor must respect:**
- DeepFace is **optional + gated**: it only runs when env `EMOTION_ANALYSIS=1` AND the `deepface` package is installed. Every code path must degrade to `{"available": false}` otherwise — never 500.
- Reuse the existing `score_emotions(images: list[bytes]) -> list[dict|None]` in `backend/emotion.py` (each element is `{"dominant": str, "scores": {class: 0-100}}` or `None`). Do NOT reimplement DeepFace.
- `EMOTION_CLASSES` (the 7 labels) is exported by both `backend/emotion.py` and `frontend/emotion.js`. Use those; don't hardcode the list.
- The frontend has no JS test runner → frontend tasks verify via `node --check` + a manual browser smoke test. Backend tasks are pytest-TDD.
- Run the app: `EMOTION_ANALYSIS=1 uvicorn backend.main:app --port 8000`. Run tests: `pytest tests/test_emotion.py -v`.
- Commit hygiene: the working tree has unrelated WIP — stage only the files each task changes; never `git add -A`.

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `backend/requirements-emotion.txt` | Modify | Pin `opencv-python` explicitly (currently only transitive via deepface) |
| `backend/main.py` | Modify (after the `/api/emotion` handler) | New `POST /api/emotion/frame` — score ONE crop, return that frame's 7-class scores |
| `tests/test_emotion.py` | Modify | Tests for `/api/emotion/frame` (disabled / enabled+mock / raises / no-face) |
| `frontend/vision.js` | Modify | Store latest face landmarks; add `captureFaceCrop(sizePx)` returning a JPEG blob |
| `frontend/config.js` | Modify | Add `DEEPFACE_LIVE_MS: 2000` (snapshot cadence) |
| `frontend/api.js` | Modify | Add `scoreEmotionFrame(blob)` → POST multipart to `/api/emotion/frame` |
| `frontend/screens/facial.js` | Modify | Run the DeepFace snapshot loop while engine==='deepface'; render both tracks |
| `docs/features/mediapipe-vs-deepface.md` | Modify | Note DeepFace now runs live (periodic) on the Facial screen |

No new JS modules are created (all changed files are already served), so `tests/test_shell.py` does NOT change.

---

## Task 1: Backend — single-frame DeepFace endpoint (TDD)

**Files:**
- Modify: `backend/requirements-emotion.txt`
- Modify: `backend/main.py` (add handler after the existing `/api/emotion` route, ~line 116)
- Modify: `tests/test_emotion.py`

- [ ] **Step 1: Pin opencv-python**

In `backend/requirements-emotion.txt`, add a line under the existing deps:
```
opencv-python==4.10.0.84
```
(`score_emotions()` imports `cv2`; today it only arrives transitively via deepface. Pin it so the optional install is self-contained.)

- [ ] **Step 2: Write failing tests**

Add to `tests/test_emotion.py` (it already constructs `client = TestClient(app)`, imports `EMOTION_CLASSES`, and monkeypatches `main.score_emotions` — mirror that style; ensure `from backend import main` is imported at the top, as the existing enabled-endpoint tests already rely on it):

```python
def test_emotion_frame_disabled_returns_unavailable(monkeypatch):
    monkeypatch.delenv("EMOTION_ANALYSIS", raising=False)
    resp = client.post("/api/emotion/frame",
                       files={"image": ("crop.jpg", b"\xff\xd8\xff", "image/jpeg")})
    assert resp.status_code == 200
    assert resp.json() == {"available": False}


def test_emotion_frame_scores_when_enabled(monkeypatch):
    monkeypatch.setenv("EMOTION_ANALYSIS", "1")
    scores = {c: 0.0 for c in EMOTION_CLASSES}
    scores["fear"] = 80.0
    monkeypatch.setattr(main, "score_emotions",
                        lambda bufs: [{"dominant": "fear", "scores": scores}])
    resp = client.post("/api/emotion/frame",
                       files={"image": ("crop.jpg", b"x", "image/jpeg")})
    assert resp.status_code == 200
    data = resp.json()
    assert data["available"] is True
    assert data["dominant"] == "fear"
    assert data["scores"]["fear"] == 80.0


def test_emotion_frame_unavailable_when_scoring_raises(monkeypatch):
    monkeypatch.setenv("EMOTION_ANALYSIS", "1")
    def boom(bufs):
        raise ImportError("no deepface")
    monkeypatch.setattr(main, "score_emotions", boom)
    resp = client.post("/api/emotion/frame",
                       files={"image": ("crop.jpg", b"x", "image/jpeg")})
    assert resp.json() == {"available": False}


def test_emotion_frame_unavailable_when_no_face(monkeypatch):
    monkeypatch.setenv("EMOTION_ANALYSIS", "1")
    monkeypatch.setattr(main, "score_emotions", lambda bufs: [None])
    resp = client.post("/api/emotion/frame",
                       files={"image": ("crop.jpg", b"x", "image/jpeg")})
    assert resp.json() == {"available": False}
```

- [ ] **Step 3: Run tests, verify they FAIL**

Run: `pytest tests/test_emotion.py -k emotion_frame -v`
Expected: FAIL — `/api/emotion/frame` returns 404 (route doesn't exist yet).

- [ ] **Step 4: Implement the endpoint**

In `backend/main.py`, immediately AFTER the existing `@app.post("/api/emotion")` handler (around line 116), add:

```python
@app.post("/api/emotion/frame")
async def emotion_frame(image: UploadFile = File(...)):
    """Score ONE pre-cropped face image with DeepFace for the live Facial screen.
    Optional + graceful: returns {"available": False} when EMOTION_ANALYSIS != "1",
    DeepFace is unavailable, or no usable face was scored. The image is scored in
    memory and never written to disk."""
    if os.getenv("EMOTION_ANALYSIS") != "1":
        return {"available": False}
    buf = await image.read()
    try:
        scored = score_emotions([buf])
    except Exception as exc:  # DeepFace import/runtime failure -> degrade
        logging.warning("emotion frame scoring unavailable: %s", exc)
        return {"available": False}
    r = scored[0] if scored else None
    if not r:
        return {"available": False}
    return {"available": True, "dominant": r["dominant"], "scores": r["scores"]}
```

(`UploadFile`, `File`, `os`, `logging`, and `score_emotions` are already imported in `main.py` for the existing `/api/emotion` route — confirm, don't re-import.)

- [ ] **Step 5: Run tests, verify they PASS**

Run: `pytest tests/test_emotion.py -v`
Expected: PASS (the 4 new tests + all existing emotion tests).

- [ ] **Step 6: Commit**

```bash
git add backend/requirements-emotion.txt backend/main.py tests/test_emotion.py
git commit -m "feat(emotion): single-frame /api/emotion/frame endpoint for live DeepFace"
```

---

## Task 2: Frontend — `captureFaceCrop` in vision.js

**Files:**
- Modify: `frontend/vision.js`

- [ ] **Step 1: Store the latest face landmarks on the session**

In `frontend/vision.js`, in `launch()` where `session` is created (line 98), add a `_face` field:
```javascript
  session = { stream, video, mode, running: true, rafId: 0, fps: 0, _t: performance.now(), _n: 0, _face: null };
```
In the loop's face branch (after `out.detections = faces.length;`, ~line 112), record the first face's landmarks:
```javascript
        session._face = faces[0] || null;
```

- [ ] **Step 2: Add the `captureFaceCrop` export**

Add this exported function to `frontend/vision.js` (e.g. just after `setMode`, near line 39):

```javascript
// Capture a square JPEG crop of the current face from the live video for server-side
// emotion scoring. Returns a Promise<Blob|null>; null when not running, not in face
// mode, no face is detected, or the box is too small. Crops from the raw (un-mirrored)
// video, padded ~20% around the face landmark bounds.
export function captureFaceCrop(sizePx){
  if (!session || !session.running || session.mode !== 'face') return Promise.resolve(null);
  const lm = session._face, video = session.video;
  if (!lm || !video || !video.videoWidth) return Promise.resolve(null);
  let minX = 1, minY = 1, maxX = 0, maxY = 0;
  for (const p of lm){
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  const vw = video.videoWidth, vh = video.videoHeight;
  const padX = (maxX - minX) * 0.2, padY = (maxY - minY) * 0.2;
  const sx = Math.max(0, (minX - padX) * vw);
  const sy = Math.max(0, (minY - padY) * vh);
  const sw = Math.min(vw - sx, (maxX - minX + 2 * padX) * vw);
  const sh = Math.min(vh - sy, (maxY - minY + 2 * padY) * vh);
  if (sw < 8 || sh < 8) return Promise.resolve(null);
  const c = document.createElement('canvas');
  c.width = sizePx; c.height = sizePx;
  c.getContext('2d').drawImage(video, sx, sy, sw, sh, 0, 0, sizePx, sizePx);
  return new Promise((resolve) => c.toBlob((b) => resolve(b), 'image/jpeg', 0.8));
}
```

- [ ] **Step 3: Syntax check**

Run: `node --check frontend/vision.js`
Expected: no output (valid).

- [ ] **Step 4: Commit**

```bash
git add frontend/vision.js
git commit -m "feat(vision): captureFaceCrop() for live DeepFace snapshots"
```

---

## Task 3: Frontend — api wrapper + cadence config

**Files:**
- Modify: `frontend/config.js`
- Modify: `frontend/api.js`

- [ ] **Step 1: Add the live cadence to CONFIG**

In `frontend/config.js`, inside the `CONFIG` object (near the other `EMOTION_*` keys, ~line 11), add:
```javascript
  DEEPFACE_LIVE_MS: 2000,     // live Facial screen: snapshot for DeepFace every ~2s
```

- [ ] **Step 2: Add the `scoreEmotionFrame` api method**

In `frontend/api.js`, add this method to the exported `api` object (alongside `listSessions`, etc.). It uses a direct multipart `fetch` (not the JSON `request` helper) and never throws — it resolves to `{available:false}` on any error:
```javascript
  // POST a single face-crop blob to the live DeepFace endpoint. Never throws;
  // resolves to {available:false} when the server can't score it.
  scoreEmotionFrame: (blob) => {
    const fd = new FormData();
    fd.append('image', blob, 'crop.jpg');
    return fetch('/api/emotion/frame', { method: 'POST', body: fd })
      .then((r) => (r.ok ? r.json() : { available: false }))
      .catch(() => ({ available: false }));
  },
```

- [ ] **Step 3: Syntax check**

Run: `node --check frontend/api.js && node --check frontend/config.js`
Expected: no output.

- [ ] **Step 4: Commit**

```bash
git add frontend/config.js frontend/api.js
git commit -m "feat(api): scoreEmotionFrame() + DEEPFACE_LIVE_MS cadence"
```

---

## Task 4: Frontend — wire the DeepFace loop + both-tracks UI in facial.js

**Files:**
- Modify: `frontend/screens/facial.js`

- [ ] **Step 1: Add imports**

At the top of `frontend/screens/facial.js`, update the imports to include `api`, `CONFIG`, and `EMOTION_CLASSES`:
```javascript
import * as vision from '../vision.js';
import { dominantEmotion, EMOTION_CLASSES } from '../emotion.js';
import { esc } from '../util.js';
import { api } from '../api.js';
import { CONFIG } from '../config.js';
```

- [ ] **Step 2: Add DeepFace module state**

After the existing `let engine = 'mediapipe';` / `let mode = 'face';` (lines 15-16), add:
```javascript
// DeepFace live track (server, ~every DEEPFACE_LIVE_MS). Runs only while engine==='deepface'.
let dfRunning = false, dfTimer = null;
let dfStatus = 'off';   // 'off' | 'warming' | 'measuring' | 'live' | 'unavailable'
let dfDom = null, dfScores = null;
```

- [ ] **Step 3: Add the DeepFace render section + loop**

Add these functions to `frontend/screens/facial.js` (e.g. just below `bsBars`, near line 25):

```javascript
function dfSection(){
  if (engine !== 'deepface') return '';
  let body;
  if (dfStatus === 'warming'){
    body = '<div class="fa-note">Warming up DeepFace… the first read takes a few seconds.</div>';
  } else if (dfStatus === 'unavailable'){
    body = '<div class="fa-note">DeepFace is off on the server. Start it with <b>EMOTION_ANALYSIS=1</b>.</div>';
  } else if (dfStatus === 'live' && dfScores){
    body = '<div class="bs-bars">' + EMOTION_CLASSES.map((c) => {
      const v = Math.round(dfScores[c] || 0);
      return '<div class="bs-row"><span class="nm">' + c + '</span>' +
        '<span class="track"><span class="fill" style="width:' + v + '%"></span></span>' +
        '<span class="pct">' + v + '%</span></div>';
    }).join('') + '</div>';
  } else {
    body = '<div class="fa-note">Measuring…</div>';
  }
  const dom = (dfStatus === 'live' && dfDom) ? dfDom : '—';
  const every = Math.round(CONFIG.DEEPFACE_LIVE_MS / 1000);
  return '<div class="fa-df"><div class="phead"><div><h3>DeepFace (server)</h3>' +
      '<div class="desc">Trained model — refreshed every ' + every + 's.</div></div>' +
      '<div class="fa-dom"><div class="e">' + esc(dom) + '</div></div></div>' + body + '</div>';
}

async function deepfaceTick(){
  if (!dfRunning){ return; }
  if (vision.isRunning()){
    const blob = await vision.captureFaceCrop(CONFIG.EMOTION_CROP_PX);
    if (blob){
      if (dfStatus === 'warming' || dfStatus === 'off') dfStatus = 'measuring';
      const res = await api.scoreEmotionFrame(blob);
      if (!dfRunning) return;   // toggled off mid-request
      if (res && res.available){ dfStatus = 'live'; dfDom = res.dominant; dfScores = res.scores; }
      else { dfStatus = 'unavailable'; }
      paintPanel(lastFrame);    // reflect the new DeepFace reading immediately
    }
  }
  if (dfRunning) dfTimer = setTimeout(deepfaceTick, CONFIG.DEEPFACE_LIVE_MS);
}

function startDeepface(){
  if (dfRunning) return;
  dfRunning = true; dfStatus = 'warming'; dfDom = null; dfScores = null;
  deepfaceTick();
}

function stopDeepface(){
  dfRunning = false;
  if (dfTimer){ clearTimeout(dfTimer); dfTimer = null; }
  dfStatus = 'off'; dfDom = null; dfScores = null;
}
```

- [ ] **Step 4: Track the last frame + render the DeepFace section in the panel**

`deepfaceTick` repaints between MediaPipe frames, so it needs the last frame payload. Add a module-level cache and set it in `onFrame`. Change `onFrame` (line 53) from:
```javascript
function onFrame(out){ setStatus(out); paintPanel(out); }
```
to:
```javascript
let lastFrame = null;
function onFrame(out){ lastFrame = out; setStatus(out); paintPanel(out); }
```
Then in `paintPanel`, in the face-mode branch, append the DeepFace section to the panel HTML. Change the final assignment (lines 39-43) so the `.bs-bars` line is followed by `+ dfSection()`:
```javascript
  panel.innerHTML =
    '<div class="phead"><div><h3>Expression Analysis</h3>' +
      '<div class="desc">' + esc(engineLabel) + ' — 52 face-muscle coefficients, computed live in your browser.</div></div>' +
      '<div class="fa-dom"><div class="e">' + esc(dom.emotion) + '</div><div class="v">' + Math.round(dom.value) + '%</div></div></div>' +
    '<div class="bs-bars">' + bsBars(bs) + '</div>' +
    dfSection();
```
Also update `engineLabel` (line 38) so it no longer says "stubbed":
```javascript
  const engineLabel = engine === 'deepface' ? 'MediaPipe + DeepFace' : 'MediaPipe · blendshapes';
```

- [ ] **Step 5: Start/stop the loop on the right events**

(a) **Engine toggle** (lines 96-104): after setting `engine` and the note, start or stop the loop, and fix the note copy. Replace that listener body with:
```javascript
    root.querySelectorAll('[data-engine]').forEach((b) => b.addEventListener('click', () => {
      engine = b.getAttribute('data-engine');
      root.querySelectorAll('[data-engine]').forEach((x) => x.classList.toggle('on', x === b));
      const note = document.getElementById('fa-engine-note');
      if (note) note.textContent = engine === 'deepface'
        ? 'DeepFace scores a face snapshot on the server every ~2s, shown beside the live MediaPipe reading.'
        : 'MediaPipe runs live in your browser, every frame.';
      if (engine === 'deepface') startDeepface(); else stopDeepface();
      paintPanel({ mode: mode, blendshapes: null });
    }));
```

(b) **startCamera** (after `await vision.start(...)` succeeds, ~line 63): kick off the loop if DeepFace is selected. Add right after `setStatus(null);` in the `try`:
```javascript
    if (engine === 'deepface') startDeepface();
```

(c) **stopCamera** (line 72): stop the loop. Add as the first line of `stopCamera`:
```javascript
  stopDeepface();
```

(d) **Screen teardown**: in `facial()` (line 80), the screen resets engine/mode and re-arms a leave handler. Add `stopDeepface();` next to the initial `vision.stop();` (line 83), and inside the `leave` handler next to its `vision.stop();` (line 87), so navigating away kills the loop:
```javascript
  vision.stop(); stopDeepface();
  engine = 'mediapipe'; mode = 'face';
  window.addEventListener('hashchange', function leave(){
    if (location.hash.replace(/^#/, '') !== '/facial'){
      vision.stop(); stopDeepface();
      window.removeEventListener('hashchange', leave);
    }
  });
```

- [ ] **Step 6: Syntax check**

Run: `node --check frontend/screens/facial.js`
Expected: no output.

- [ ] **Step 7: Manual smoke (without DeepFace installed yet)**

Run `uvicorn backend.main:app --port 8000` (note: `EMOTION_ANALYSIS` NOT set yet). Open `http://localhost:8000/#/facial`, Start camera, click **DeepFace**. Expected: MediaPipe bars still update every frame; a "DeepFace (server)" panel appears showing "Warming up…" then **"DeepFace is off on the server. Start it with EMOTION_ANALYSIS=1."** (because the env flag isn't set — this proves graceful degradation). No console errors. Switch back to MediaPipe → the DeepFace panel disappears and no further `/api/emotion/frame` calls are made (check the Network tab).

- [ ] **Step 8: Commit**

```bash
git add frontend/screens/facial.js
git commit -m "feat(facial): live DeepFace track beside MediaPipe (server snapshots ~2s)"
```

---

## Task 5: Install the real stack + verify end-to-end + docs

**Files:**
- Modify: `docs/features/mediapipe-vs-deepface.md`
- (Install only; the heavy deps are NOT added to base requirements.)

- [ ] **Step 1: Install the optional emotion stack** (heavy — TensorFlow, ~3-4 GB, several minutes)

```bash
cd /Users/carrieyu/Desktop/Hipe/mediapipe-test
.venv/bin/pip install -r backend/requirements-emotion.txt
```
Expected: installs `deepface`, `tf-keras`, `opencv-python` (+ TensorFlow). Confirm: `.venv/bin/pip show deepface` returns a version.

- [ ] **Step 2: Backend real-model smoke test** (proves the actual DeepFace model loads + scores)

Start the server WITH the flag, then POST any small JPEG and confirm a real 7-class response. The first call is slow (TF import + weight download); allow up to ~60s.
```bash
cd /Users/carrieyu/Desktop/Hipe/mediapipe-test
EMOTION_ANALYSIS=1 .venv/bin/uvicorn backend.main:app --port 8044 & echo $! > /tmp/df.pid
sleep 5
# make a tiny valid JPEG with Pillow (already a transitive dep of deepface)
.venv/bin/python -c "from PIL import Image; Image.new('RGB',(112,112),(128,110,100)).save('/tmp/face.jpg','JPEG')"
curl -s -m 90 -F "image=@/tmp/face.jpg;type=image/jpeg" http://localhost:8044/api/emotion/frame
kill $(cat /tmp/df.pid); rm -f /tmp/df.pid /tmp/face.jpg
```
Expected JSON: `{"available": true, "dominant": "<one of the 7>", "scores": {"angry":…, "disgust":…, "fear":…, "happy":…, "sad":…, "surprise":…, "neutral":…}}`. This confirms the real model runs end-to-end. (A flat-color image won't be a meaningful emotion — the point is that the pipeline returns the 7 real classes, not that the label is correct.)

- [ ] **Step 3: Manual browser verification** (the real "does scared = fear" check — needs a human face)

```bash
EMOTION_ANALYSIS=1 uvicorn backend.main:app --port 8000
```
Open `http://localhost:8000/#/facial` → Start camera → click **DeepFace**. After the first warm-up (a few seconds), the "DeepFace (server)" panel should show live scores updating ~every 2s. Verify:
1. A neutral face → DeepFace dominant ≈ "neutral"; a smile → "happy".
2. A **scared** face (wide eyes, raised brows, open mouth) → DeepFace should now register **"fear"** (where the MediaPipe heuristic says "surprise"). The two tracks visibly differ — this is the whole point.
3. A **confused** face → still maps to the nearest of the 7 (expected; "confused" isn't in the model, by design).
4. No console errors; stopping the camera or leaving the screen stops the `/api/emotion/frame` calls (Network tab).

- [ ] **Step 4: Update the docs**

In `docs/features/mediapipe-vs-deepface.md`, add a short note (read the file first to place it in the right section) stating: *"As of 2026-06-10, the live Facial Analysis screen can run DeepFace too: selecting the DeepFace engine snapshots a face crop ~every 2s to `POST /api/emotion/frame` and shows the trained-model emotion beside the per-frame MediaPipe heuristic. It requires `EMOTION_ANALYSIS=1` and the optional `requirements-emotion.txt` install; it degrades to a clear 'off' message otherwise."*

- [ ] **Step 5: Commit**

```bash
git add docs/features/mediapipe-vs-deepface.md
git commit -m "docs(emotion): live DeepFace on the Facial screen"
```

(The `requirements-emotion.txt` opencv pin was already committed in Task 1. Do not commit the installed venv.)

---

## Task 6: Final verification + holistic review

**Files:** none (verification only)

- [ ] **Step 1: Full backend suite**

Run: `pytest -q`
Expected: PASS (all existing tests + the 4 new `/api/emotion/frame` tests). Note: this run does NOT need `EMOTION_ANALYSIS=1` — the endpoint tests mock `score_emotions`, and the real model is exercised only in Task 5.

- [ ] **Step 2: Confirm graceful-off still holds**

With the server running WITHOUT `EMOTION_ANALYSIS=1`, repeat Task 4 Step 7 quickly: the DeepFace panel shows the "off on the server" message and nothing 500s.

- [ ] **Step 3: Final commit (if any tweaks)**

```bash
git add -p   # stage only intended files
git commit -m "chore(emotion): finalize live DeepFace on facial screen"
```

---

## Self-Review (completed by author)

- **Spec coverage:** single-frame endpoint (Task 1) ✓; crop capture (Task 2) ✓; api + cadence (Task 3) ✓; live loop + both-tracks UI, started/stopped on the right events (Task 4) ✓; real install + fear verification (Task 5) ✓; graceful-off degradation asserted in Tasks 1, 4, 6 ✓. "Both tracks side by side" decision honored (MediaPipe per-frame bars + DeepFace section). "Facial screen only" scope honored (batch `/api/emotion` and the interview flow are untouched).
- **Placeholder scan:** every code step shows real code; the only natural-language insertion is the docs sentence in Task 5 (content given verbatim).
- **Name consistency:** `captureFaceCrop`, `scoreEmotionFrame`, `DEEPFACE_LIVE_MS`, `EMOTION_CROP_PX`, `dfRunning/dfTimer/dfStatus/dfDom/dfScores`, `dfSection/deepfaceTick/startDeepface/stopDeepface`, and the endpoint `/api/emotion/frame` are used identically across tasks. `EMOTION_CLASSES` is imported, not hardcoded.
- **Test-green invariant:** Task 1 adds tests + impl together (mocked, no real model), so the suite stays green at every commit; the heavy real-model check is isolated to Task 5 and never runs in the default suite.
- **Cost gating:** DeepFace server calls happen only while the DeepFace engine is selected AND the camera is running; selecting MediaPipe or leaving the screen stops them.

---

## Out of scope (noted, not built here)

- Interview/Live recording DeepFace (depends on the not-yet-built Live screen — Phase 8).
- Deployment hardening (persistent model-weight cache, cold-start warm-up, ECS health-check timeout). The audit flagged these; tackle them when enabling emotion in production.
- "Confused" or any emotion outside the 7 FER classes — not supported by DeepFace; would require a different model.
