# MediaPipe-Derived Emotion Track Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a second, heuristic emotion track derived from MediaPipe blendshapes (no pixels, no TensorFlow), shown side-by-side with the existing DeepFace track in the report.

**Architecture:** A pure server-side function `emotion_from_blendshapes(frames)` maps each frame's blendshape coefficients to a 7-class distribution via an EMFACS weight table, then reuses the existing `aggregate_emotions()` so the output shape is identical to the DeepFace track. It is wired into `/api/session` under a new `summary["emotion_mediapipe"]` key, charted by `report.py`, and rendered as a parallel card in the frontend. The DeepFace track and all raw MediaPipe metrics are untouched.

**Tech Stack:** Python 3 / FastAPI / pytest (backend), matplotlib (charts), vanilla JS (frontend). No new dependencies.

**Spec:** [`docs/superpowers/specs/2026-06-09-mediapipe-emotion-track-design.md`](../specs/2026-06-09-mediapipe-emotion-track-design.md)

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `frontend/config.js` | List of blendshapes forwarded to backend | Add 8 emotion-relevant blendshapes |
| `backend/analysis.py` | Metric computation from frames | Add `EMOTION_WEIGHTS` + `emotion_from_blendshapes()` and helpers |
| `backend/main.py` | `/api/session` endpoint | Compute `emotion_mediapipe`, return 2nd chart URL |
| `backend/report.py` | Chart/file generation | Render `emotion_mediapipe.png` |
| `frontend/app.js` | Report rendering | DRY emotion-card helper + render MediaPipe card |
| `frontend/index.html` | Report markup | Add MediaPipe emotion card |
| `tests/test_analysis.py` | Mapping unit tests | New tests |
| `tests/test_emotion.py` | Session integration tests | New test |
| `tests/test_report.py` | Chart file tests | New test |
| `docs/features/mediapipe-limitations.md`, `mediapipe-vs-deepface.md` | Capability docs | Reframe emotion claims |

No CSS change: the new card reuses the existing `card-emotion-section` class.

---

## Task 1: Forward emotion-relevant blendshapes (frontend config)

The backend only receives the blendshapes listed in `CONFIG.BLENDSHAPES` ([`frontend/app.js:110-112`](../../../frontend/app.js) filters by this list). The mapping needs `cheekSquint`, `mouthUpperUp`, `eyeWide`, `mouthStretch`, which aren't forwarded yet.

**Files:**
- Modify: `frontend/config.js:13-19`

- [ ] **Step 1: Add the 8 blendshapes to the forwarded list**

In `frontend/config.js`, change the `BLENDSHAPES` array to append the new names. Replace the existing array (lines 13-19) with:

```js
  BLENDSHAPES: ["mouthSmileLeft", "mouthSmileRight", "eyeBlinkLeft", "eyeBlinkRight", "browInnerUp",
    "eyeLookInLeft", "eyeLookInRight", "eyeLookOutLeft", "eyeLookOutRight",
    "eyeLookUpLeft", "eyeLookUpRight", "eyeLookDownLeft", "eyeLookDownRight",
    "jawOpen", "browOuterUpLeft", "browOuterUpRight",
    "eyeSquintLeft", "eyeSquintRight", "mouthPressLeft", "mouthPressRight",
    "browDownLeft", "browDownRight", "jawLeft", "jawRight",
    "noseSneerLeft", "noseSneerRight", "mouthFrownLeft", "mouthFrownRight",
    // emotion-relevant (added for the MediaPipe emotion track)
    "cheekSquintLeft", "cheekSquintRight", "mouthUpperUpLeft", "mouthUpperUpRight",
    "eyeWideLeft", "eyeWideRight", "mouthStretchLeft", "mouthStretchRight"],
```

- [ ] **Step 2: Verify the file still parses**

Run: `node --check frontend/config.js`
Expected: no output, exit code 0. (If `node` is unavailable, visually confirm the array is valid JS with balanced brackets.)

- [ ] **Step 3: Commit**

