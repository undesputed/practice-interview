# Broader FACS Facial Analysis Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Broaden the MediaPipe+FACS emotion model — more Action Units (AU8/14/16/17, completed disgust/sadness prototypes), Contempt (8th emotion), a per-AU breakdown with FACS intensity on the report, and compound emotions.

**Architecture:** Widen the AU map (now AU→list-of-blendshape-keys) shared between [backend/analysis.py](../../../backend/analysis.py) (report) and [frontend/emotion.js](../../../frontend/emotion.js) (live tile), capturing new blendshapes via [config.js](../../../frontend/config.js). Contempt is a side-aware (asymmetric) score added to both. Per-AU breakdown + compound emotions are report-only (backend aggregation + [report.js](../../../frontend/screens/report.js)).

**Tech Stack:** FastAPI + pytest (backend), vanilla ES modules (frontend, no JS test runner). MediaPipe blendshapes.

Spec: [docs/superpowers/specs/2026-06-16-broader-facs-facial-analysis-design.md](2026-06-16-broader-facs-facial-analysis-design.md)

> **Honest limits (from research):** MediaPipe has no blendshape for **AU23** (a core anger AU) or AU11/13/38/39; `cheekPuff`/`tongueOut` are buggy. So this broadens coverage but stays a heuristic, not a clinical coder.

---

## File Structure

- **Modify** `frontend/config.js` — add 6 blendshape keys to `CONFIG.BLENDSHAPES`.
- **Modify** `backend/analysis.py` — AU key-list map + AU8/14/16/17; completed prototypes; contempt; `action_units()`; `compound_emotion()`.
- **Modify** `backend/emotion.py` — `aggregate_emotions(shots, classes=...)` parameterized so the MediaPipe track can include `contempt` without affecting the HSEmotion track.
- **Modify** `frontend/emotion.js` — mirror the AU key-list map + AU8/14/16/17 + completed prototypes + contempt (parity).
- **Modify** `backend/main.py` — store `summary["action_units"]` + `summary["emotion_compound"]`.
- **Modify** `frontend/screens/report.js` — Action Units card + compound label + extended caveat.
- **Create** `tests/test_facs.py` — AU mapping, contempt, action-units, compound.

---

## Task 1: Phase 1 — widen the AU map (backend, TDD)

**Files:**
- Modify: `backend/analysis.py`
- Test: `tests/test_facs.py`

- [ ] **Step 1: Write failing tests**

Create `tests/test_facs.py`:
```python
# tests/test_facs.py
"""Tests for the broadened FACS emotion model."""
from backend import analysis


def test_au_value_averages_present_keys_and_single():
    bs = {"mouthDimpleLeft": 0.4, "mouthDimpleRight": 0.6, "mouthClose": 0.5}
    assert analysis._au_value(bs, ["mouthDimpleLeft", "mouthDimpleRight"]) == 0.5
    assert analysis._au_value(bs, ["mouthClose"]) == 0.5
    assert analysis._au_value(bs, ["mouthShrugUpper", "mouthShrugLower"]) == 0.0  # absent -> 0


def test_au_map_includes_new_aus():
    for au in ("AU8", "AU14", "AU16", "AU17"):
        assert au in analysis._AU


def test_disgust_and_sadness_prototypes_completed():
    assert "AU16" in analysis._PROTOTYPES["disgust"]
    assert "AU17" in analysis._PROTOTYPES["sad"]


def test_disgust_uses_lower_lip_au16():
    # A disgust face (nose wrinkle AU9 + upper-lip AU10 + lower-lip-down AU16 + frown AU15)
    bs = {"noseSneerLeft": 0.7, "noseSneerRight": 0.7, "mouthUpperUpLeft": 0.5,
          "mouthUpperUpRight": 0.5, "mouthLowerDownLeft": 0.5, "mouthLowerDownRight": 0.5,
          "mouthFrownLeft": 0.4, "mouthFrownRight": 0.4}
    scores = analysis._frame_emotion_scores(bs)
    assert max(scores, key=scores.get) == "disgust"
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd /Users/carrieyu/Desktop/Hipe/mediapipe-test && python -m pytest tests/test_facs.py -q`
Expected: FAIL (`_au_value` missing, AU8/14/16/17 not in `_AU`).

