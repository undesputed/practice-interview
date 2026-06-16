# Readiness Scoring — Plan 3: Fused Verdict Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Combine the three modality scores — **Delivery** (voice, Plan 2), **Presence** (face/body composites), and **Content** (Claude's read of the transcript) — into a single **readiness score (0–100)** and band (**Ready / Almost / Needs work**), with a Claude-written explanation, stored as `summary.verdict` and shown at the top of the results page.

**Architecture:** A new pure-logic `backend/verdict.py` computes the Presence score from the existing composites and fuses the three modalities with the approved weights (Delivery 40 / Presence 35 / Content 25), reweighting when a signal is missing, and maps the result to a band. One Claude call (added to `anthropic_coach.py`) scores Content (0–100) and writes the prose explanation, given the already-computed Delivery + Presence numbers and the transcript. The rubric's score + band are authoritative; Claude writes the words. `main.py` orchestrates this in the existing `session()` handler and stores `summary.verdict`. `report.js` renders a verdict header.

**Tech Stack:** FastAPI + Anthropic SDK + pytest (backend), vanilla ES modules (frontend).

**This is Plan 3 of 4.** Plans 1 (capture) + 2 (voice) are done. Plan 4 adds the progress-page link + privacy/caveat polish.

> **Authoritative numbers, Claude prose:** `verdict.py` computes `readiness_score` and `band` (deterministic). Claude is *given* the Delivery and Presence numbers and produces only the Content score + the explanation text. The report shows the rubric's band/score prominently; Claude's headline/notes are the "why."

---

## File Structure

- **Create** `backend/verdict.py` — `presence_score(overall)`, `band(score)`, `compute_readiness(delivery, presence, content)` (reweighting). Pure, unit-tested.
- **Modify** `backend/anthropic_coach.py` — add `generate_verdict(api_key, transcript, role, delivery_score, presence_score)` (one Claude call) + `parse_verdict(raw)`.
- **Modify** `backend/main.py` — in `session()`, compute Presence + readiness, call `generate_verdict`, store `summary.verdict`.
- **Create** `tests/test_verdict.py` — unit tests for the rubric + `parse_verdict`.
- **Modify** `tests/test_voice_endpoint.py` is untouched; add `tests/test_verdict_endpoint.py` — session integration with `generate_verdict` monkeypatched.
- **Modify** `frontend/screens/report.js` — render the verdict header from `summary.verdict`.

**Data shape — `summary.verdict`:**
```
{ readiness_score: int|null, band: "ready"|"almost"|"needs_work"|null,
  components: {delivery: int|null, presence: int|null, content: int|null},
  weights_used: {<component>: float},
  content_score: int|null, headline, delivery_note, presence_note, content_note,
  strengths: string[], improvements: string[], next_action }
```

---

## Task 1: The readiness rubric (`verdict.py`, TDD)

**Files:**
- Create: `backend/verdict.py`
- Test: `tests/test_verdict.py`

- [ ] **Step 1: Write the failing tests**

```python
# tests/test_verdict.py
"""Unit tests for the fused readiness rubric."""
from backend import verdict


def test_presence_score_mean_of_composites():
    overall = {"attention": 80, "confidence": 72, "composure": 64, "nervousness": 20}
    # mean(80, 72, 64, 100-20=80) = 296/4 = 74
    assert verdict.presence_score(overall) == 74


def test_presence_score_missing_returns_none():
    assert verdict.presence_score({}) is None
    assert verdict.presence_score(None) is None


def test_band_cutoffs():
    assert verdict.band(70) == "ready"
    assert verdict.band(69) == "almost"
    assert verdict.band(50) == "almost"
    assert verdict.band(49) == "needs_work"


def test_compute_readiness_full():
    r = verdict.compute_readiness(80, 60, 40)   # .40*80 + .35*60 + .25*40 = 63
    assert r["readiness_score"] == 63
    assert r["band"] == "almost"
    assert r["components"] == {"delivery": 80, "presence": 60, "content": 40}
    assert set(r["weights_used"]) == {"delivery", "presence", "content"}


def test_compute_readiness_reweights_when_content_missing():
    # only delivery + presence: weights renormalize over .40 + .35 = .75
    r = verdict.compute_readiness(80, 60, None)
    # (.40/.75)*80 + (.35/.75)*60 = 42.667 + 28 = 70.667 -> 71
    assert r["readiness_score"] == 71
    assert r["band"] == "ready"
    assert set(r["weights_used"]) == {"delivery", "presence"}
    assert r["components"]["content"] is None


def test_compute_readiness_presence_only():
    r = verdict.compute_readiness(None, 55, None)
    assert r["readiness_score"] == 55
    assert r["band"] == "almost"
    assert set(r["weights_used"]) == {"presence"}


def test_compute_readiness_all_missing():
    r = verdict.compute_readiness(None, None, None)
    assert r["readiness_score"] is None
    assert r["band"] is None
    assert r["weights_used"] == {}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd /Users/carrieyu/Desktop/Hipe/mediapipe-test && python -m pytest tests/test_verdict.py -v`
