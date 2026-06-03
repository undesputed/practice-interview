# Live Actions Feed (Plan 2 of 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a transcript-style live "actions" feed — discrete debounced events for gestures, facial expressions, and head nod/shake — shown live during the interview and as a timeline + counts on the results page.

**Architecture:** A client-side `createActionDetector()` converts per-frame signals into debounced events (onset-only), appended live to an `#actions` panel and accumulated in an `events[]` array sent with the session. The backend tallies them via `summarize_actions` into `summary.actions`.

**Tech Stack:** vanilla JS (MediaPipe blendshapes + gesture results + head-pose matrix); Python/FastAPI, pytest.

**Spec:** `docs/superpowers/specs/2026-06-03-integrity-tension-actions-design.md` (Plan 2 of 2).

---

## Event shape

`{ t: ms-since-start, turn: <question index>, kind: "gesture"|"expression"|"head", label: string, icon: string }`.
Payload adds top-level `events: [Event]`. `summary.actions = { counts: {label: n}, total: int, events: [Event] }`.

---

## Task 1: `summarize_actions` (backend)

**Files:** Modify `backend/analysis.py`; Modify `tests/test_analysis.py`

- [ ] **Step 1: Append tests**

```python
from backend.analysis import summarize_actions

def test_summarize_actions_counts():
    events = [
        {"t": 1, "turn": 0, "kind": "gesture", "label": "Thumb Up", "icon": "👍"},
        {"t": 2, "turn": 0, "kind": "expression", "label": "Smile", "icon": "🙂"},
        {"t": 3, "turn": 1, "kind": "expression", "label": "Smile", "icon": "🙂"},
    ]
    out = summarize_actions(events)
    assert out["total"] == 3
    assert out["counts"] == {"Thumb Up": 1, "Smile": 2}
    assert out["events"] == events

def test_summarize_actions_empty():
    assert summarize_actions([]) == {"counts": {}, "total": 0, "events": []}
```

- [ ] **Step 2: Run to verify fail**

Run: `. .venv/bin/activate && pytest tests/test_analysis.py -k summarize_actions -v` → FAIL (ImportError).

- [ ] **Step 3: Implement** in `backend/analysis.py`:

```python
def summarize_actions(events: list[dict]) -> dict:
    """Tally action events by label; pass the raw list through for the report timeline."""
    counts: dict = {}
    for e in events:
        label = e.get("label", "?")
        counts[label] = counts.get(label, 0) + 1
    return {"counts": counts, "total": len(events), "events": events}
```

- [ ] **Step 4: Run to verify pass**

Run: `pytest tests/test_analysis.py -k summarize_actions -v` → PASS; then `pytest tests/test_analysis.py -v`.

- [ ] **Step 5: Commit**

```bash
git add backend/analysis.py tests/test_analysis.py
git commit -m "feat: summarize_actions (tally action events)"
```

---

## Task 2: API — accept `events`, expose `summary.actions`

**Files:** Modify `backend/main.py`; Modify `tests/test_main.py`

- [ ] **Step 1: Append test** to `tests/test_main.py`

```python
def test_session_summary_has_actions(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "")
    body = {"role": "X", "frames": [_frame(i*100.0) for i in range(3)],
            "transcript": {"full_text": "", "segments": []},
            "events": [{"t": 1, "turn": 0, "kind": "gesture", "label": "Smile", "icon": "🙂"},
                       {"t": 2, "turn": 0, "kind": "gesture", "label": "Smile", "icon": "🙂"}]}
    data = client.post("/api/session", json=body).json()
    assert data["summary"]["actions"]["total"] == 2
    assert data["summary"]["actions"]["counts"]["Smile"] == 2
```

- [ ] **Step 2: Run to verify fail**

Run: `pytest tests/test_main.py -k actions -v` → FAIL (no actions / events not accepted).