- [ ] **Step 3: Refactor the AU map to key-lists + add AU8/14/16/17 + complete prototypes**

In `backend/analysis.py`, replace the `_AU` dict and `_PROTOTYPES` dict:
```python
# FACS Action Unit -> the MediaPipe blendshape key(s) that drive it (averaged).
_AU = {
    "AU1": ["browInnerUp"],
    "AU2": ["browOuterUpLeft", "browOuterUpRight"],
    "AU4": ["browDownLeft", "browDownRight"],
    "AU5": ["eyeWideLeft", "eyeWideRight"],
    "AU6": ["cheekSquintLeft", "cheekSquintRight"],
    "AU7": ["eyeSquintLeft", "eyeSquintRight"],
    "AU8": ["mouthClose"],
    "AU9": ["noseSneerLeft", "noseSneerRight"],
    "AU10": ["mouthUpperUpLeft", "mouthUpperUpRight"],
    "AU12": ["mouthSmileLeft", "mouthSmileRight"],
    "AU14": ["mouthDimpleLeft", "mouthDimpleRight"],
    "AU15": ["mouthFrownLeft", "mouthFrownRight"],
    "AU16": ["mouthLowerDownLeft", "mouthLowerDownRight"],
    "AU17": ["mouthShrugUpper", "mouthShrugLower"],
    "AU20": ["mouthStretchLeft", "mouthStretchRight"],
    "AU23": ["mouthPressLeft", "mouthPressRight"],   # ARKit has no true AU23; mouthPress is the proxy
    "AU26": ["jawOpen"],
}
# Human-readable AU names (for the per-AU breakdown on the report).
_AU_NAMES = {
    "AU1": "Inner brow raiser", "AU2": "Outer brow raiser", "AU4": "Brow lowerer",
    "AU5": "Upper lid raiser", "AU6": "Cheek raiser", "AU7": "Lid tightener",
    "AU8": "Lips toward each other", "AU9": "Nose wrinkler", "AU10": "Upper lip raiser",
    "AU12": "Lip corner puller", "AU14": "Dimpler", "AU15": "Lip corner depressor",
    "AU16": "Lower lip depressor", "AU17": "Chin raiser", "AU20": "Lip stretcher",
    "AU23": "Lip presser", "AU26": "Jaw drop",
}
# EMFACS emotion prototypes: an emotion's match = the MEAN activation of these AUs.
_PROTOTYPES = {
    "happy":    ["AU6", "AU12"],
    "sad":      ["AU1", "AU4", "AU15", "AU17"],
    "surprise": ["AU1", "AU2", "AU5", "AU26"],
    "fear":     ["AU1", "AU2", "AU4", "AU5", "AU7", "AU20", "AU26"],
    "angry":    ["AU4", "AU5", "AU7", "AU23"],
    "disgust":  ["AU9", "AU10", "AU15", "AU16"],
}
```

Add `_au_value` (keep the old `_bs_avg` for any existing callers/tests) right after `_bs_avg`:
```python
def _au_value(bs: dict, keys: list) -> float:
    """Average the blendshape keys present for an AU (missing keys are skipped, so a
    one-sided value counts at full strength). Returns 0.0 when none are present."""
    vals = [bs[k] for k in keys if bs.get(k) is not None]
    return sum(vals) / len(vals) if vals else 0.0
```

Change `_frame_emotion_scores` to build `au` via the key-lists:
```python
    au = {name: _au_value(bs, keys) for name, keys in _AU.items()}
```

- [ ] **Step 4: Run the new + existing emotion tests**

Run: `cd /Users/carrieyu/Desktop/Hipe/mediapipe-test && python -m pytest tests/test_facs.py tests/test_emotion.py -q`
Expected: the 4 new tests pass; the existing emotion tests still pass. (If an existing test referenced `_bs_avg` directly, it still works — `_bs_avg` is unchanged.)