```bash
git add frontend/config.js
git commit -m "feat: forward emotion-relevant blendshapes for MediaPipe emotion track"
```

---

## Task 2: Blendshape → emotion mapping (`emotion_from_blendshapes`)

**Files:**
- Modify: `backend/analysis.py` (add import near top; add functions after `composite_scores`)
- Test: `tests/test_analysis.py`

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_analysis.py`:

```python
from backend.analysis import emotion_from_blendshapes, EMOTION_CLASSES

def _ef(t=0.0, turn=0, **bs):
    """A face frame carrying only the given blendshape values."""
    return {"t": t, "turn": turn, "face": True, "bs": dict(bs)}

def test_emotion_blendshapes_happy():
    out = emotion_from_blendshapes([_ef(mouthSmileLeft=0.9, mouthSmileRight=0.9,
                                        cheekSquintLeft=0.7, cheekSquintRight=0.7)])
    assert out["available"] is True
    assert out["dominant"] == "happy"

def test_emotion_blendshapes_angry():
    out = emotion_from_blendshapes([_ef(browDownLeft=0.9, browDownRight=0.9,
                                        mouthPressLeft=0.6, mouthPressRight=0.6,
                                        eyeSquintLeft=0.5, eyeSquintRight=0.5)])
    assert out["dominant"] == "angry"

def test_emotion_blendshapes_surprise():
    out = emotion_from_blendshapes([_ef(browInnerUp=0.8, browOuterUpLeft=0.8,
                                        browOuterUpRight=0.8, eyeWideLeft=0.8,
                                        eyeWideRight=0.8, jawOpen=0.7)])
    assert out["dominant"] == "surprise"

def test_emotion_blendshapes_fear_beats_surprise_with_browdown_and_stretch():
    out = emotion_from_blendshapes([_ef(browInnerUp=0.7, browOuterUpLeft=0.7,
                                        browOuterUpRight=0.7, browDownLeft=0.8,
                                        browDownRight=0.8, eyeWideLeft=0.7, eyeWideRight=0.7,
                                        mouthStretchLeft=0.8, mouthStretchRight=0.8, jawOpen=0.5)])
    assert out["dominant"] == "fear"

def test_emotion_blendshapes_disgust():
    out = emotion_from_blendshapes([_ef(noseSneerLeft=0.9, noseSneerRight=0.9,
                                        mouthUpperUpLeft=0.8, mouthUpperUpRight=0.8)])
    assert out["dominant"] == "disgust"

def test_emotion_blendshapes_neutral_when_flat():
    out = emotion_from_blendshapes([_ef(mouthSmileLeft=0.0, browDownLeft=0.0)])
    assert out["dominant"] == "neutral"

def test_emotion_blendshapes_empty_or_no_face_is_unavailable():
    assert emotion_from_blendshapes([]) == {"available": False}
    assert emotion_from_blendshapes([{"t": 0.0, "turn": 0, "face": False}]) == {"available": False}