- [ ] **Step 3: Implement** in `backend/main.py`
(a) Add `summarize_actions` to the analysis import line (append it to the existing `from backend.analysis import ...`).
(b) In `class SessionRequest(BaseModel):`, add a field:
```python
    events: list = []
```
(c) In `session`, immediately AFTER `summary["integrity"] = integrity_metrics(req.frames)`, add:
```python
    summary["actions"] = summarize_actions(req.events)
```

- [ ] **Step 4: Run** `pytest -q` → all pass.

- [ ] **Step 5: Commit**

```bash
git add backend/main.py tests/test_main.py
git commit -m "feat: accept events and expose summary.actions"
```

---

## Task 3: `frontend/actions.js` (event detector)

**Files:** Create `frontend/actions.js`

- [ ] **Step 1: Create the file** with exactly:

```javascript
// frontend/actions.js
// Detects discrete interview "actions" (gestures, expressions, head nod/shake) from per-frame
// signals, debounced (fire once at onset). Holds detector state across frames.

const GESTURE_ICONS = {
  Thumb_Up: "👍", Victory: "✌️", Open_Palm: "✋", Closed_Fist: "✊",
  Pointing_Up: "☝️", Thumb_Down: "👎", ILoveYou: "🤟",
};
const SMILE_ON = 0.5, FROWN_ON = 0.4, BROW_ON = 0.5, SURPRISE_ON = 0.5, HYS = 0.15;
const NOD_AMP = 6, SHAKE_AMP = 6, HEAD_WINDOW_MS = 1000, HEAD_COOLDOWN_MS = 1500;

function euler(m) {
  const R = (i, j) => m[i * 4 + j];
  const pitch = (Math.atan2(R(2, 1), R(2, 2)) * 180) / Math.PI;
  const yaw = (Math.atan2(-R(2, 0), Math.hypot(R(2, 1), R(2, 2))) * 180) / Math.PI;
  return { pitch, yaw };
}

function reversals(values, amp) {
  let count = 0, dir = 0, last = values[0];
  for (let i = 1; i < values.length; i++) {
    const delta = values[i] - last;
    if (Math.abs(delta) < amp) continue;
    const d = delta > 0 ? 1 : -1;
    if (dir !== 0 && d !== dir) count++;
    dir = d; last = values[i];
  }
  return count;
}

export function createActionDetector() {
  let activeGestures = new Set();
  const expr = { smile: false, frown: false, brow: false, surprise: false };
  let headBuf = [];
  let nodCd = 0, shakeCd = 0;

  function exprEvent(out, t, turn, key, value, onThresh, icon, label) {
    if (!expr[key] && value > onThresh) {
      expr[key] = true;
      out.push({ t, turn, kind: "expression", label, icon });
    } else if (expr[key] && value < onThresh - HYS) {
      expr[key] = false;
    }
  }

  return {
    feed({ t, turn, bs, gestures, m, face }) {
      const out = [];
      const current = new Set((gestures || []).filter((g) => g && g !== "None"));
      for (const g of current) {
        if (!activeGestures.has(g)) {
          out.push({ t, turn, kind: "gesture", label: g.replace(/_/g, " "), icon: GESTURE_ICONS[g] || "🖐" });
        }
      }
      activeGestures = current;

      if (face && bs) {
        const smile = ((bs.mouthSmileLeft || 0) + (bs.mouthSmileRight || 0)) / 2;
        const frown = ((bs.mouthFrownLeft || 0) + (bs.mouthFrownRight || 0)) / 2;
        const brow = Math.max(bs.browInnerUp || 0, bs.browOuterUpLeft || 0, bs.browOuterUpRight || 0);
        const surprise = bs.jawOpen || 0;
        exprEvent(out, t, turn, "smile", smile, SMILE_ON, "🙂", "Smile");
        exprEvent(out, t, turn, "frown", frown, FROWN_ON, "☹️", "Frown");
        exprEvent(out, t, turn, "brow", brow, BROW_ON, "🤨", "Eyebrow raise");
        exprEvent(out, t, turn, "surprise", surprise, SURPRISE_ON, "😮", "Surprise");
      }

      if (face && m) {
        const { pitch, yaw } = euler(m);
        headBuf.push({ t, pitch, yaw });
        headBuf = headBuf.filter((p) => t - p.t <= HEAD_WINDOW_MS);
        if (headBuf.length >= 4) {
          if (t >= nodCd && reversals(headBuf.map((p) => p.pitch), NOD_AMP) >= 2) {
            out.push({ t, turn, kind: "head", label: "Nod", icon: "🙆" });
            nodCd = t + HEAD_COOLDOWN_MS;
          }
          if (t >= shakeCd && reversals(headBuf.map((p) => p.yaw), SHAKE_AMP) >= 2) {
            out.push({ t, turn, kind: "head", label: "Shake", icon: "🙅" });
            shakeCd = t + HEAD_COOLDOWN_MS;
          }
        }
      }
      return out;
    },
  };
}
```

