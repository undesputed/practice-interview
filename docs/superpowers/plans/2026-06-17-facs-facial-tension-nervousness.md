# FACS Facial-Tension in Nervousness — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Feed the existing `facial_tension` signal into the Nervousness composite at 15% weight, so a FACS-derived signal lightly influences the Readiness score, and correct the docs that said FACS is never scored.

**Architecture:** One logic change in `composite_scores` (backend/analysis.py): read `facial_tension` (already on the metric block, already 0–100) and add it as the fifth Nervousness term with re-normalized weights. The value flows through `Calm = 100 − Nervousness` → Presence → Readiness automatically. No frontend change (report.js derives Calm from `nervousness`). Two docs updated to distinguish the still-unscored emotion-classification track from the now-lightly-scored AU tension signal.

**Tech Stack:** Python 3, pytest. Spec: [`docs/superpowers/specs/2026-06-17-facs-facial-tension-nervousness-design.md`](../specs/2026-06-17-facs-facial-tension-nervousness-design.md)

---

## File Structure

- **Modify:** `backend/analysis.py` — `composite_scores` only (lines ~306–313). Add one variable read and re-weight the `nervousness` expression.
- **Modify:** `tests/test_analysis.py` — add one test next to `test_composite_scores_ranges_and_logic` (line 250).
- **Modify:** `docs/features/readiness-scoring-criteria.md` — Nervousness formula + two principle statements.
- **Modify:** `docs/features/mediapipe-limitations.md` — Nervousness/stress-marker row + the AU row.

No files created. No frontend files touched.

---

### Task 1: Wire `facial_tension` into the Nervousness composite (TDD)

**Files:**
- Modify: `backend/analysis.py:306-313` (`composite_scores`)
- Test: `tests/test_analysis.py` (add after line 264)

- [ ] **Step 1: Write the failing test**

Add this function in `tests/test_analysis.py` directly below `test_composite_scores_ranges_and_logic` (after line 264). It reuses `composite_scores`, already imported at line 248.

```python
def test_facial_tension_raises_nervousness():
    # Identical inputs except facial_tension; the tense face must score MORE nervous.
    base = {"gaze_eye_contact_pct": 80.0, "steadiness_score": 80.0, "face_presence_pct": 100.0,
            "upright_pct": 80.0, "body_steadiness": 80.0, "blinks_per_min": 10.0,
            "face_touch_count": 0, "hand_fidget": 0.0}
    calm = composite_scores({**base, "facial_tension": 0.0})
    tense = composite_scores({**base, "facial_tension": 80.0})
    assert tense["nervousness"] > calm["nervousness"]
    # 15% of 80 = 12 points of extra nervousness.
    assert abs((tense["nervousness"] - calm["nervousness"]) - 12.0) < 1e-6
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `python -m pytest tests/test_analysis.py::test_facial_tension_raises_nervousness -v`
Expected: FAIL — current `composite_scores` ignores `facial_tension`, so `tense` and `calm` are equal and `tense > calm` is false (AssertionError).

- [ ] **Step 3: Write the minimal implementation**

In `backend/analysis.py`, in `composite_scores`, add the `tension` read after the `fidget` line (line 306) and re-weight `nervousness`. The function becomes:

```python
def composite_scores(m: dict) -> dict:
    """Heuristic 0-100 interview indicators derived from base metrics. Supplementary, tunable."""
    def clamp(x):
        return round(max(0.0, min(100.0, x)), 1)
    gaze = m.get("gaze_eye_contact_pct", 0.0)
    head = m.get("steadiness_score", 0.0)
    body = m.get("body_steadiness", 0.0)
    presence = m.get("face_presence_pct", 0.0)
    upright = m.get("upright_pct", 0.0)
    bpm = m.get("blinks_per_min", 0.0)
    touch = m.get("face_touch_count", 0)
    fidget = m.get("hand_fidget", 0.0)
    tension = m.get("facial_tension", 0.0)   # 0-100, FACS-derived (AU4 + AU7 + AU23)
    return {
        "attention": clamp(0.5 * gaze + 0.3 * head + 0.2 * presence),
        "confidence": clamp(0.5 * upright + 0.5 * body),
        "nervousness": clamp(0.25 * min(100.0, bpm * 5.0) + 0.25 * (100.0 - gaze)
                             + 0.2 * min(100.0, touch * 20.0) + 0.15 * min(100.0, fidget * 2000.0)
                             + 0.15 * tension),
        "composure": clamp((head + body) / 2.0),
    }
```

- [ ] **Step 4: Run the new test to verify it passes**

Run: `python -m pytest tests/test_analysis.py::test_facial_tension_raises_nervousness -v`
Expected: PASS (calm nervousness = 17.5, tense = 29.5, difference = 12.0).

- [ ] **Step 5: Run the full backend suite to verify no regressions**

Run: `python -m pytest tests/ -q`
Expected: all pass. `test_composite_scores_ranges_and_logic` still passes — its fixtures omit `facial_tension` (defaults to 0): the "good" case = 6.25 (< 40) and the "nervous" case = 82.5 (> 70).

- [ ] **Step 6: Commit**

```bash
git add backend/analysis.py tests/test_analysis.py
git commit -m "feat(facs): facial tension as 15% term in Nervousness composite

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Update documentation to reflect FACS-in-score

**Files:**
- Modify: `docs/features/readiness-scoring-criteria.md` (lines 86, 90-92, 123-125)
- Modify: `docs/features/mediapipe-limitations.md` (lines 22, 51)