def test_emotion_blendshapes_tolerates_missing_keys():
    out = emotion_from_blendshapes([_ef()])  # empty bs dict
    assert out["available"] is True
    assert out["dominant"] == "neutral"
    dist = out["overall_distribution"]
    assert set(dist) == set(EMOTION_CLASSES)
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pytest tests/test_analysis.py -k emotion_blendshapes -v`
Expected: FAIL — `ImportError: cannot import name 'emotion_from_blendshapes'` (and `EMOTION_CLASSES`).

- [ ] **Step 3: Add the import near the top of `backend/analysis.py`**

After line 4 (`from typing import Sequence`), add:

```python
from backend.emotion import aggregate_emotions, EMOTION_CLASSES
```

(No circular import: `backend/emotion.py` imports nothing from `analysis`.)

- [ ] **Step 4: Add the mapping implementation**

In `backend/analysis.py`, immediately after the `composite_scores` function (ends at line 312, before `CONCERN_OBJECTS`), add:

```python
# --- Blendshape-derived emotion (heuristic EMFACS mapping) ---
# MediaPipe blendshapes are ARKit-style Action Unit proxies. Each emotion is the
# weighted sum of its diagnostic AUs (Ekman/EMFACS). Weights are tunable, like the
# threshold block at the top of this file. Neutral is derived from low overall
# activation, not weighted. This is an INFERENCE shown beside DeepFace, never
# ground truth — see docs/features/mediapipe-limitations.md.
EMOTION_WEIGHTS = {
    "happy":    {"mouthSmile": 1.0, "cheekSquint": 0.6},
    "sad":      {"mouthFrown": 1.0, "browInnerUp": 0.6, "browDown": 0.3},
    "angry":    {"browDown": 1.0, "mouthPress": 0.6, "eyeSquint": 0.5},
    "surprise": {"browInnerUp": 0.7, "browOuterUp": 0.7, "eyeWide": 0.8, "jawOpen": 0.6},
    "fear":     {"browInnerUp": 0.6, "browOuterUp": 0.6, "browDown": 0.5,
                 "eyeWide": 0.7, "mouthStretch": 0.7, "jawOpen": 0.4},
    "disgust":  {"noseSneer": 1.0, "mouthUpperUp": 0.8},
}
NEUTRAL_BASE = 0.15  # neutral floor; expressive activation eats into it


def _bs_avg(bs: dict, name: str) -> float:
    """Read a blendshape, averaging Left/Right variants when present, else the bare key."""
    left, right = bs.get(name + "Left"), bs.get(name + "Right")
    if left is not None or right is not None:
        return ((left or 0.0) + (right or 0.0)) / 2.0
    return bs.get(name, 0.0)


def _frame_emotion_scores(bs: dict) -> dict:
    """7-class 0-100 distribution for one frame's blendshapes."""
    raw = {emo: sum(w * _bs_avg(bs, name) for name, w in weights.items())
           for emo, weights in EMOTION_WEIGHTS.items()}
    raw["neutral"] = max(0.0, NEUTRAL_BASE - max(raw.values(), default=0.0))
    total = sum(raw.values())
    if total <= 0:
        return {c: (100.0 if c == "neutral" else 0.0) for c in EMOTION_CLASSES}
    return {c: round(100.0 * raw.get(c, 0.0) / total, 1) for c in EMOTION_CLASSES}


def emotion_from_blendshapes(frames: list[dict]) -> dict:
    """Heuristic emotion track derived from MediaPipe blendshapes (no pixels).

    Emits the same shape as the DeepFace track (via aggregate_emotions) so the two
    render side by side. Returns {"available": False} when no usable face frames exist.
    """
    shots = []
    for f in frames:
        if not f.get("face", False) or "bs" not in f:
            continue
        scores = _frame_emotion_scores(f["bs"])
        shots.append({"t": f.get("t", 0.0), "turn": f.get("turn", -1),
                      "dominant": max(scores, key=scores.get), "scores": scores})
    return aggregate_emotions(shots)
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pytest tests/test_analysis.py -k emotion_blendshapes -v`
Expected: PASS (8 tests).

- [ ] **Step 6: Commit**

```bash
git add backend/analysis.py tests/test_analysis.py
git commit -m "feat: blendshape-derived emotion mapping (heuristic EMFACS)"
```

---

## Task 3: Wire the track into `/api/session`

**Files:**
- Modify: `backend/main.py:14` (import), `:114-139` (`session` handler)
- Test: `tests/test_emotion.py`

- [ ] **Step 1: Write the failing test**

Append to `tests/test_emotion.py`:

```python
def test_session_includes_mediapipe_emotion(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)  # skip coaching

    def happy_frame(t):
        return {"t": t, "turn": 0, "face": True,
                "bs": {"mouthSmileLeft": 0.9, "mouthSmileRight": 0.9,
                       "cheekSquintLeft": 0.7, "cheekSquintRight": 0.7},
                "m": [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]}

    body = {"role": "Software Engineer",
            "frames": [happy_frame(i * 100.0) for i in range(5)],
            "transcript": {"full_text": "", "segments": [
                {"speaker": "interviewer", "text": "hi", "t": 0}]}}
    data = _client.post("/api/session", json=body).json()

    mp = data["summary"]["emotion_mediapipe"]
    assert mp["available"] is True
    assert mp["dominant"] == "happy"
    assert data["emotion_mediapipe_chart_url"].endswith("emotion_mediapipe.png")
    # DeepFace track is independent and absent (no crops sent here)
    assert data["summary"]["emotion"] == {"available": False}
    assert data["emotion_chart_url"] is None
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pytest tests/test_emotion.py::test_session_includes_mediapipe_emotion -v`
Expected: FAIL — `KeyError: 'emotion_mediapipe'` (key not in summary).

- [ ] **Step 3: Add the import**

In `backend/main.py`, change line 14 from:

```python
from backend.analysis import compute_metrics, questions_from_transcript, transcript_metrics, integrity_metrics, summarize_actions
```

to:

```python
from backend.analysis import compute_metrics, questions_from_transcript, transcript_metrics, integrity_metrics, summarize_actions, emotion_from_blendshapes
```

- [ ] **Step 4: Compute the MediaPipe track**

In `backend/main.py`, after line 123 (`summary["emotion"] = req.emotion if ...`), add:

```python
    summary["emotion_mediapipe"] = emotion_from_blendshapes(req.frames)
