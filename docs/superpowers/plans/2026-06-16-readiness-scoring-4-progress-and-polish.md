# Readiness Scoring — Plan 4: Progress Link & Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user reach a finished interview's readiness verdict **from the progress page** (the original request), and add the privacy note + honesty caveat to the report.

**Architecture:** Extend `list_sessions` to include each session's readiness (score + band). Add a clickable "Recent sessions" list to the progress page — each row shows the readiness band and links to `#/session/{id}` (the report with the full verdict). Add two short notes to the report: "audio analyzed, not stored" (privacy) and a one-line caveat that facial-expression signals are approximate.

**Tech Stack:** FastAPI + pytest (backend), vanilla ES modules (frontend).

**This is Plan 4 of 4 — the final plan.** Plans 1 (capture), 2 (voice), 3 (verdict) are done.

---

## File Structure

- **Modify** `backend/sessions_store.py` — `list_sessions` rows gain `readiness: {score, band}` from `summary.verdict`.
- **Create** `tests/test_sessions_readiness.py` — unit tests for the new `readiness` field.
- **Modify** `frontend/screens/progress.js` — add a clickable "Recent sessions" list with readiness badges linking to the report.
- **Modify** `frontend/screens/report.js` — privacy note on the Voice card + honesty caveat near the verdict.
- **Modify** `frontend/styles/clean-studio.css` — styles for the session rows + readiness badges.

---

## Task 1: Include readiness in `list_sessions`

**Files:**
- Modify: `backend/sessions_store.py`
- Test: `tests/test_sessions_readiness.py`

- [ ] **Step 1: Write the failing tests**

```python
# tests/test_sessions_readiness.py
"""list_sessions should surface each session's readiness (score + band)."""
import json

from backend import sessions_store


def _write(tmp_path, sid, summary):
    d = tmp_path / sid
    d.mkdir()
    (d / "summary.json").write_text(json.dumps(summary), encoding="utf-8")


def test_list_sessions_includes_readiness(tmp_path):
    _write(tmp_path, "2026-06-16T120000", {
        "role": "Software Engineer", "per_question": [],
        "overall": {"attention": 80, "confidence": 70, "composure": 60, "nervousness": 20},
        "verdict": {"readiness_score": 72, "band": "ready"},
    })
    rows = sessions_store.list_sessions(str(tmp_path))
    assert len(rows) == 1
    assert rows[0]["readiness"] == {"score": 72, "band": "ready"}


def test_list_sessions_readiness_none_when_no_verdict(tmp_path):
    _write(tmp_path, "2026-06-16T120001", {"role": "X", "per_question": [], "overall": {}})
    rows = sessions_store.list_sessions(str(tmp_path))
    assert rows[0]["readiness"] == {"score": None, "band": None}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd /Users/carrieyu/Desktop/Hipe/mediapipe-test && python -m pytest tests/test_sessions_readiness.py -v`
Expected: FAIL (`KeyError: 'readiness'`).

- [ ] **Step 3: Add the `readiness` field in `list_sessions`**

In `backend/sessions_store.py`, in `list_sessions`, after the line `overall = summary.get("overall") or {}`, add:
```python
        verdict = summary.get("verdict") or {}
```
Then in the appended row dict, add a `readiness` key after the `scores` block (after the closing `},` of `scores`):
```python
            "readiness": {"score": verdict.get("readiness_score"),
                          "band": verdict.get("band")},
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /Users/carrieyu/Desktop/Hipe/mediapipe-test && python -m pytest tests/test_sessions_readiness.py -v`
Expected: both PASS.

- [ ] **Step 5: Full suite**

Run: `cd /Users/carrieyu/Desktop/Hipe/mediapipe-test && python -m pytest -q`
Expected: all pass (the existing sessions-API test still passes — `readiness` is additive).

- [ ] **Step 6: Commit**

```bash
git add backend/sessions_store.py tests/test_sessions_readiness.py
git commit -m "feat(progress): include readiness (score+band) in session list"
```

---

## Task 2: Clickable Recent-sessions list on the progress page

**Files:**
- Modify: `frontend/screens/progress.js`

- [ ] **Step 1: Import `fmtDate`**

In `frontend/screens/progress.js`, change the format import:
```javascript
import { round } from '../format.js';
```
to:
```javascript
import { round, fmtDate } from '../format.js';
```

- [ ] **Step 2: Add the session-list renderer**

Add these near the top of the file (after the `METRICS` array):
```javascript
const BAND_LABEL = { ready: 'Ready', almost: 'Almost', needs_work: 'Needs work' };

// A clickable list of past interviews; each row opens that session's report
// (the full readiness verdict). This is the progress-page entry into the verdict.
function sessionList(sessions){
  return sessions.map((s) => {
    const r = s.readiness || {};
    const band = r.band || null;
    const badge = band
      ? '<span class="rbadge rbadge-' + band + '">' + esc(BAND_LABEL[band] || band) +
        (r.score == null ? '' : ' · ' + Math.round(r.score)) + '</span>'
      : '<span class="rbadge rbadge-none">—</span>';
    return '<a class="sess-row" href="#/session/' + encodeURIComponent(s.id) + '">' +
      '<span class="sr-when">' + esc(fmtDate(s.created_at)) + '</span>' +
      '<span class="sr-role">' + esc(s.role || s.label || 'Interview') + '</span>' +
      badge + '</a>';
  }).join('');
}
```

- [ ] **Step 3: Render the list in the view**

In `view(sessions)`, change the final `return` so the session list appears under the existing charts. The current return is:
```javascript
  return intro + cards + body;
```
Change it to:
```javascript
  const recent = '<div class="chart-card" style="margin-top:14px"><div class="ct">Recent interviews</div>' +
    '<div class="cs">Open any interview to see its full readiness verdict.</div>' +
    '<div class="sess-list">' + sessionList(sessions) + '</div></div>';
  return intro + cards + body + recent;
```