- [ ] **Step 5: Commit**

```bash
git add backend/analysis.py tests/test_facs.py
git commit -m "feat(facs): widen AU map (key-lists, AU8/14/16/17) + complete disgust/sadness prototypes"
```

---

## Task 2: Phase 1 — capture new blendshapes + frontend parity

**Files:**
- Modify: `frontend/config.js`
- Modify: `frontend/emotion.js`

- [ ] **Step 1: Add the new blendshape keys to `frontend/config.js`**

In `CONFIG.BLENDSHAPES`, change the final line:
```javascript
    "cheekSquintLeft", "cheekSquintRight", "mouthUpperUpLeft", "mouthUpperUpRight",
    "eyeWideLeft", "eyeWideRight", "mouthStretchLeft", "mouthStretchRight"],
```
to (append the 6 new keys):
```javascript
    "cheekSquintLeft", "cheekSquintRight", "mouthUpperUpLeft", "mouthUpperUpRight",
    "eyeWideLeft", "eyeWideRight", "mouthStretchLeft", "mouthStretchRight",
    // broadened FACS: AU8 close, AU14 dimple, AU16 lower-lip, AU17 chin
    "mouthClose", "mouthDimpleLeft", "mouthDimpleRight",
    "mouthLowerDownLeft", "mouthLowerDownRight", "mouthShrugUpper", "mouthShrugLower"],
```

- [ ] **Step 2: Mirror the AU key-list map + prototypes in `frontend/emotion.js`**

Replace the `AU` and `PROTOTYPES` consts and the `bsAvg` usage. Change:
```javascript
const AU = {
  AU1: 'browInnerUp', AU2: 'browOuterUp', AU4: 'browDown', AU5: 'eyeWide',
  AU6: 'cheekSquint', AU7: 'eyeSquint', AU9: 'noseSneer', AU10: 'mouthUpperUp',
  AU12: 'mouthSmile', AU15: 'mouthFrown', AU20: 'mouthStretch', AU23: 'mouthPress', AU26: 'jawOpen',
};
const PROTOTYPES = {
  happy:    ['AU6', 'AU12'],
  sad:      ['AU1', 'AU4', 'AU15'],
  surprise: ['AU1', 'AU2', 'AU5', 'AU26'],
  fear:     ['AU1', 'AU2', 'AU4', 'AU5', 'AU7', 'AU20', 'AU26'],
  angry:    ['AU4', 'AU5', 'AU7', 'AU23'],
  disgust:  ['AU9', 'AU10', 'AU15'],
};
```
to:
```javascript
// FACS Action Unit -> MediaPipe blendshape key(s) (averaged). KEEP IN SYNC with analysis.py _AU.
const AU = {
  AU1: ['browInnerUp'], AU2: ['browOuterUpLeft', 'browOuterUpRight'],
  AU4: ['browDownLeft', 'browDownRight'], AU5: ['eyeWideLeft', 'eyeWideRight'],
  AU6: ['cheekSquintLeft', 'cheekSquintRight'], AU7: ['eyeSquintLeft', 'eyeSquintRight'],
  AU8: ['mouthClose'], AU9: ['noseSneerLeft', 'noseSneerRight'],
  AU10: ['mouthUpperUpLeft', 'mouthUpperUpRight'], AU12: ['mouthSmileLeft', 'mouthSmileRight'],
  AU14: ['mouthDimpleLeft', 'mouthDimpleRight'], AU15: ['mouthFrownLeft', 'mouthFrownRight'],
  AU16: ['mouthLowerDownLeft', 'mouthLowerDownRight'], AU17: ['mouthShrugUpper', 'mouthShrugLower'],
  AU20: ['mouthStretchLeft', 'mouthStretchRight'], AU23: ['mouthPressLeft', 'mouthPressRight'],
  AU26: ['jawOpen'],
};
const PROTOTYPES = {
  happy:    ['AU6', 'AU12'],
  sad:      ['AU1', 'AU4', 'AU15', 'AU17'],
  surprise: ['AU1', 'AU2', 'AU5', 'AU26'],
  fear:     ['AU1', 'AU2', 'AU4', 'AU5', 'AU7', 'AU20', 'AU26'],
  angry:    ['AU4', 'AU5', 'AU7', 'AU23'],
  disgust:  ['AU9', 'AU10', 'AU15', 'AU16'],
};
```
Replace the `bsAvg` function with an `auValue` that averages a key list:
```javascript
// Average the blendshape keys present for an AU (missing skipped). KEEP IN SYNC with analysis.py _au_value.
function auValue(bs, keys){
  const vals = [];
  for (const k of keys){ if (bs[k] != null) vals.push(bs[k]); }
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
}
```
And in `emotionScores`, change `for (const k in AU) au[k] = bsAvg(bs, AU[k]);` to:
```javascript
  for (const k in AU) au[k] = auValue(bs, AU[k]);
```