```

- [ ] **Step 5: Return the second chart URL**

In `backend/main.py`, replace the return block (lines 135-139) with:

```python
    emotion_chart_url = (f"/sessions/{session_id}/emotion.png"
                         if summary["emotion"].get("available") else None)
    emotion_mp_chart_url = (f"/sessions/{session_id}/emotion_mediapipe.png"
                            if summary["emotion_mediapipe"].get("available") else None)
    return {"session_id": session_id, "summary": summary, "coaching": coaching,
            "charts_url": f"/sessions/{session_id}/charts.png",
            "emotion_chart_url": emotion_chart_url,
            "emotion_mediapipe_chart_url": emotion_mp_chart_url}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `pytest tests/test_emotion.py::test_session_includes_mediapipe_emotion -v`
Expected: PASS.

- [ ] **Step 7: Run the existing session tests to confirm no regression**

Run: `pytest tests/test_emotion.py -k session -v`
Expected: PASS (existing `test_session_includes_emotion_and_chart_url` and `test_session_emotion_absent_is_unavailable` still pass — the new key is additive).

- [ ] **Step 8: Commit**

```bash
git add backend/main.py tests/test_emotion.py
git commit -m "feat: expose MediaPipe emotion track in /api/session"
```

---

## Task 4: Render the second emotion chart

**Files:**
- Modify: `backend/report.py:122-140` (`save_session`)
- Test: `tests/test_report.py`

- [ ] **Step 1: Write the failing test**

Append to `tests/test_report.py` (reuses the existing `_frame` and `_emotion_summary` helpers in that file):

```python
def test_save_session_writes_mediapipe_emotion_png(tmp_path):
    frames = [_frame(i * 100.0) for i in range(5)]
    summary = {"duration_sec": 0.5, "frame_count": 5, "no_face_pct": 0.0,
               "overall": {}, "per_question": [],
               "emotion_mediapipe": _emotion_summary()}
    d = str(tmp_path / "smp")
    save_session(d, frames, {"full_text": "", "segments": []}, summary, None)
    assert os.path.exists(os.path.join(d, "emotion_mediapipe.png"))

def test_save_session_skips_mediapipe_emotion_png_when_unavailable(tmp_path):
    frames = [_frame(i * 100.0) for i in range(5)]
    summary = {"duration_sec": 0.5, "frame_count": 5, "no_face_pct": 0.0,
               "overall": {}, "per_question": [],
               "emotion_mediapipe": {"available": False}}
    d = str(tmp_path / "smp2")
    save_session(d, frames, {"full_text": "", "segments": []}, summary, None)
    assert not os.path.exists(os.path.join(d, "emotion_mediapipe.png"))
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pytest tests/test_report.py -k mediapipe_emotion_png -v`
Expected: FAIL — `emotion_mediapipe.png` is not created.