- [ ] **Step 4: Verify it parses**

Run: `cd /Users/carrieyu/Desktop/Hipe/mediapipe-test && node --input-type=module --check < frontend/screens/progress.js && echo SYNTAX_OK`
Expected: `SYNTAX_OK`

- [ ] **Step 5: Commit**

```bash
git add frontend/screens/progress.js
git commit -m "feat(progress): clickable recent-sessions list linking to the verdict"
```

---

## Task 3: Privacy note + honesty caveat on the report

**Files:**
- Modify: `frontend/screens/report.js`

- [ ] **Step 1: Add the privacy line to the Voice card**

In `frontend/screens/report.js`, in the `voiceCard(v)` function, change the final `return` so a privacy line is appended when voice data is present. The function currently ends with:
```javascript
  return rows.map((r) => '<div class="r"><span>' + esc(r[0]) + '</span><b>' + esc(String(r[1])) + '</b></div>').join('');
```
Change it to:
```javascript
  return rows.map((r) => '<div class="r"><span>' + esc(r[0]) + '</span><b>' + esc(String(r[1])) + '</b></div>').join('') +
    '<p class="muted" style="font-size:11px;margin-top:8px">Audio was analyzed to score delivery and was not stored.</p>';
```

- [ ] **Step 2: Add the honesty caveat under the verdict header**

In the `verdictHeader(vd)` function, add the caveat as the last element before the closing `</div>`. The function currently ends with:
```javascript
    (vd.next_action ? '<p class="vnext"><b>Next:</b> ' + esc(vd.next_action) + '</p>' : '') +
    '</div>';
```
Change it to:
```javascript
    (vd.next_action ? '<p class="vnext"><b>Next:</b> ' + esc(vd.next_action) + '</p>' : '') +
    '<p class="muted" style="font-size:11px;margin-top:10px">This is practice feedback, not a hiring decision. ' +
      'Facial-expression signals are approximate — read them as communication cues, not a clinical measure.</p>' +
    '</div>';
```

- [ ] **Step 3: Verify it parses**

Run: `cd /Users/carrieyu/Desktop/Hipe/mediapipe-test && node --input-type=module --check < frontend/screens/report.js && echo SYNTAX_OK`
Expected: `SYNTAX_OK`

- [ ] **Step 4: Commit**

```bash
git add frontend/screens/report.js
git commit -m "feat(report): privacy note + facial-signal honesty caveat"
```

---

## Task 4: Styles + verification

**Files:**
- Modify: `frontend/styles/clean-studio.css`

- [ ] **Step 1: Add styles for the session rows + badges**

Append to `frontend/styles/clean-studio.css`:
```css
.sess-list{display:flex;flex-direction:column;gap:6px;margin-top:8px}
.sess-row{display:flex;align-items:center;gap:12px;padding:9px 12px;border:1px solid var(--rule,#e5e7eb);
  border-radius:10px;text-decoration:none;color:inherit;transition:background .12s}
.sess-row:hover{background:#15794c0d}
.sess-row .sr-when{font-size:12px;opacity:.7;min-width:120px}
.sess-row .sr-role{font-size:13px;font-weight:600;flex:1}
.rbadge{font-size:11px;font-weight:700;padding:3px 9px;border-radius:999px;white-space:nowrap}
.rbadge-ready{background:#15794c1a;color:#15794c}
.rbadge-almost{background:#b7791f1a;color:#b7791f}
.rbadge-needs_work{background:#b91c1c1a;color:#b91c1c}
.rbadge-none{background:#9ca3af1a;color:#6b7280}
```

- [ ] **Step 2: Full backend suite**

Run: `cd /Users/carrieyu/Desktop/Hipe/mediapipe-test && python -m pytest -q`
Expected: all pass.

- [ ] **Step 3: Manual browser test**

- Finish an interview → land on the report → confirm the verdict header shows the caveat line, and the Voice card shows the "audio … not stored" line.
- Go to **Progress** → confirm a **Recent interviews** list appears, each row showing date · role · a readiness badge (Ready / Almost / Needs work · score), and clicking a row opens that interview's report.
- A session with no verdict (e.g. an old one) shows a "—" badge and still links to its report.

- [ ] **Step 4: Commit**

```bash
git add frontend/styles/clean-studio.css
git commit -m "style(progress): session-row and readiness-badge styles"
```

---

## Self-Review

**Spec coverage (Plan 4 — progress link + polish):**
- Reach the verdict from the progress page → Tasks 1 (readiness in list) + 2 (clickable list). ✓
- Privacy note ("audio analyzed, not stored") → Task 3 Step 1. ✓
- Honesty caveat (facial signals approximate; practice not hiring) → Task 3 Step 2. ✓

**Placeholder scan:** every step has complete code + expected output. ✓

**Type/name consistency:** `list_sessions` rows gain `readiness: {score, band}` (Task 1), read by `sessionList` as `s.readiness.{band,score}` (Task 2); `BAND_LABEL` defined in progress.js; `fmtDate`/`esc` already imported or added; CSS classes `sess-row`/`rbadge-{band}` match the band keys (`ready`/`almost`/`needs_work`) emitted by `verdict.band`. ✓

---

## Execution Handoff

After Plan 4, all four plans are complete: the live interview is captured and scored across face (MediaPipe + FACS), voice (Delivery), and content; fused into a readiness verdict with a Claude explanation; reachable from the progress page; with privacy + honesty notes. Recommend a full manual browser run with real `DEEPGRAM_API_KEY` + `ANTHROPIC_API_KEY`, then `superpowers:finishing-a-development-branch` to integrate.