- [ ] **Step 2: Verify & commit**

```bash
node --check frontend/actions.js
git add frontend/actions.js
git commit -m "feat: action detector (gestures, expressions, nod/shake) with debounce"
```

---

## Task 4: app.js — wire detector, live panel, payload, render

**Files:** Modify `frontend/app.js`

- [ ] **Step 1: Import** — after the `import { pickPose, pickHands, pickObjects } from "./landmarks.js";` line, add:
```javascript
import { createActionDetector } from "./actions.js";
```

- [ ] **Step 2: State** — after the `let frames = [];` line, add:
```javascript
let events = [];
let actionDetector = null;
```

- [ ] **Step 3: Reset + create per session** — replace:
```javascript
  frames = []; segments = []; turnIndex = -1;
  lastHandResult = null; lastObjectResult = null; lastBodyTs = 0;
```
with:
```javascript
  frames = []; segments = []; turnIndex = -1; events = [];
  actionDetector = createActionDetector();
  lastHandResult = null; lastObjectResult = null; lastBodyTs = 0;
```

- [ ] **Step 4: Detect + display live** — replace:
```javascript
  frames.push(frame);

  $("hud-time").textContent = ((now - sessionStart) / 1000).toFixed(0) + "s";
```
with:
```javascript
  frames.push(frame);

  if (actionDetector) {
    const gestureNames = (lastHandResult && lastHandResult.gestures)
      ? lastHandResult.gestures.map((g) => g && g[0] && g[0].categoryName)
      : [];
    for (const ev of actionDetector.feed({ t: frame.t, turn: turnIndex, bs, gestures: gestureNames, m, face: hasFace })) {
      events.push(ev);
      appendAction(ev);
    }
  }

  $("hud-time").textContent = ((now - sessionStart) / 1000).toFixed(0) + "s";
```

- [ ] **Step 5: `appendAction` + `fmtTime` helpers** — add these near the `systemLine` helper (top-level functions):
```javascript
function fmtTime(ms) {
  const mm = String(Math.floor(ms / 60000)).padStart(2, "0");
  const ss = String(Math.floor((ms % 60000) / 1000)).padStart(2, "0");
  return `${mm}:${ss}`;
}

function appendAction(ev) {
  const el = $("actions");
  if (!el) return;
  const div = document.createElement("div");
  div.className = "action-line";
  div.textContent = `${fmtTime(ev.t)} · ${ev.icon} ${ev.label}`;
  el.appendChild(div);
  el.scrollTop = el.scrollHeight;
}
```

- [ ] **Step 6: Send events in the payload** — replace:
```javascript
    body: JSON.stringify({ role, frames, transcript: { full_text, segments } }),
```
with:
```javascript
    body: JSON.stringify({ role, frames, transcript: { full_text, segments }, events }),
```

- [ ] **Step 7: Render actions on results** — in `renderResults`, immediately AFTER the line `$("saved-path").textContent = "Saved to sessions/" + data.session_id + "/";` add:
```javascript
  const act = data.summary.actions || { counts: {}, events: [] };
  fillList("card-actions", Object.entries(act.counts).map(([k, v]) => `${k} ×${v}`));
  const tl = $("actions-timeline");
  if (tl) {
    while (tl.firstChild) tl.removeChild(tl.firstChild);
    for (const ev of (act.events || [])) {
      const li = document.createElement("li");
      li.textContent = `${fmtTime(ev.t)} · ${ev.icon} ${ev.label}`;
      tl.appendChild(li);
    }
  }
```