- [ ] **Step 3: Verify both parse**

Run: `cd /Users/carrieyu/Desktop/Hipe/mediapipe-test && node --input-type=module --check < frontend/config.js && node --input-type=module --check < frontend/emotion.js && echo SYNTAX_OK`
Expected: `SYNTAX_OK`

- [ ] **Step 4: Commit**

```bash
git add frontend/config.js frontend/emotion.js
git commit -m "feat(facs): capture new blendshapes + mirror widened AU map in the live tile"
```

---

## Task 3: Phase 2 — Contempt (8th emotion, backend + frontend, TDD)

**Files:**
- Modify: `backend/emotion.py`, `backend/analysis.py`, `frontend/emotion.js`
- Test: `tests/test_facs.py`

- [ ] **Step 1: Write failing contempt tests**

Append to `tests/test_facs.py`:
```python
def test_contempt_on_asymmetric_smile_with_dimple():
    bs = {"mouthSmileLeft": 0.7, "mouthSmileRight": 0.05,
          "mouthDimpleLeft": 0.5, "mouthDimpleRight": 0.0}
    scores = analysis._frame_emotion_scores(bs)
    assert "contempt" in scores
    assert max(scores, key=scores.get) == "contempt"


def test_symmetric_smile_is_not_contempt():
    bs = {"mouthSmileLeft": 0.7, "mouthSmileRight": 0.7,
          "cheekSquintLeft": 0.4, "cheekSquintRight": 0.4}
    scores = analysis._frame_emotion_scores(bs)
    assert scores["contempt"] == 0.0
    assert max(scores, key=scores.get) == "happy"


def test_mediapipe_track_distribution_includes_contempt():
    frame = {"face": True, "t": 0.0, "turn": 0,
             "bs": {"mouthSmileLeft": 0.7, "mouthSmileRight": 0.05,
                    "mouthDimpleLeft": 0.5, "mouthDimpleRight": 0.0}}
    out = analysis.emotion_from_blendshapes([frame])
    assert out["available"] is True
    assert "contempt" in out["overall_distribution"]
```

Run `python -m pytest tests/test_facs.py -q` → the 3 new tests FAIL.

- [ ] **Step 2: Parameterize `aggregate_emotions` in `backend/emotion.py`**

Change the signature:
```python
def aggregate_emotions(shots: list[dict]) -> dict:
```
to:
```python
def aggregate_emotions(shots: list[dict], classes: list | None = None) -> dict:
```
At the top of the body (right after the docstring), add:
```python
    classes = classes or EMOTION_CLASSES
```
Then within the function, replace every use of `EMOTION_CLASSES` with `classes` (there are uses in `dom_counts`, `overall`, and the per-question `c`/`distribution`). Leave the module-level `EMOTION_CLASSES` constant as-is (the default).

- [ ] **Step 3: Add contempt to `backend/analysis.py`**

