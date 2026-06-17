# FACS Facial-Tension as a Low-Weight Nervousness Term

**Date:** 2026-06-17
**Status:** Approved — ready for implementation planning

## Summary

Feed the existing FACS-derived `facial_tension` signal into the **Nervousness** composite
as a small (15%) term. Because Nervousness drives `Calm = 100 − Nervousness`, which is one
of the four Presence indicators, this means a FACS signal now influences the Readiness score
for the first time. The change is one function plus documentation updates that correct the
previously-stated "FACS is never scored" principle.

## Motivation

`facial_tension` is already computed every session from three Action Units — AU4 (brow
lowerer), AU7 (lid tightener), and AU23 (lip presser) — and already shown on the report, but
it does not contribute to any score. Nervous tension in the face (a pressed mouth, a lowered
brow) is a reasonable supplementary cue for interview nervousness, alongside the existing
geometric cues (blink rate, looking away, face-touching, hand fidgeting). Adding it at low
weight lets it nudge the score without letting a bias-prone inference dominate it.

## Decisions (locked during brainstorming)

| Decision | Choice | Reason |
|---|---|---|
| Does FACS affect the score? | **Yes**, via Nervousness | User opted to feed it in, accepting the doc/principle change. |
| Weight inside Nervousness | **15%** | Minor contributor. Mirrors the rubric's habit of weighting its least-trustworthy term low (voice Energy = 10%). |
| Which signal | **Reuse existing `facial_tension`** (Approach A) | Least code; the number shown on the report is the number that scores — no divergence. Accepts minor noise from AU7 (squint can mean concentration). |

## Scope

### In scope
- One-line logic change to `composite_scores` in `backend/analysis.py`.
- A new unit test covering the new term.
- Documentation updates to three files that state how Presence/Nervousness is scored.

### Out of scope
- Frontend changes — `frontend/screens/report.js` reads `o.nervousness` and derives `Calm`
  itself, so the new value flows through with no structural change.
- Re-architecting the composite to "drop-and-renormalize" missing signals (see Edge Cases).
- Any change to the emotion-classification track (happy/sad/contempt) — it stays unscored.

## Design

### Code change

In `composite_scores` ([`backend/analysis.py:295`](../../../backend/analysis.py)), read the
already-present `facial_tension` and add it as the fifth Nervousness term with re-normalized
weights (all five sum to 1.0):

```python
tension = m.get("facial_tension", 0.0)   # 0–100, FACS-derived (AU4 + AU7 + AU23)
...
"nervousness": clamp(0.25 * min(100.0, bpm * 5.0) + 0.25 * (100.0 - gaze)
                     + 0.2 * min(100.0, touch * 20.0) + 0.15 * min(100.0, fidget * 2000.0)
                     + 0.15 * tension),
```

Weights change from `0.3 / 0.3 / 0.2 / 0.2` (blink / gaze-away / touch / fidget) to
`0.25 / 0.25 / 0.2 / 0.15` plus `0.15` for tension.

This is correct because:
- `facial_tension` is added to the block by `expression_detail` **before** `composite_scores`
  runs (`_metric_block`, `backend/analysis.py:119-122`), so it is available in `m`.
- `facial_tension` is already on a 0–100 scale (`backend/analysis.py:252`), matching the
  other four terms after their own scaling, so no rescaling is needed.

### Data flow / score impact

```
facial_tension (0–100, AU4+AU7+AU23)
  → 15% term in Nervousness
  → Calm = 100 − Nervousness
  → one of 4 Presence indicators (mean)
  → Presence = 35% of Readiness
```

Effective influence on the final Readiness score ≈ `0.15 × (1/4) × 0.35 ≈ 1.3%`. A genuine
nudge, not a driver. Applies to both the overall block and every per-question block, since
`composite_scores` runs on each `_metric_block`.

### Edge cases

- **No blendshapes / no face:** `facial_tension` is `0.0`, contributing nothing (reads as
  "calm"). This matches how the existing four terms behave when their signal is absent
  (e.g. no hands → fidget/touch = 0). It is intentionally consistent with the current
  composite rather than the doc's "drop-and-renormalize" degradation; re-architecting that
  for one term is out of scope. Recorded as a known limitation.
- **Per-question vs overall:** handled automatically — no special-casing needed.

### Tests

- The existing `test_composite_scores_ranges_and_logic` (`tests/test_analysis.py:250`) still
  passes unchanged: its fixtures omit `facial_tension`, so it defaults to 0 and both the
  "good" (< 40) and "nervous" (> 70) assertions still hold under the new weights.
- **Because of that, the new term would be untested.** Add a case (TDD — write it first and
  watch it fail): two inputs identical except one has high `facial_tension`; assert the
  high-tension input yields a strictly higher Nervousness.

### Documentation updates

The change reverses a stated principle, so the docs must be corrected precisely. The line to
draw everywhere: the **emotion-classification track** (happy/sad/contempt) is *still never
scored*; only the **AU facial-tension signal** (AU4/AU7/AU23) now contributes, and only as
15% of Nervousness.

- `docs/features/readiness-scoring-criteria.md`
  - Nervousness formula (line 86) — add the tension term and new weights.
  - "Only the geometric signals feed Presence … never part of the score" (lines 90-92) —
    reword to carve out the AU tension signal.
  - "Presence is geometric only" honesty caveat (lines 123-125) — same correction.
- `docs/features/mediapipe-limitations.md`
  - Nervousness heuristic description (line 51) — add facial tension.
  - "never used for scoring" notes (lines 19, 22) — narrow to the emotion-classification
    track and the per-AU breakdown *as displayed*, noting AU tension now lightly feeds the
    score.
- `docs/features/readiness-scoring-criteria-code-only.md`
  - Apply the same Nervousness formula change if it mirrors the formula.

## Acceptance criteria

1. `composite_scores` includes `facial_tension` at 15% with the four re-normalized weights;
   all five sum to 1.0.
2. A new test proves higher `facial_tension` raises Nervousness, all else equal.
3. The full backend test suite passes.
4. All three docs distinguish the unscored emotion track from the now-lightly-scored AU
   tension signal; no doc still claims FACS is entirely excluded from scoring.
5. No frontend code change.