- [ ] **Step 8: Verify**

Run: `node --check frontend/app.js` (ignore module note); `grep -n innerHTML frontend/app.js` → empty.

- [ ] **Step 9: Commit**

```bash
git add frontend/app.js
git commit -m "feat: live action detection + feed panel, payload events, results actions"
```

---

## Task 5: UI — live actions panel + results Actions section (frontend-design)

**Files:** Modify `frontend/index.html`, `frontend/style.css`

> **REQUIRED SUB-SKILL:** invoke the **`frontend-design`** skill.

- [ ] **Step 1: Interview screen** — add an **Actions panel** alongside the existing `#transcript` on `#screen-interview`: a titled, scrolling container with `<div id="actions"></div>` (lines appended as `<div class="action-line">`). Match the transcript panel's styling.

- [ ] **Step 2: Results screen** — add an **Actions section** containing: a `<ul id="card-actions"></ul>` (counts) and a separate scrolling `<ul id="actions-timeline"></ul>` (the timestamped list). Place it after the coaching block / near the per-question table.

- [ ] **Step 3: HARD CONSTRAINTS** — keep all existing IDs intact (`screen-start, screen-interview, screen-results, role-select, start-btn, cam, transcript, hud-*, end-btn, chip-*, card-eye, card-head, card-expression, card-posture, card-engagement, card-presence, metrics-per-question, chart-img, coaching, saved-path, newsession-btn`). Keep `<script type="module" src="/app.js">` and the stylesheet link. No `<script>`/inline JS. DOM structure only.

- [ ] **Step 4: Verify**

Run:
```bash
for id in actions card-actions actions-timeline transcript screen-interview screen-results; do printf "%s " $id; grep -c "id=\"$id\"" frontend/index.html; done
```
Expected: each prints `1`.

- [ ] **Step 5: Commit**

```bash
git add frontend/index.html frontend/style.css
git commit -m "feat: live actions panel + results actions timeline/counts"
```

---

## Task 6: Manual end-to-end verification

**Files:** none

- [ ] **Step 1:** `. .venv/bin/activate && pytest -q` → all pass.
- [ ] **Step 2:** `uvicorn backend.main:app --reload --port 8000`, run a short interview: do 👍, ✌️, smile, frown, nod, shake. Confirm:
  1. Each action appears live in the `#actions` panel as `mm:ss · icon label` (once per onset, not spamming).
  2. Results page shows the Actions counts and the full timeline.
  3. `sessions/<id>/summary.json` has `actions` with `counts`/`total`/`events`.
- [ ] **Step 3:** Note completion. The nod/shake amplitude (`NOD_AMP`/`SHAKE_AMP`) and expression thresholds in `frontend/actions.js` are tunable if detection feels too eager/sluggish.

---

## Self-Review (completed during planning)

- **Spec coverage (D):** event detection (gestures/expressions/nod-shake, debounced) → Task 3; live panel → Tasks 4–5; payload `events` + `summary.actions` → Tasks 2,4; report timeline + counts → Tasks 4,5; tally → Task 1; verify → Task 6.
- **Type consistency:** Event shape `{t,turn,kind,label,icon}` produced by `actions.js` (Task 3), pushed/sent by `app.js` (Task 4), accepted by `SessionRequest.events` (Task 2), tallied by `summarize_actions` (Task 1), and read back as `summary.actions.{counts,events}` in `renderResults` (Task 4). The `#actions`, `#card-actions`, `#actions-timeline` IDs in Task 4 match the DOM contract in Task 5. `fmtTime` defined once (Task 4 Step 5) and used in both live + results rendering.
- **Placeholders:** none — full code in every code step; only the panel/section markup is delegated to `frontend-design` with an explicit ID contract.
