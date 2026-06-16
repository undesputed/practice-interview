# Broader FACS Facial Analysis — Design

- **Date:** 2026-06-16
- **Status:** Approved (design); pending implementation plan
- **Topic:** Broaden the MediaPipe + FACS emotion analysis beyond the current 13 Action Units / 7 emotions: wire in more AUs, add Contempt (8th emotion), expose a per-AU breakdown with FACS intensity, and add compound emotions — within the hard limits of what MediaPipe blendshapes can see.

## 1. Problem & Context

The app maps MediaPipe Face Landmarker blendshapes → 13 FACS Action Units → 7 EMFACS emotions (happy, sad, surprise, fear, angry, disgust, neutral). The model is implemented twice and kept in sync: [backend/analysis.py](../../../backend/analysis.py) `emotion_from_blendshapes()` (the report's emotion track) and [frontend/emotion.js](../../../frontend/emotion.js) `emotionScores()` (the live tile). Blendshapes are captured per frame via [interview-engine.js](../../../frontend/interview-engine.js) `pickBlendshapes()`, which keeps only the keys in [config.js](../../../frontend/config.js) `CONFIG.BLENDSHAPES`.

MediaPipe outputs **52 blendshapes**; the app uses ~36 (≈13 AUs). Several useful AUs and the 8th basic emotion (Contempt) are derivable from currently-unused blendshapes. (Research + sources captured in this session; see §10.)

## 2. Goals

1. **More Action Units** — add AU8, AU14, AU16, AU17 and complete the disgust (+AU16) and sadness (+AU17) prototypes.
2. **Contempt** — add an 8th emotion, detected via AU14 + asymmetric smile.
3. **Per-AU breakdown + intensity** — show which AUs fired and how strongly (FACS A–E) on the report.
4. **Compound emotions** — add the Du–Tao–Martinez compound set ("happily surprised", etc.) on the report.

## 3. Non-Goals

- Not a full/clinical FACS coder. AUs with **no MediaPipe blendshape are out of scope**: AU11, AU13, **AU23** (a core anger AU — anger keeps a ceiling), AU38, AU39, AU46. The known-buggy `cheekPuff` and `tongueOut` are not used.
- No change to the scoring/verdict pipeline beyond what reads the emotion track.
- No new ML model — this stays a blendshape→AU heuristic.
- The live tile stays simple: it shows the 8 basic emotions only (compound + AU breakdown are report-only).

## 4. Decisions (locked during brainstorming)

| # | Decision | Choice |
|---|----------|--------|
| 1 | New AUs | **AU8 (mouthClose), AU14 (mouthDimple), AU16 (mouthLowerDown), AU17 (mouthShrugUpper+Lower)** |
| 2 | Complete prototypes | disgust += AU16; sadness += AU17 |
| 3 | Contempt | 8th class; AU14 + asymmetric smile (L/R-aware) |
| 4 | Per-AU breakdown | Report only; FACS A–E from 0–1 values |
| 5 | Compound emotions | Report only; top-2 basic-emotion pairing (Du–Tao–Martinez) |
| 6 | Surfacing | Live tile = 8 basics (incl. contempt); Report = 8 basics + compound + AU breakdown |
| 7 | Parity | Keep the dual backend/frontend implementation in sync (existing pattern); thoroughly unit-test the backend |
| 8 | Honesty | Keep + extend the "approximate, not clinical" caveat (AU23 gap, contempt/compound noise) |

## 5. Architecture & shared model

The AU model is refactored so an AU maps to a **list of exact blendshape keys** (averaging those present), because the new AUs don't fit the current "base name + Left/Right" convention:
- AU8 = `[mouthClose]` (single)
- AU14 = `[mouthDimpleLeft, mouthDimpleRight]`
- AU16 = `[mouthLowerDownLeft, mouthLowerDownRight]`
- AU17 = `[mouthShrugUpper, mouthShrugLower]` (Upper/Lower, not Left/Right)
- (existing AUs become explicit key-lists too: AU1=`[browInnerUp]`, AU2=`[browOuterUpLeft,browOuterUpRight]`, … AU23=`[mouthPressLeft,mouthPressRight]` kept as the existing approximation.)

This same AU map + prototypes + contempt logic is mirrored in `analysis.py` (Python) and `emotion.js` (JS). New blendshapes (`mouthClose`, `mouthDimpleLeft/Right`, `mouthLowerDownLeft/Right`, `mouthShrugUpper`, `mouthShrugLower`) are added to `CONFIG.BLENDSHAPES` so frames carry them.

## 6. Phase designs

### Phase 1 — More AUs + completed prototypes
- `config.js`: add the 6 new blendshape keys to `CONFIG.BLENDSHAPES`.
- `analysis.py` + `emotion.js`: refactor the AU map to key-lists; add AU8/14/16/17; change `disgust` prototype to `[AU9, AU10, AU15, AU16]` and `sad` to `[AU1, AU4, AU15, AU17]`. Keep the existing gates/conflicts. The averaging helper averages the present keys in a list (one-sided counts at full strength, as today).
- Outcome: the existing 7 emotions get fuller prototypes; new AUs are available for later phases. The live tile + report behave the same except slightly better disgust/sadness fidelity.

### Phase 2 — Contempt (8th emotion)
- Add `contempt` to `EMOTION_CLASSES` (both files).
- Contempt is **not** a symmetric mean prototype. Compute a contempt score from: the **smile asymmetry** `|smileL − smileR|` and the **dimpler** `max(dimpleL, dimpleR)`, gated so it only fires when one-sided smile dominates (delta over a threshold) AND a dimple is present. Add it into the same normalize/distribution step as the other emotions.
- Surfaces on the live tile (dominant can now be "contempt") and the report's emotion bars.

### Phase 3 — Per-AU breakdown + intensity (report only)
- `analysis.py`: a new function aggregates each AU's intensity across the interview frames — `peak` and `mean` (0–1) — and bins `peak` to FACS **A–E** (0–.2 A, –.4 B, –.6 C, –.8 D, –1 E; below ~.1 = not fired). Output `summary["action_units"] = [{au, name, peak, mean, level}, ...]` sorted by peak.
- `report.js`: a new "Action Units (FACS)" card listing the AUs that fired with their level + a small bar. AUs below the floor are hidden or shown muted.
- Live tile unaffected.

### Phase 4 — Compound emotions (report only)
- `analysis.py`: from the aggregated 8-class basic distribution, take the **top two** emotions; if both clear a joint threshold, map the unordered pair → a compound label via a lookup table of the Du–Tao–Martinez pairings (happily surprised, sadly fearful, fearfully surprised, angrily disgusted, etc.). Output `summary["emotion_compound"] = {label, components: [a, b], confidence}` (or `{label: None}` when no clear compound).
- `report.js`: show the compound label near the emotion bars ("Looks like: happily surprised").
- Live tile unaffected.

## 7. Components & Files

| File | Phases | Change |
|------|--------|--------|
| `frontend/config.js` | 1 | add 6 blendshape keys to `CONFIG.BLENDSHAPES` |
| `backend/analysis.py` | 1–4 | AU key-list map; AU8/14/16/17; completed prototypes; contempt; `action_units` aggregation; `emotion_compound` |
| `frontend/emotion.js` | 1–2 | mirror AU key-list map + AU8/14/16/17 + completed prototypes + contempt (parity) |
| `frontend/screens/report.js` | 3–4 | "Action Units (FACS)" card + compound label; extend the emotion caveat |
| `tests/test_emotion.py` (or new `tests/test_facs.py`) | 1–4 | AU mapping, contempt, per-AU aggregation/binning, compound pairing |

## 8. Error Handling & Edge Cases

- **Old sessions** (scored before this change) lack the new blendshapes → their AUs read 0 and compound/AU-breakdown may be empty; the report must render gracefully (empty AU card / no compound).
- **Frames missing a blendshape** (e.g. one-sided) → the averaging helper uses present keys; absent → 0 (as today).
- **Contempt false-positives** (asymmetric smiles are subtle) → the gate (smile delta + dimple) keeps it conservative; the caveat notes lower contempt accuracy.
- **No clear compound** (one emotion dominates) → `emotion_compound.label = None`; the report shows nothing for it.
- **Parity drift** risk between Python/JS → the files carry a "KEEP IN SYNC" note (existing convention); backend is the source of truth for the report and is unit-tested.

## 9. Testing

- Backend (pytest): AU key-list averaging (incl. AU8 single / AU17 Upper+Lower); disgust/sadness prototypes include AU16/AU17; a strongly-asymmetric-smile+dimple frame yields contempt as dominant while a symmetric smile does not; per-AU aggregation produces correct peak/mean + A–E bins; compound pairing maps a happy+surprise distribution to "happily surprised" and returns None when one emotion dominates.
- Frontend parity: `emotion.js` `EMOTION_CLASSES` includes `contempt` and the AU map keys match `analysis.py` (a quick manual/scripted check). UI (report AU card + compound label) verified manually in the browser.

## 10. References

- FACS: Ekman/Friesen/Hager; iMotions FACS guide; Melinda Ozel FACS + ARKit→FACS cheat sheets.
- MediaPipe 52 blendshapes: google-ai-edge/mediapipe `face_blendshapes_graph.cc`; bug notes (cheekPuff #4436, tongueOut #4403).
- Blendshape→AU mapping + ARKit emotion study (PMC). Compound emotions: Du, Tao & Martinez, PNAS 2014 (21 categories).
- Current code: [analysis.py](../../../backend/analysis.py), [emotion.js](../../../frontend/emotion.js), [config.js](../../../frontend/config.js), [report.js](../../../frontend/screens/report.js), [interview-engine.js](../../../frontend/interview-engine.js).