- [ ] **Step 3: Render the chart**

In `backend/report.py`, at the end of `save_session` (after line 140, the existing DeepFace `logging.warning(...)` line), add:

```python
    emotion_mp = summary.get("emotion_mediapipe") or {}
    if emotion_mp.get("available"):
        try:
            _build_emotion_chart(os.path.join(session_dir, "emotion_mediapipe.png"), emotion_mp)
        except Exception as exc:  # a malformed payload must not lose the session
            logging.warning("mediapipe emotion chart skipped: %s", exc)
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pytest tests/test_report.py -k mediapipe_emotion_png -v`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/report.py tests/test_report.py
git commit -m "feat: render emotion_mediapipe.png chart in report"
```

---

## Task 5: Render the MediaPipe emotion card (frontend)

No JS test harness exists; verification is `node --check` plus manual inspection.

**Files:**
- Modify: `frontend/index.html:215` (add card after the DeepFace card)
- Modify: `frontend/app.js` (DRY the emotion-card rendering, add MediaPipe card)

- [ ] **Step 1: Add the MediaPipe card markup**

In `frontend/index.html`, after line 215 (the closing `</div>` of the DeepFace `card-emotion-section`) and before line 217 (`<!-- 5. Coaching -->`), insert:

```html
        <!-- 4c. Emotion (MediaPipe, blendshape-derived) -->
        <div class="card card-emotion-section">
          <h2 class="card-title">Emotion (MediaPipe)</h2>
          <ul id="card-emotion-mp" class="card-list"></ul>
          <p class="disclaimer">Inferred from face-shape coefficients — no images leave your device.</p>
          <div class="chart-holder chart-holder-big">
            <img id="emotion-mp-img" alt="MediaPipe emotion over time chart" style="display:none" />
          </div>
        </div>