Expected: FAIL (`No module named 'backend.verdict'`).

- [ ] **Step 3: Implement `backend/verdict.py`**

```python
# backend/verdict.py
"""Fused readiness rubric: combine Delivery (voice), Presence (face/body), and
Content (transcript) into one readiness score + band.

The numbers here are authoritative; the Claude call in anthropic_coach.py only
writes the explanation prose and the Content score. Weights are the approved
delivery+presence-first split. Missing signals are dropped and the remaining
weights renormalized, so a partial result is reweighted, never penalized.
"""

WEIGHTS = {"delivery": 0.40, "presence": 0.35, "content": 0.25}
READY_MIN = 70    # >= -> "ready"
ALMOST_MIN = 50   # >= -> "almost", else "needs_work"


def presence_score(overall):
    """Presence (0-100) = mean(Attention, Confidence, Composure, 100 - Nervousness).

    Uses whatever composites are present in `overall`; returns None if none are.
    """
    overall = overall or {}
    parts = []
    for key in ("attention", "confidence", "composure"):
        v = overall.get(key)
        if isinstance(v, (int, float)):
            parts.append(float(v))
    nervousness = overall.get("nervousness")
    if isinstance(nervousness, (int, float)):
        parts.append(100.0 - float(nervousness))
    return round(sum(parts) / len(parts)) if parts else None


def band(score):
    if score >= READY_MIN:
        return "ready"
    if score >= ALMOST_MIN:
        return "almost"
    return "needs_work"


def compute_readiness(delivery, presence, content):
    """Weighted fusion of the three 0-100 sub-scores (any may be None).

    Returns {readiness_score, band, components, weights_used}. When some signals
    are absent, the present weights are renormalized to sum to 1.0.
    """
    components = {"delivery": delivery, "presence": presence, "content": content}
    present = {k: v for k, v in components.items() if isinstance(v, (int, float))}
    if not present:
        return {"readiness_score": None, "band": None,
                "components": components, "weights_used": {}}
    weight_sum = sum(WEIGHTS[k] for k in present)
    score = sum((WEIGHTS[k] / weight_sum) * float(present[k]) for k in present)
    rs = round(score)
    return {"readiness_score": rs, "band": band(rs), "components": components,
            "weights_used": {k: round(WEIGHTS[k] / weight_sum, 3) for k in present}}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /Users/carrieyu/Desktop/Hipe/mediapipe-test && python -m pytest tests/test_verdict.py -v`