- [ ] **Step 1: Update the Nervousness formula in `readiness-scoring-criteria.md`**

Replace line 86:

```
| **Calm** (= 100 − Nervousness) | Nervousness = 0.3 × blink rate + 0.3 × (low eye contact) + 0.2 × face-touching + 0.2 × hand fidgeting |
```

with:

```
| **Calm** (= 100 − Nervousness) | Nervousness = 0.25 × blink rate + 0.25 × (low eye contact) + 0.2 × face-touching + 0.15 × hand fidgeting + 0.15 × facial tension |
```

- [ ] **Step 2: Correct the "geometric only" claim in `readiness-scoring-criteria.md`**

Replace lines 90-92:

```
These composites are heuristic and supplementary. Only the **geometric** signals feed
Presence — the emotion / FACS expression track (happy, sad, contempt, etc.) is shown on
the report for insight but is **never** part of the score.
```

with:

```
These composites are heuristic and supplementary. Presence is built almost entirely from
**geometric** signals (gaze, head/body steadiness, posture, blink, hands). The one
exception is **facial tension** — a FACS-derived signal (brow lower + lid tighten + lip
press) that is 15% of the Nervousness term, so it reaches the score through Calm at roughly
1.3% of the total. The **emotion-classification** track (happy, sad, contempt, etc.) is a
different thing: it is shown on the report for insight but is **never** part of the score.
```

- [ ] **Step 3: Correct the honesty caveat in `readiness-scoring-criteria.md`**

Replace lines 123-125:

```
- **Presence is geometric only.** Emotion inference (the MediaPipe + FACS track, including
  Contempt and compound emotions) is supplementary, accuracy/bias-prone, and excluded from
  scoring. See [`mediapipe-limitations.md`](mediapipe-limitations.md).
```

with:

```
- **Presence is geometric, plus one low-weight FACS term.** Emotion *classification* (the
  MediaPipe + FACS track, including Contempt and compound emotions) is supplementary,
  accuracy/bias-prone, and excluded from scoring. The only FACS signal that touches the
  score is **facial tension** (brow lower / lid tighten / lip press), weighted at 15% of
  Nervousness — a deliberate ~1.3% nudge, not a driver. See
  [`mediapipe-limitations.md`](mediapipe-limitations.md).
```

- [ ] **Step 4: Update the Nervousness indicator row in `mediapipe-limitations.md`**

Replace line 51:

```
| Stress markers | No reliable physiological signal from an RGB webcam; speculative. | A heuristic "Nervousness" indicator from blink rate + looking-away + face-touch + fidget, clearly labeled supplementary. |
```

with:

```
| Stress markers | No reliable physiological signal from an RGB webcam; speculative. | A heuristic "Nervousness" indicator from blink rate + looking-away + face-touch + fidget + a low-weight (15%) facial-tension term (brow lower / lid tighten / lip press), clearly labeled supplementary. |
```

- [ ] **Step 5: Note the scoring use on the AU row in `mediapipe-limitations.md`**

In the "Facial Action Units (validated FACS)" row (line 22), append one sentence to the end of the "What we do instead" cell, immediately after `AUs with no blendshape (e.g. AU23) are out of reach.`:

```
 A three-AU aggregate (AU4 + AU7 + AU23, "facial tension") is the **only** AU signal that feeds scoring — 15% of the Nervousness indicator; all other AU/emotion output is display-only.
```

(The emotion-classification row at line 19 stays unchanged: that track — happy/sad/contempt — is still never scored. Only the AU tension aggregate is.)

- [ ] **Step 6: Verify the docs are internally consistent**

Run: `grep -n "facial tension\|geometric only\|never.*part of the score\|15%" docs/features/readiness-scoring-criteria.md docs/features/mediapipe-limitations.md`
Expected: no remaining "geometric only" / "Presence is geometric only" phrasing; the 15% facial-tension term appears in the Nervousness formula and both principle statements.

- [ ] **Step 7: Commit**

```bash
git add docs/features/readiness-scoring-criteria.md docs/features/mediapipe-limitations.md
git commit -m "docs(facs): Nervousness now includes a 15% facial-tension term

Correct the 'FACS is never scored' wording: the emotion-classification
track stays unscored, but the AU facial-tension aggregate now feeds 15%
of Nervousness (~1.3% of Readiness).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- Acceptance #1 (facial_tension at 15%, weights sum to 1.0) → Task 1 Step 3. ✓ (0.25+0.25+0.2+0.15+0.15 = 1.0)
- Acceptance #2 (test proves higher tension raises Nervousness) → Task 1 Steps 1-4. ✓
- Acceptance #3 (full suite passes) → Task 1 Step 5. ✓
- Acceptance #4 (docs distinguish unscored emotion track from scored AU tension; no doc still claims full FACS exclusion) → Task 2 Steps 1-6. ✓
- Acceptance #5 (no frontend change) → no report.js task; verified in spec scope. ✓
- Spec note on code-only doc ("if it mirrors the formula") → verified during planning it does NOT mirror the formula and makes no FACS-scoring claim, so it is correctly excluded. ✓

**Placeholder scan:** No TBD/TODO; every code and doc edit shows full before/after text. ✓

**Type/name consistency:** Variable `tension`, metric key `facial_tension`, weight `0.15` used consistently across test, implementation, and both docs. ✓