Add a contempt class list + scorer. After the `_PROTOTYPES` dict, add:
```python
from backend.emotion import EMOTION_CLASSES as _BASIC_CLASSES
# MediaPipe track adds Contempt (8th); the HSEmotion track keeps the basic 7.
_MP_CLASSES = list(_BASIC_CLASSES[:-1]) + ["contempt", "neutral"]  # keep neutral last
_CONTEMPT_SMILE_DELTA = 0.2   # min left/right smile asymmetry to consider contempt


def _contempt_score(bs: dict) -> float:
    """Contempt = a one-sided (asymmetric) smile plus a dimpler (AU14). A symmetric
    smile scores 0. Gated on the dimpler so an ordinary lopsided smile won't trigger."""
    sl = bs.get("mouthSmileLeft", 0.0) or 0.0
    sr = bs.get("mouthSmileRight", 0.0) or 0.0
    asym = abs(sl - sr)
    if asym < _CONTEMPT_SMILE_DELTA:
        return 0.0
    dimple = max(bs.get("mouthDimpleLeft", 0.0) or 0.0, bs.get("mouthDimpleRight", 0.0) or 0.0)
    return max(0.0, asym) * min(1.0, dimple / _GATE_T)
```
> `_BASIC_CLASSES` is `["angry","disgust","fear","happy","sad","surprise","neutral"]`, so `_MP_CLASSES` = those 6 + `contempt` + `neutral`.