```

- [ ] **Step 2: Add a DRY emotion-card helper in `app.js`**

In `frontend/app.js`, after the `fillList` function (ends at line 325), add:

```js
function renderEmotionCard(emo, listId, imgId, chartUrl) {
  const img = $(imgId);
  if (emo && emo.available) {
    const dist = Object.entries(emo.overall_distribution || {})
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k} ${v}%`).join(" · ");
    const lines = [`Dominant emotion: ${emo.dominant || "—"}`];
    if (dist) lines.push(`Distribution: ${dist}`);
    fillList(listId, lines);
    if (img && chartUrl) { img.src = chartUrl; img.style.display = ""; }
  } else {
    fillList(listId, ["Emotion analysis not available"]);
    if (img) img.style.display = "none";
  }
}
```

- [ ] **Step 3: Replace the inline emotion rendering with two helper calls**

In `frontend/app.js`, replace the existing DeepFace emotion block (lines 427-439, from `const emoImg = $("emotion-img");` through the closing `}` of its `else` branch) with:

```js
  renderEmotionCard(emo, "card-emotion", "emotion-img", data.emotion_chart_url);
  const emoMp = s.emotion_mediapipe || { available: false };
  renderEmotionCard(emoMp, "card-emotion-mp", "emotion-mp-img", data.emotion_mediapipe_chart_url);
```

(`emo` and `s` are already defined at the top of `renderResults` — lines 328-329.)

- [ ] **Step 4: Syntax-check both files**

Run: `node --check frontend/app.js`
Expected: no output, exit code 0.

Then confirm the HTML has the new ids:

Run: `grep -c "card-emotion-mp\|emotion-mp-img" frontend/index.html`
Expected: `2`

- [ ] **Step 5: Manual verification (note for the executor)**

Start the app (`uvicorn backend.main:app --reload`), complete a short interview, and confirm the results screen shows two emotion cards: **Emotion (DeepFace)** and **Emotion (MediaPipe)**, the MediaPipe one populated even when DeepFace is off. (This step is manual — there is no automated frontend test.)

- [ ] **Step 6: Commit**

```bash
git add frontend/index.html frontend/app.js
git commit -m "feat: side-by-side MediaPipe emotion card in report UI"
```

---

## Task 6: Reframe the capability docs

These docs currently state MediaPipe **cannot** produce labeled emotion. Reframe to: no *native* classifier, but a clearly-labeled *heuristic* track shown beside DeepFace.

**Files:**
- Modify: `docs/features/mediapipe-vs-deepface.md:40`
- Modify: `docs/features/mediapipe-limitations.md:19`

- [ ] **Step 1: Update the comparison table row**

In `docs/features/mediapipe-vs-deepface.md`, replace the "Labeled basic emotions" row (line 40):

```markdown
| Labeled basic emotions | ❌ blendshapes only | ✅ 7 classes: angry, disgust, fear, happy, sad, surprise, neutral | DeepFace has **no "contempt"** (wish-list asks 8; FER-2013 model has 7) |
```

with:

```markdown
| Labeled basic emotions | ⚠️ heuristic EMFACS mapping from blendshapes (added — same 7 classes, shown beside DeepFace) | ✅ 7 classes: angry, disgust, fear, happy, sad, surprise, neutral | MediaPipe has no *native* classifier; our mapping is an inference (see `backend/analysis.py:emotion_from_blendshapes`). DeepFace has **no "contempt"** (FER-2013 has 7) |
```

- [ ] **Step 2: Update the limitations entry**

In `docs/features/mediapipe-limitations.md`, replace the "Labeled basic emotions" row (line 19):

```markdown
| Labeled basic emotions (happy/sad/angry/surprised/fearful/disgusted/neutral/contempt) | MediaPipe ships **no** emotion classifier — only blendshape *coefficients*. A custom classifier could be trained on blendshape vectors via **MediaPipe Model Maker**, but it is not available out of the box, and emotion-from-face is accuracy/bias-prone and legally restricted in hiring. | Show raw expression signals: smile intensity, eyebrow raise, mouth/eye openness. |
```

with:

```markdown
| Labeled basic emotions (happy/sad/angry/surprised/fearful/disgusted/neutral/contempt) | MediaPipe ships **no native** emotion classifier — only blendshape *coefficients*. We add a **heuristic EMFACS mapping** (`backend/analysis.py:emotion_from_blendshapes`) that infers the 7 classes from those coefficients, shown **beside** the DeepFace track for comparison. It is an inference (accuracy/bias-prone, legally restricted in hiring), labeled as supplementary and **never used for scoring**. | Raw expression signals (smile intensity, eyebrow raise, mouth/eye openness) **plus** the labeled heuristic track, both transparent. |
```

- [ ] **Step 3: Commit**

```bash
git add docs/features/mediapipe-vs-deepface.md docs/features/mediapipe-limitations.md
git commit -m "docs: reframe MediaPipe emotion as added heuristic track beside DeepFace"
```

---

## Task 7: Full verification

- [ ] **Step 1: Run the entire backend test suite**

Run: `pytest -q`
Expected: all tests pass (including the new mapping, session, and report tests, and all pre-existing tests).

- [ ] **Step 2: Syntax-check frontend**

Run: `node --check frontend/app.js && node --check frontend/config.js`
Expected: no output, exit code 0 for both.

- [ ] **Step 3: Final manual smoke test**

Start the app, run a short interview, and confirm both emotion cards render and the `sessions/<id>/` directory contains `emotion_mediapipe.png` (and `emotion.png` only if DeepFace was enabled).

---

## Notes on Tuning (for the executor)

`EMOTION_WEIGHTS`, `NEUTRAL_BASE`, and the per-frame normalization are intentionally simple and tunable. The initial weights are a reasonable EMFACS starting point, not calibrated values. If neutral dominates too readily (or too rarely) on real sessions, adjust `NEUTRAL_BASE`. Fear vs surprise and disgust are the least reliable classes by design — do not treat any label as ground truth.