Expected: all PASS. (Note: Python's `round()` is banker's rounding; the test values — 63, 71, 55, 74 — were chosen to avoid `.5` ties so they're unambiguous.)

- [ ] **Step 5: Commit**

```bash
git add backend/verdict.py tests/test_verdict.py
git commit -m "feat(verdict): fused readiness rubric (presence + weighted bands)"
```

---

## Task 2: Claude verdict explanation (`anthropic_coach.generate_verdict`)

**Files:**
- Modify: `backend/anthropic_coach.py`
- Test: `tests/test_verdict.py` (append a `parse_verdict` test)

- [ ] **Step 1: Append a `parse_verdict` test to `tests/test_verdict.py`**

```python
def test_parse_verdict_extracts_fields():
    from backend import anthropic_coach
    raw = ('```json\n{"content_score": 72, "headline": "Almost there",'
           ' "delivery_note": "Good pace", "presence_note": "Steady",'
           ' "content_note": "Add specifics", "strengths": ["clear"],'
           ' "improvements": ["more detail"], "next_action": "Practice STAR"}\n```')
    v = anthropic_coach.parse_verdict(raw)
    assert v["content_score"] == 72
    assert v["headline"] == "Almost there"
    assert v["strengths"] == ["clear"]
    assert v["next_action"] == "Practice STAR"


def test_parse_verdict_bad_input_defaults():
    from backend import anthropic_coach
    v = anthropic_coach.parse_verdict("not json at all")
    assert v["content_score"] is None
    assert v["strengths"] == [] and v["improvements"] == []
```

Run `python -m pytest tests/test_verdict.py -v` → the two new tests FAIL (no `parse_verdict`).

- [ ] **Step 2: Add `generate_verdict` + `parse_verdict` to `backend/anthropic_coach.py`**

Append to the file (keep the existing `generate_coaching`):

```python
VERDICT_SYSTEM_PROMPT = (
    "You are a supportive interview coach giving READINESS feedback for a practice "
    "interview (self-improvement, never a hiring decision). You are given the candidate's "
    "transcript plus two already-computed scores: a Delivery score (voice: pace, fillers, "
    "pauses, expressiveness) and a Presence score (on-camera: eye contact, posture, "
    "composure), each 0-100. Judge ONLY the Content of their answers yourself. "
    "Return ONLY a JSON object with keys: content_score (integer 0-100 rating clarity, "
    "structure, specificity, and relevance of WHAT they said), headline (one warm sentence), "
    "delivery_note (one line on their voice, referencing the Delivery score), presence_note "
    "(one line on their on-camera presence, referencing the Presence score), content_note "
    "(one line on their answers), strengths (string[] of 2-3), improvements (string[] of 2-3), "
    "next_action (one concrete next step). Plain, encouraging language. No prose outside the JSON."
)


def parse_verdict(raw: str) -> dict:
    """Extract the verdict JSON from the model response, tolerating code fences."""
    text = raw.strip()
    fenced = re.search(r"```(?:json)?\s*(\{.*\})\s*```", text, re.DOTALL)
    if fenced:
        text = fenced.group(1)
    else:
        brace = re.search(r"\{.*\}", text, re.DOTALL)
        if brace:
            text = brace.group(0)
    try:
        data = json.loads(text)
        score = data.get("content_score")
        return {"content_score": int(score) if isinstance(score, (int, float)) else None,
                "headline": data.get("headline", ""),
                "delivery_note": data.get("delivery_note", ""),
                "presence_note": data.get("presence_note", ""),
                "content_note": data.get("content_note", ""),
                "strengths": data.get("strengths", []),
                "improvements": data.get("improvements", []),
                "next_action": data.get("next_action", "")}
    except (ValueError, AttributeError, TypeError):
        return {"content_score": None, "headline": "", "delivery_note": "",
                "presence_note": "", "content_note": "", "strengths": [],
                "improvements": [], "next_action": ""}


def generate_verdict(api_key: str, transcript_text: str, role: str,
                     delivery_score=None, presence_score=None) -> dict:
    """One Claude call: score Content (0-100) and write the readiness explanation,
    given the already-computed Delivery + Presence numbers."""
    client = Anthropic(api_key=api_key)
    d = "n/a" if delivery_score is None else str(delivery_score)
    p = "n/a" if presence_score is None else str(presence_score)
    resp = client.messages.create(
        model=COACH_MODEL,
        max_tokens=1024,
        system=[{"type": "text", "text": VERDICT_SYSTEM_PROMPT,
                 "cache_control": {"type": "ephemeral"}}],
        messages=[{"role": "user",
                   "content": (f"Role: {role}\nDelivery score (voice): {d}/100\n"
                               f"Presence score (face/body): {p}/100\n\n"
                               f"Transcript:\n{transcript_text}")}],
    )
    return parse_verdict(resp.content[0].text)
```

- [ ] **Step 3: Run the tests**

Run: `cd /Users/carrieyu/Desktop/Hipe/mediapipe-test && python -m pytest tests/test_verdict.py -v`
Expected: all PASS (rubric + parse_verdict). No network is hit (`generate_verdict` itself isn't called in unit tests).

- [ ] **Step 4: Commit**

```bash
git add backend/anthropic_coach.py tests/test_verdict.py
git commit -m "feat(verdict): Claude content score + readiness explanation"
```

---

## Task 3: Orchestrate the verdict in `session()`

**Files:**
- Modify: `backend/main.py`
- Test: `tests/test_verdict_endpoint.py` (create)

- [ ] **Step 1: Write the failing integration test**

```python
# tests/test_verdict_endpoint.py
"""Session integration for the fused verdict (Claude monkeypatched)."""
import backend.main as main
from backend.main import app, SESSIONS_DIR
from backend import sessions_store
from fastapi.testclient import TestClient

client = TestClient(app)

FRAME = {"t": 0.0, "turn": 0, "face": True, "face_count": 1,
         "bs": {}, "m": [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]}


def _payload(voice=None):
    return {"role": "Software Engineer", "frames": [FRAME, FRAME],
            "transcript": {"full_text": "CANDIDATE: I led a team and shipped a feature.",
                           "segments": [{"speaker": "candidate", "text": "I led a team.", "t": 0.0}]},
            "events": [], "emotion": None,
            "voice": voice or {"available": True, "delivery_score": 80, "metrics": {}, "breakdown": []}}


def test_session_builds_verdict_with_claude(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    def _fake_verdict(api_key, text, role, delivery_score=None, presence_score=None):
        # delivery is passed through from summary.voice; presence is computed upstream
        assert delivery_score == 80
        return {"content_score": 60, "headline": "Almost there", "delivery_note": "",
                "presence_note": "", "content_note": "", "strengths": ["a"],
                "improvements": ["b"], "next_action": "c"}
    monkeypatch.setattr(main, "generate_verdict", _fake_verdict)
    res = client.post("/api/session", json=_payload())
    assert res.status_code == 200, res.text
    sid = res.json()["session_id"]
    try:
        v = res.json()["summary"]["verdict"]
        assert v["components"]["delivery"] == 80
        assert v["components"]["content"] == 60
        assert isinstance(v["readiness_score"], int)
        assert v["band"] in ("ready", "almost", "needs_work")
        assert v["headline"] == "Almost there"
    finally:
        sessions_store.delete_session(SESSIONS_DIR, sid)


def test_session_verdict_without_anthropic_key(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    res = client.post("/api/session", json=_payload())
    assert res.status_code == 200, res.text
    sid = res.json()["session_id"]
    try:
        v = res.json()["summary"]["verdict"]
        # no Claude -> content is None, readiness is delivery+presence reweighted
        assert v["components"]["content"] is None
        assert v["components"]["delivery"] == 80
        assert isinstance(v["readiness_score"], int)
    finally:
        sessions_store.delete_session(SESSIONS_DIR, sid)
```

Run `python -m pytest tests/test_verdict_endpoint.py -v` → FAIL (`summary` has no `verdict`).

- [ ] **Step 2: Wire it in `backend/main.py`**

(a) Add `verdict` to the package import and `generate_verdict` to the coach import. Change:
```python
from backend.anthropic_coach import generate_coaching
```
to:
```python
from backend.anthropic_coach import generate_coaching, generate_verdict
```
and change:
```python
from backend import sessions_store, voice
```
to:
```python
from backend import sessions_store, voice, verdict as verdict_mod
```

(b) In `session(req)`, find the existing coaching block:
```python
    coaching = None
    anthropic_key = os.getenv("ANTHROPIC_API_KEY")
    full_text = req.transcript.get("full_text", "")
    if anthropic_key and full_text.strip():
        coaching = generate_coaching(anthropic_key, full_text, req.role)
```
and add, immediately AFTER it:
```python
    # Fused readiness verdict: Delivery (voice) + Presence (composites) + Content (Claude).
    presence = verdict_mod.presence_score(summary["overall"])
    delivery = summary["voice"].get("delivery_score") if summary["voice"].get("available") else None
    explanation = None
    content = None
    if anthropic_key and full_text.strip():
        explanation = generate_verdict(anthropic_key, full_text, req.role, delivery, presence)
        content = explanation.get("content_score")
    readiness = verdict_mod.compute_readiness(delivery, presence, content)
    summary["verdict"] = {
        "readiness_score": readiness["readiness_score"],
        "band": readiness["band"],
        "components": readiness["components"],
        "weights_used": readiness["weights_used"],
        "content_score": content,
        "headline": (explanation or {}).get("headline", ""),
        "delivery_note": (explanation or {}).get("delivery_note", ""),
        "presence_note": (explanation or {}).get("presence_note", ""),
        "content_note": (explanation or {}).get("content_note", ""),
        "strengths": (explanation or {}).get("strengths", []),
        "improvements": (explanation or {}).get("improvements", []),
        "next_action": (explanation or {}).get("next_action", ""),
    }
```

> The test monkeypatches `main.generate_verdict`, so the handler must call the name `generate_verdict` (imported at module top), not `anthropic_coach.generate_verdict`. The import in (a) makes `generate_verdict` a module-level name in `main`.

- [ ] **Step 3: Run the tests**

Run: `cd /Users/carrieyu/Desktop/Hipe/mediapipe-test && python -m pytest tests/test_verdict_endpoint.py -v`
Expected: both PASS.

- [ ] **Step 4: Full suite**

Run: `cd /Users/carrieyu/Desktop/Hipe/mediapipe-test && python -m pytest -q`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add backend/main.py tests/test_verdict_endpoint.py
git commit -m "feat(verdict): compute and store the fused verdict on the session"
```

---

## Task 4: Render the verdict header on the report

**Files:**
- Modify: `frontend/screens/report.js`

- [ ] **Step 1: Add a `verdictHeader` renderer**

In `frontend/screens/report.js`, add after the `voiceCard` function:
```javascript
const BAND_LABEL = { ready: 'Ready', almost: 'Almost ready', needs_work: 'Needs work' };

function verdictHeader(vd){
  if (!vd || vd.readiness_score == null) return '';
  const band = vd.band || 'needs_work';
  const comp = vd.components || {};
  const sub = (label, val) => '<div class="vsub"><span>' + label + '</span><b>' +
    (val == null ? '—' : Math.round(val)) + '</b></div>';
  const notes = [vd.delivery_note, vd.presence_note, vd.content_note]
    .filter(Boolean).map((n) => '<li>' + esc(n) + '</li>').join('');
  const str = (vd.strengths || []).map((x) => '<li>' + esc(x) + '</li>').join('');
  const imp = (vd.improvements || []).map((x) => '<li>' + esc(x) + '</li>').join('');
  return '<div class="verdict verdict-' + band + '">' +
    '<div class="vhead"><div class="vscore">' + Math.round(vd.readiness_score) + '<span>/100</span></div>' +
      '<div class="vband"><div class="vlabel">' + esc(BAND_LABEL[band] || band) + '</div>' +
      '<div class="vhl">' + esc(vd.headline || '') + '</div></div></div>' +
    '<div class="vsubs">' + sub('Delivery', comp.delivery) + sub('Presence', comp.presence) +
      sub('Content', comp.content) + '</div>' +
    (notes ? '<ul class="vnotes">' + notes + '</ul>' : '') +
    (str ? '<h5>Strengths</h5><ul>' + str + '</ul>' : '') +
    (imp ? '<h5>To improve</h5><ul>' + imp + '</ul>' : '') +
    (vd.next_action ? '<p class="vnext"><b>Next:</b> ' + esc(vd.next_action) + '</p>' : '') +
    '</div>';
}
```

- [ ] **Step 2: Render it at the top of the report and avoid duplicate coaching**

In `view(s)`, after `const v = s.voice || { available: false };`, add:
```javascript
  const vd = s.verdict || null;
```
Then, in the returned template, insert `verdictHeader(vd)` immediately AFTER the `'<div class="score-cards">...'` closing (i.e. right before the `'<div class="two-col">'` line). Find:
```javascript
    '</div>' +
    '<div class="two-col"><div class="cat-cards">' + cats + '</div>' + coachHtml + '</div>' +
```
and change it to:
```javascript
    '</div>' +
    verdictHeader(vd) +
    '<div class="two-col"><div class="cat-cards">' + cats + '</div>' + (vd ? '' : coachHtml) + '</div>' +
```
(When a verdict exists it supersedes the old coaching card — strengths/improvements now live in the verdict. Old sessions with no verdict still show `coachHtml`.)

- [ ] **Step 3: Add minimal styles for the verdict**

Append to `frontend/styles/clean-studio.css` (or the main stylesheet if that file does not exist — check which the report uses):
```css
.verdict{border:1px solid var(--rule,#e5e7eb);border-radius:14px;padding:18px;margin:14px 0}
.verdict-ready{border-color:#15794c;background:#15794c0d}
.verdict-almost{border-color:#b7791f;background:#b7791f0d}
.verdict-needs_work{border-color:#b91c1c;background:#b91c1c0d}
.verdict .vhead{display:flex;gap:16px;align-items:center}
.verdict .vscore{font-size:40px;font-weight:700;line-height:1}
.verdict .vscore span{font-size:16px;font-weight:500;opacity:.6}
.verdict .vlabel{font-size:18px;font-weight:700}
.verdict .vhl{font-size:13px;opacity:.8}
.verdict .vsubs{display:flex;gap:18px;margin:12px 0}
.verdict .vsub{font-size:12px}
.verdict .vsub b{display:block;font-size:18px}
.verdict .vnotes{margin:8px 0;padding-left:18px;font-size:13px}
.verdict h5{margin:10px 0 4px;font-size:12px;text-transform:uppercase;opacity:.6}
.verdict .vnext{font-size:13px;margin-top:8px}
```

- [ ] **Step 4: Verify it parses**

Run: `cd /Users/carrieyu/Desktop/Hipe/mediapipe-test && node --input-type=module --check < frontend/screens/report.js && echo SYNTAX_OK`
Expected: `SYNTAX_OK`

- [ ] **Step 5: Commit**

```bash
git add frontend/screens/report.js frontend/styles/clean-studio.css
git commit -m "feat(verdict): readiness header on the report"
```

---

## Task 5: Verification

- [ ] **Step 1: Full backend suite**

Run: `cd /Users/carrieyu/Desktop/Hipe/mediapipe-test && python -m pytest -q`
Expected: all pass (Plans 1–2 + verdict unit + verdict endpoint tests).

- [ ] **Step 2: Manual browser test (requires DEEPGRAM_API_KEY + ANTHROPIC_API_KEY)**

Run a short interview, press Stop. Expected on the report:
- A **verdict header** at the top with a readiness number /100, a band label (Ready / Almost ready / Needs work), a one-line headline, and three sub-scores (Delivery, Presence, Content).
- Strengths / To improve / Next action below it.
- With no `ANTHROPIC_API_KEY`: the header still shows a readiness number + band from Delivery + Presence (Content omitted, weights reweighted), with no Claude prose.

- [ ] **Step 3: Confirm the band matches the number**

Sanity-check that the band label agrees with the score (≥70 Ready, 50–69 Almost, <50 Needs work).

---

## Self-Review

**Spec coverage (Plan 3 — fused verdict):**
- Combine Delivery + Presence + Content with 40/35/25 weights → `compute_readiness` (Task 1). ✓
- Presence from existing composites → `presence_score` (Task 1). ✓
- Content score + explanation from Claude → `generate_verdict` (Task 2). ✓
- Bands Ready/Almost/Needs work at 70/50 → `band` (Task 1). ✓
- Reweight when a signal is missing → `compute_readiness` (Task 1), exercised by the no-key endpoint test (Task 3). ✓
- Authoritative numbers, Claude prose → rubric computes score/band; Claude supplies content_score + notes (Tasks 1–3). ✓
- Stored on session + shown on report → Task 3 (`summary.verdict`) + Task 4 (header). ✓
- Privacy caveat about facial signals + progress-page link → **Plan 4.**

**Placeholder scan:** every code step has complete code; commands have expected output. ✓

**Type/name consistency:** `presence_score`/`band`/`compute_readiness`/`WEIGHTS` (verdict.py) used in main.py; `generate_verdict`/`parse_verdict` (anthropic_coach.py) imported into main.py as `generate_verdict`; `summary.verdict` written in Task 3 with keys `{readiness_score, band, components, weights_used, content_score, headline, delivery_note, presence_note, content_note, strengths, improvements, next_action}` and read by `verdictHeader` in Task 4. The endpoint test monkeypatches `main.generate_verdict` (module-level name), matching the import. ✓

---

## Execution Handoff

After Plan 3, Plan 4 adds the progress-page link into the report, the privacy note ("audio analyzed, not stored"), and the honesty caveat that facial-emotion signals are approximate.