In `_frame_emotion_scores`, add contempt into `raw` before the neutral/total step, and emit over `_MP_CLASSES`:
```python
    raw["contempt"] = _contempt_score(bs)
    raw["neutral"] = max(0.0, NEUTRAL_BASE - max(raw.values(), default=0.0))
    total = sum(raw.values())
    if total <= 0:
        return {c: (100.0 if c == "neutral" else 0.0) for c in _MP_CLASSES}
    return {c: round(100.0 * raw.get(c, 0.0) / total, 1) for c in _MP_CLASSES}
```
(The `raw["contempt"]` line goes right before the existing `raw["neutral"]` line; replace the two return lines' `EMOTION_CLASSES` with `_MP_CLASSES`.)

In `emotion_from_blendshapes`, pass the MP classes to the aggregator:
```python
    return aggregate_emotions(shots, classes=_MP_CLASSES)
```

- [ ] **Step 4: Mirror contempt in `frontend/emotion.js`**

Change the classes line:
```javascript
export const EMOTION_CLASSES = ['angry', 'disgust', 'fear', 'happy', 'sad', 'surprise', 'neutral'];
```
to:
```javascript
export const EMOTION_CLASSES = ['angry', 'disgust', 'fear', 'happy', 'sad', 'surprise', 'contempt', 'neutral'];
```
Add a contempt scorer + threshold near the consts:
```javascript
const CONTEMPT_SMILE_DELTA = 0.2;   // KEEP IN SYNC with analysis.py
function contemptScore(bs){
  const sl = bs['mouthSmileLeft'] || 0, sr = bs['mouthSmileRight'] || 0;
  const asym = Math.abs(sl - sr);
  if (asym < CONTEMPT_SMILE_DELTA) return 0;
  const dimple = Math.max(bs['mouthDimpleLeft'] || 0, bs['mouthDimpleRight'] || 0);
  return Math.max(0, asym) * Math.min(1, dimple / GATE_T);
}
```
In `emotionScores`, after the prototype loop (right before `raw.neutral = ...`), add:
```javascript
  raw.contempt = contemptScore(bs);
  if (raw.contempt > maxExpressive) maxExpressive = raw.contempt;
```

- [ ] **Step 5: Run tests + parse check**

Run: `cd /Users/carrieyu/Desktop/Hipe/mediapipe-test && python -m pytest tests/test_facs.py tests/test_emotion.py -q && node --input-type=module --check < frontend/emotion.js && echo OK`
Expected: all pass + `OK`. (Existing emotion tests still pass: the HSEmotion `aggregate_emotions` call uses the default 7-class list.)

- [ ] **Step 6: Commit**

```bash
git add backend/emotion.py backend/analysis.py frontend/emotion.js tests/test_facs.py
git commit -m "feat(facs): add Contempt (8th emotion) via asymmetric smile + dimpler"
```

---

## Task 4: Phase 3 — per-AU breakdown + intensity (TDD)

**Files:**
- Modify: `backend/analysis.py`, `backend/main.py`, `frontend/screens/report.js`
- Test: `tests/test_facs.py`

- [ ] **Step 1: Write failing tests**

Append to `tests/test_facs.py`:
```python
def test_action_units_breakdown_levels_and_floor():
    frames = [
        {"face": True, "bs": {"mouthSmileLeft": 0.9, "mouthSmileRight": 0.9}},   # AU12 strong
        {"face": True, "bs": {"mouthSmileLeft": 0.5, "mouthSmileRight": 0.5}},
    ]
    aus = analysis.action_units(frames)
    by = {a["au"]: a for a in aus}
    assert "AU12" in by
    assert by["AU12"]["peak"] == 0.9
    assert by["AU12"]["level"] == "E"           # 0.9 -> E
    assert by["AU12"]["name"] == "Lip corner puller"
    assert "AU4" not in by                        # never fired -> below floor, excluded


def test_action_units_empty_when_no_faces():
    assert analysis.action_units([{"face": False}]) == []
```

Run → FAIL (`action_units` missing).

- [ ] **Step 2: Implement `action_units` + `_au_level` in `backend/analysis.py`**

Add after `emotion_from_blendshapes`:
```python
_AU_FLOOR = 0.1   # below this peak, the AU never meaningfully fired


def _au_level(v: float) -> str:
    """FACS A-E intensity band for a 0-1 value."""
    if v < 0.2:
        return "A"
    if v < 0.4:
        return "B"
    if v < 0.6:
        return "C"
    if v < 0.8:
        return "D"
    return "E"


def action_units(frames: list[dict]) -> list:
    """Per-AU intensity across the interview: peak + mean (0-1) + FACS A-E band for the
    peak. AUs whose peak stays below the floor are omitted. Sorted by peak, descending."""
    series = {name: [] for name in _AU}
    for f in frames:
        if not f.get("face", False) or "bs" not in f:
            continue
        bs = f["bs"]
        for name, keys in _AU.items():
            series[name].append(_au_value(bs, keys))
    out = []
    for name, vals in series.items():
        if not vals:
            continue
        peak = max(vals)
        if peak < _AU_FLOOR:
            continue
        out.append({"au": name, "name": _AU_NAMES[name], "peak": round(peak, 3),
                    "mean": round(sum(vals) / len(vals), 3), "level": _au_level(peak)})
    out.sort(key=lambda a: a["peak"], reverse=True)
    return out
```

- [ ] **Step 3: Store it on the session in `backend/main.py`**

Add `action_units` to the analysis import line (the `from backend.analysis import ...`): add `action_units` to the imported names.
In `session()`, right after the line `summary["emotion_mediapipe"] = emotion_from_blendshapes(req.frames)`, add:
```python
    summary["action_units"] = action_units(req.frames)
```

- [ ] **Step 4: Render the Action Units card in `frontend/screens/report.js`**

Add a renderer after `emotionBars`:
```javascript
function actionUnitsCard(aus){
  if (!aus || !aus.length) return '<p class="muted" style="font-size:12px">No action units detected for this session.</p>';
  return aus.map((a) => '<div class="emrow"><span>' + esc(a.au + ' · ' + a.name) + '</span>' +
    '<span class="track"><span class="fill" style="width:' + Math.round(Math.max(0, Math.min(1, a.peak)) * 100) + '%"></span></span>' +
    '<span class="val">' + esc(a.level) + '</span></div>').join('');
}
```
In `view(s)`, after `const v = s.voice || { available: false };` (or near the other consts), add:
```javascript
  const aus = s.action_units || [];
```
Then add a chart-card. Insert immediately AFTER the `'<div class="chart-card"><div class="ct">Emotion (MediaPipe)</div>'...emotionBars(s.emotion_mediapipe) + '</div>' +` block:
```javascript
    '<div class="chart-card"><div class="ct">Action Units (FACS)</div>' +
      '<div class="cs">Which facial muscles fired and how strongly (FACS A–E). Approximate — derived from MediaPipe blendshapes, not clinical FACS coding.</div>' +
      actionUnitsCard(aus) + '</div>' +
```

- [ ] **Step 5: Run tests + parse check**

Run: `cd /Users/carrieyu/Desktop/Hipe/mediapipe-test && python -m pytest tests/test_facs.py -q && node --input-type=module --check < frontend/screens/report.js && echo OK`
Expected: all pass + `OK`.

- [ ] **Step 6: Commit**

```bash
git add backend/analysis.py backend/main.py frontend/screens/report.js tests/test_facs.py
git commit -m "feat(facs): per-AU breakdown + FACS intensity on the report"
```

---

## Task 5: Phase 4 — compound emotions (TDD)

**Files:**
- Modify: `backend/analysis.py`, `backend/main.py`, `frontend/screens/report.js`
- Test: `tests/test_facs.py`

- [ ] **Step 1: Write failing tests**

Append to `tests/test_facs.py`:
```python
def test_compound_happy_surprise():
    dist = {"happy": 45.0, "surprise": 30.0, "neutral": 25.0, "sad": 0.0,
            "fear": 0.0, "angry": 0.0, "disgust": 0.0, "contempt": 0.0}
    r = analysis.compound_emotion(dist)
    assert r["label"] == "Happily surprised"
    assert set(r["components"]) == {"happy", "surprise"}


def test_compound_none_when_one_dominates():
    dist = {"happy": 80.0, "surprise": 3.0, "neutral": 17.0}
    assert analysis.compound_emotion(dist)["label"] is None


def test_compound_none_for_unpaired():
    # happy + angry has no defined compound -> None
    dist = {"happy": 40.0, "angry": 35.0, "neutral": 25.0}
    assert analysis.compound_emotion(dist)["label"] is None
```

Run → FAIL (`compound_emotion` missing).

- [ ] **Step 2: Implement `compound_emotion` in `backend/analysis.py`**

Add after `action_units`:
```python
# Du, Tao & Martinez (PNAS 2014) compound emotions — unordered basic-emotion pairs.
_COMPOUND = {
    frozenset(["happy", "surprise"]):   "Happily surprised",
    frozenset(["happy", "disgust"]):    "Happily disgusted",
    frozenset(["sad", "fear"]):         "Sadly fearful",
    frozenset(["sad", "angry"]):        "Sadly angry",
    frozenset(["sad", "surprise"]):     "Sadly surprised",
    frozenset(["sad", "disgust"]):      "Sadly disgusted",
    frozenset(["fear", "angry"]):       "Fearfully angry",
    frozenset(["fear", "surprise"]):    "Fearfully surprised",
    frozenset(["fear", "disgust"]):     "Fearfully disgusted",
    frozenset(["angry", "surprise"]):   "Angrily surprised",
    frozenset(["angry", "disgust"]):    "Angrily disgusted",
    frozenset(["disgust", "surprise"]): "Disgustedly surprised",
}
_COMPOUND_MIN = 20.0   # the second emotion must reach this % of the distribution


def compound_emotion(distribution: dict) -> dict:
    """Label a compound emotion from the top two NON-neutral emotions, when both are
    clearly present and the pair has a defined compound. Else {"label": None}."""
    ranked = sorted(((c, v) for c, v in (distribution or {}).items() if c != "neutral"),
                    key=lambda kv: kv[1], reverse=True)
    if len(ranked) < 2:
        return {"label": None}
    (c1, v1), (c2, v2) = ranked[0], ranked[1]
    if v1 <= 0 or v2 < _COMPOUND_MIN:
        return {"label": None}
    label = _COMPOUND.get(frozenset([c1, c2]))
    if not label:
        return {"label": None}
    return {"label": label, "components": [c1, c2], "confidence": round(v2, 1)}
```

- [ ] **Step 3: Store it on the session in `backend/main.py`**

Add `compound_emotion` to the `from backend.analysis import ...` line. In `session()`, right after the `summary["action_units"] = ...` line (Task 4), add:
```python
    summary["emotion_compound"] = compound_emotion(
        summary["emotion_mediapipe"].get("overall_distribution", {}))
```

- [ ] **Step 4: Show the compound label in `frontend/screens/report.js`**

In `view(s)`, after `const aus = s.action_units || [];`, add:
```javascript
  const compound = (s.emotion_compound && s.emotion_compound.label) ? s.emotion_compound.label : null;
```
In the "Emotion (MediaPipe)" chart-card, change its `<div class="cs">...` line to append the compound when present. Find:
```javascript
    '<div class="chart-card"><div class="ct">Emotion (MediaPipe)</div>' +
      '<div class="cs">Heuristic emotion track from face blendshapes.</div>' +
```
and replace with:
```javascript
    '<div class="chart-card"><div class="ct">Emotion (MediaPipe)</div>' +
      '<div class="cs">Heuristic emotion track from face blendshapes.' +
        (compound ? ' Looks like: <b>' + esc(compound) + '</b>.' : '') + '</div>' +
```

- [ ] **Step 5: Run full suite + parse check**

Run: `cd /Users/carrieyu/Desktop/Hipe/mediapipe-test && python -m pytest -q && node --input-type=module --check < frontend/screens/report.js && echo OK`
Expected: all pass + `OK`.

- [ ] **Step 6: Commit**

```bash
git add backend/analysis.py backend/main.py frontend/screens/report.js tests/test_facs.py
git commit -m "feat(facs): compound emotions (Du-Tao-Martinez) on the report"
```

---

## Task 6: Verification

- [ ] **Step 1: Full backend suite**

Run: `cd /Users/carrieyu/Desktop/Hipe/mediapipe-test && python -m pytest -q`
Expected: all pass (existing + the new FACS tests).

- [ ] **Step 2: Parity spot-check (Python ↔ JS)**

Confirm by eye that `frontend/emotion.js` and `backend/analysis.py` agree on: the `AU`/`_AU` key-lists, the prototypes (disgust+AU16, sad+AU17), `EMOTION_CLASSES` includes `contempt`, and `CONTEMPT_SMILE_DELTA`/`_GATE_T` match.

- [ ] **Step 3: Manual browser test (needs DEEPGRAM + ANTHROPIC keys)**

Run a short interview with varied expressions, then on the report confirm:
- The **Emotion (MediaPipe)** card now can show **contempt**, and a **"Looks like: …"** compound line when two emotions co-occur.
- The new **Action Units (FACS)** card lists the AUs that fired with A–E levels.
- Old sessions (scored before this) still render (empty AU card / no compound, no crash).

---

## Self-Review

**Spec coverage:**
- More AUs (AU8/14/16/17) + completed prototypes → Task 1 (backend) + Task 2 (frontend/config). ✓
- Contempt (asymmetry) → Task 3. ✓
- Per-AU breakdown + FACS intensity → Task 4. ✓
- Compound emotions → Task 5. ✓
- Surfacing (live = 8 basics incl contempt; report = +AU card +compound) → Tasks 2/3 (live), 4/5 (report). ✓
- Honesty caveat → Task 4 AU card copy + existing emotion caveat. ✓
- Parity → Tasks 2/3 mirror + Task 6 spot-check. ✓

**Placeholder scan:** complete code in every step; exact commands. ✓

**Type/name consistency:** `_au_value`/`auValue`, `_AU`/`AU` (key-lists), `_MP_CLASSES`, `_contempt_score`/`contemptScore`, `action_units`, `_au_level`, `compound_emotion` defined before use; `aggregate_emotions(shots, classes=...)` parameterized (Task 3) and called with `_MP_CLASSES` (analysis) / default (emotion.py HSEmotion path); `summary["action_units"]` / `summary["emotion_compound"]` written (main.py) and read by report.js (`s.action_units`, `s.emotion_compound`). ✓

---

## Execution Handoff

After implementation, do the Task 6 manual pass. Then use `superpowers:finishing-a-development-branch` to integrate.
