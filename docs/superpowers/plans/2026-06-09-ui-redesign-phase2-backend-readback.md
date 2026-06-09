# UI Redesign — Phase 2: Backend Read-Back Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make saved interview sessions readable back over the API — list them, load one, delete one, rename one — and persist the interview `role` + creation timestamp into each session so the Dashboard and History screens can show them.

**Architecture:** A small `backend/sessions_store.py` module owns all filesystem access to the `sessions/` directory (list / load / delete / set-label), with strict session-id validation that doubles as path-traversal protection. Four thin FastAPI endpoints in `backend/main.py` wrap it. The existing `/api/session` save path gains two lines to persist `role` and `created_at`. No existing behavior changes.

**Tech Stack:** FastAPI, pytest + `fastapi.testclient.TestClient` (existing setup). Pure-Python, no new dependencies.

**Testing:** Full TDD with pytest — this phase is all backend logic, which the existing test setup covers well. Tests monkeypatch `backend.main.SESSIONS_DIR` to a `tmp_path` so they never touch the real `sessions/` directory.

**This is Plan 2 of the UI redesign series.** It unblocks Plan 3 (Dashboard, History, and the rewired Report screen, which consume these endpoints). It depends on Plan 1 (Foundation) being merged, but touches only `backend/` + `tests/` so the two don't conflict.

---

## Background facts (verified against the codebase)

- Sessions are saved as directories under `SESSIONS_DIR` (repo `sessions/`). Each dir name is the session id, formatted `"%Y-%m-%dT%H%M%S"` (e.g. `2026-06-09T114547`) — digits, dashes, and a `T` only; no slashes.
- Each dir contains `summary.json`. Its `overall` block already contains the four headline scores (`attention`, `confidence`, `nervousness`, `composure`) computed in `backend/analysis.py`. It also has `duration_sec`, `per_question` (list), `timing`, `integrity`, `actions`, `emotion`, `emotion_mediapipe`, `coaching`.
- `summary.json` does **not** currently contain `role` or a creation timestamp. The date is only encoded in the dir name.
- `backend/report.py:save_session` writes `summary.json` from `out = dict(summary); out["coaching"] = coaching`. So any key added to `summary` before `save_session` is persisted.
- `backend/main.py` defines API routes, then mounts `/sessions` (static) and `/` (static) **last** ("static mounts last so /api routes win"). New `/api/...` routes must be added in the routes section, above those mounts.
- `SESSIONS_DIR` is a module global in `backend/main.py`, read inside request handlers at call time — so tests can `monkeypatch.setattr("backend.main.SESSIONS_DIR", str(tmp_path))`.

---

## File Structure (Phase 2)

**Create:**
- `backend/sessions_store.py` — all read-back filesystem logic (list / load / delete / set-label) + id validation.
- `tests/test_sessions_store.py` — unit tests for the store (no HTTP, no matplotlib).
- `tests/test_sessions_api.py` — endpoint tests via `TestClient`, including a path-traversal check.

**Modify:**
- `backend/main.py` — persist `role` + `created_at` in the existing `session()` handler; add four `/api/sessions` endpoints.

**Untouched:** all frontend files, `backend/report.py`, `backend/analysis.py`, and the existing recording pipeline.

---

## Task 1: Persist `role` and `created_at` into saved sessions

**Files:**
- Modify: `backend/main.py` (inside the existing `session()` handler)
- Test: `tests/test_sessions_api.py`

- [ ] **Step 1: Write the failing test**

Create `tests/test_sessions_api.py` with exactly this content:

```python
import json
import os
from fastapi.testclient import TestClient
from backend.main import app

client = TestClient(app)


def _frame(t, turn=0):
    m = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
    return {"t": t, "turn": turn, "face": True,
            "bs": {"mouthSmileLeft": 0.1, "mouthSmileRight": 0.1,
                   "eyeBlinkLeft": 0.0, "eyeBlinkRight": 0.0, "browInnerUp": 0.0},
            "m": m}


def test_session_persists_role_and_created_at(monkeypatch, tmp_path):
    monkeypatch.setattr("backend.main.SESSIONS_DIR", str(tmp_path))
    monkeypatch.setenv("ANTHROPIC_API_KEY", "")
    body = {"role": "Data Analyst",
            "frames": [_frame(i * 100.0) for i in range(6)],
            "transcript": {"full_text": "", "segments": []}}
    resp = client.post("/api/session", json=body)
    assert resp.status_code == 200
    session_id = resp.json()["session_id"]

    saved = json.loads((tmp_path / session_id / "summary.json").read_text())
    assert saved["role"] == "Data Analyst"
    assert "created_at" in saved and saved["created_at"]
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pytest tests/test_sessions_api.py::test_session_persists_role_and_created_at -v`
Expected: FAIL with `KeyError: 'role'` (role is not persisted yet).

- [ ] **Step 3: Persist the two fields**

In `backend/main.py`, inside the `session()` handler, find the existing block that creates the session id and saves:

```python
    session_id = datetime.now().strftime("%Y-%m-%dT%H%M%S")
    save_session(os.path.join(SESSIONS_DIR, session_id),
                 req.frames, req.transcript, summary, coaching)
```

Change it to (add the two `summary[...]` lines between them):

```python
    session_id = datetime.now().strftime("%Y-%m-%dT%H%M%S")
    summary["role"] = req.role
    summary["created_at"] = datetime.strptime(session_id, "%Y-%m-%dT%H%M%S").isoformat()
    save_session(os.path.join(SESSIONS_DIR, session_id),
                 req.frames, req.transcript, summary, coaching)
```

(`datetime` is already imported at the top of `main.py`.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `pytest tests/test_sessions_api.py::test_session_persists_role_and_created_at -v`
Expected: PASS.

- [ ] **Step 5: Run the full existing suite to confirm no regression**

Run: `pytest tests/test_main.py -q`
Expected: all existing tests still PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/main.py tests/test_sessions_api.py
git commit -m "feat(api): persist role and created_at into saved sessions"
```

---

## Task 2: `sessions_store` module (filesystem read-back logic)

**Files:**
- Create: `backend/sessions_store.py`
- Test: `tests/test_sessions_store.py`

- [ ] **Step 1: Write the failing tests**

Create `tests/test_sessions_store.py` with exactly this content:

```python
import json
import os
from backend import sessions_store


def _make_session(root, sid, role="Software Engineer", scores=None, questions=2, label=None):
    d = os.path.join(root, sid)
    os.makedirs(d, exist_ok=True)
    scores = scores or {"attention": 70, "confidence": 65, "nervousness": 30, "composure": 80}
    summary = {
        "role": role,
        "duration_sec": 52.4,
        "overall": scores,
        "per_question": [{"turn": i} for i in range(questions)],
    }
    if label is not None:
        summary["label"] = label
    with open(os.path.join(d, "summary.json"), "w") as fh:
        json.dump(summary, fh)
    return d


def test_list_sessions_newest_first(tmp_path):
    root = str(tmp_path)
    _make_session(root, "2026-06-01T100000", role="A")
    _make_session(root, "2026-06-03T100000", role="B")
    rows = sessions_store.list_sessions(root)
    assert [r["id"] for r in rows] == ["2026-06-03T100000", "2026-06-01T100000"]
    assert rows[0]["role"] == "B"
    assert rows[0]["question_count"] == 2
    assert rows[0]["scores"]["attention"] == 70
    assert rows[0]["created_at"] == "2026-06-03T10:00:00"


def test_list_skips_non_session_dirs_and_bad_json(tmp_path):
    root = str(tmp_path)
    _make_session(root, "2026-06-01T100000")
    os.makedirs(os.path.join(root, "not-a-session"), exist_ok=True)        # wrong name
    bad = os.path.join(root, "2026-06-02T100000")
    os.makedirs(bad, exist_ok=True)
    with open(os.path.join(bad, "summary.json"), "w") as fh:
        fh.write("{ broken json")
    rows = sessions_store.list_sessions(root)
    assert [r["id"] for r in rows] == ["2026-06-01T100000"]


def test_list_missing_root_returns_empty(tmp_path):
    assert sessions_store.list_sessions(str(tmp_path / "nope")) == []


def test_load_session_returns_full_summary(tmp_path):
    root = str(tmp_path)
    _make_session(root, "2026-06-01T100000", role="A")
    data = sessions_store.load_session(root, "2026-06-01T100000")
    assert data["role"] == "A"
    assert data["id"] == "2026-06-01T100000"
    assert data["overall"]["confidence"] == 65


def test_load_missing_returns_none(tmp_path):
    assert sessions_store.load_session(str(tmp_path), "2026-06-01T100000") is None


def test_invalid_id_is_rejected_path_traversal(tmp_path):
    # An id that isn't a clean timestamp must never resolve to a path.
    for bad in ("../secret", "..", "foo/bar", "2026-06-01T100000/../x", ""):
        assert sessions_store.load_session(str(tmp_path), bad) is None
        assert sessions_store.delete_session(str(tmp_path), bad) is False


def test_delete_session(tmp_path):
    root = str(tmp_path)
    _make_session(root, "2026-06-01T100000")
    assert sessions_store.delete_session(root, "2026-06-01T100000") is True
    assert not os.path.exists(os.path.join(root, "2026-06-01T100000"))
    assert sessions_store.delete_session(root, "2026-06-01T100000") is False


def test_set_label_persists(tmp_path):
    root = str(tmp_path)
    _make_session(root, "2026-06-01T100000")
    updated = sessions_store.set_label(root, "2026-06-01T100000", "Mock #1")
    assert updated["label"] == "Mock #1"
    reread = sessions_store.load_session(root, "2026-06-01T100000")
    assert reread["label"] == "Mock #1"


def test_set_label_missing_returns_none(tmp_path):
    assert sessions_store.set_label(str(tmp_path), "2026-06-01T100000", "x") is None
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pytest tests/test_sessions_store.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'backend.sessions_store'`.

- [ ] **Step 3: Implement the store**

Create `backend/sessions_store.py` with exactly this content:

```python
"""Read-back access to saved interview sessions on disk.

Each session is a directory under a sessions root, named with its creation
timestamp ("%Y-%m-%dT%H%M%S") and containing a summary.json.
"""
import json
import os
import re
import shutil
from datetime import datetime

# Session ids are timestamps like "2026-06-09T114547". Matching this regex both
# parses the date and blocks path traversal — no slashes, dots, or "..".
_ID_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{6}$")


def _created_at(session_id):
    """ISO-8601 creation time parsed from the id, or None if unparseable."""
    try:
        return datetime.strptime(session_id, "%Y-%m-%dT%H%M%S").isoformat()
    except ValueError:
        return None


def _safe_dir(sessions_dir, session_id):
    """Absolute path to a session dir, or None if the id is invalid or absent.
    Rejecting anything that isn't a plain session id prevents path traversal."""
    if not session_id or not _ID_RE.match(session_id):
        return None
    path = os.path.join(sessions_dir, session_id)
    return path if os.path.isdir(path) else None


def _read_summary(path):
    try:
        with open(os.path.join(path, "summary.json"), encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return None


def list_sessions(sessions_dir):
    """All sessions as compact rows, newest first. Skips unreadable dirs."""
    rows = []
    if not os.path.isdir(sessions_dir):
        return rows
    for name in os.listdir(sessions_dir):
        if not _ID_RE.match(name):
            continue
        summary = _read_summary(os.path.join(sessions_dir, name))
        if summary is None:
            continue
        overall = summary.get("overall") or {}
        rows.append({
            "id": name,
            "created_at": _created_at(name),
            "role": summary.get("role"),
            "label": summary.get("label"),
            "duration_sec": summary.get("duration_sec"),
            "question_count": len(summary.get("per_question") or []),
            "scores": {
                "attention": overall.get("attention"),
                "confidence": overall.get("confidence"),
                "nervousness": overall.get("nervousness"),
                "composure": overall.get("composure"),
            },
        })
    rows.sort(key=lambda r: r["id"], reverse=True)
    return rows


def load_session(sessions_dir, session_id):
    """Full summary.json for one session (plus derived id/created_at), or None."""
    path = _safe_dir(sessions_dir, session_id)
    if path is None:
        return None
    summary = _read_summary(path)
    if summary is None:
        return None
    summary.setdefault("id", session_id)
    summary.setdefault("created_at", _created_at(session_id))
    return summary


def delete_session(sessions_dir, session_id):
    """Delete a session dir. True if removed, False if id invalid or absent."""
    path = _safe_dir(sessions_dir, session_id)
    if path is None:
        return False
    shutil.rmtree(path)
    return True


def set_label(sessions_dir, session_id, label):
    """Persist a friendly label into summary.json. Returns updated summary, or
    None if the session does not exist."""
    path = _safe_dir(sessions_dir, session_id)
    if path is None:
        return None
    summary = _read_summary(path)
    if summary is None:
        return None
    summary["label"] = label
    with open(os.path.join(path, "summary.json"), "w", encoding="utf-8") as fh:
        json.dump(summary, fh, indent=2)
    return summary
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pytest tests/test_sessions_store.py -v`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/sessions_store.py tests/test_sessions_store.py
git commit -m "feat(api): add sessions_store read-back module with id validation"
```

---

## Task 3: `/api/sessions` endpoints

**Files:**
- Modify: `backend/main.py` (add four routes; add one Pydantic model)
- Test: `tests/test_sessions_api.py` (append endpoint tests)

- [ ] **Step 1: Write the failing tests**

Append the following to `tests/test_sessions_api.py` (keep the existing content from Task 1; `json` and `os` are already imported at the top from Task 1).

```python
def _seed(tmp_path, sid, role="Software Engineer"):
    d = os.path.join(str(tmp_path), sid)
    os.makedirs(d, exist_ok=True)
    summary = {"role": role, "duration_sec": 30.0,
               "overall": {"attention": 70, "confidence": 65,
                           "nervousness": 30, "composure": 80},
               "per_question": [{"turn": 0}, {"turn": 1}]}
    with open(os.path.join(d, "summary.json"), "w") as fh:
        json.dump(summary, fh)


def test_list_endpoint(monkeypatch, tmp_path):
    monkeypatch.setattr("backend.main.SESSIONS_DIR", str(tmp_path))
    _seed(tmp_path, "2026-06-01T100000", role="A")
    _seed(tmp_path, "2026-06-02T100000", role="B")
    data = client.get("/api/sessions").json()
    assert [s["id"] for s in data["sessions"]] == ["2026-06-02T100000", "2026-06-01T100000"]
    assert data["sessions"][0]["role"] == "B"


def test_get_endpoint(monkeypatch, tmp_path):
    monkeypatch.setattr("backend.main.SESSIONS_DIR", str(tmp_path))
    _seed(tmp_path, "2026-06-01T100000", role="A")
    data = client.get("/api/sessions/2026-06-01T100000").json()
    assert data["role"] == "A"
    assert data["overall"]["confidence"] == 65


def test_get_missing_returns_404(monkeypatch, tmp_path):
    monkeypatch.setattr("backend.main.SESSIONS_DIR", str(tmp_path))
    assert client.get("/api/sessions/2026-06-01T100000").status_code == 404


def test_get_invalid_id_returns_404(monkeypatch, tmp_path):
    monkeypatch.setattr("backend.main.SESSIONS_DIR", str(tmp_path))
    # A non-timestamp id must not resolve to any file (path-traversal guard).
    assert client.get("/api/sessions/not-a-real-id").status_code == 404


def test_delete_endpoint(monkeypatch, tmp_path):
    monkeypatch.setattr("backend.main.SESSIONS_DIR", str(tmp_path))
    _seed(tmp_path, "2026-06-01T100000")
    assert client.delete("/api/sessions/2026-06-01T100000").status_code == 200
    assert client.get("/api/sessions/2026-06-01T100000").status_code == 404
    assert client.delete("/api/sessions/2026-06-01T100000").status_code == 404


def test_rename_endpoint(monkeypatch, tmp_path):
    monkeypatch.setattr("backend.main.SESSIONS_DIR", str(tmp_path))
    _seed(tmp_path, "2026-06-01T100000")
    resp = client.patch("/api/sessions/2026-06-01T100000", json={"label": "Mock #1"})
    assert resp.status_code == 200
    assert resp.json()["label"] == "Mock #1"
    assert client.get("/api/sessions/2026-06-01T100000").json()["label"] == "Mock #1"
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pytest tests/test_sessions_api.py -v`
Expected: the new tests FAIL (404 for routes that don't exist yet / `405` or missing). The Task 1 test still passes.

- [ ] **Step 3: Add the endpoints**

In `backend/main.py`:

(a) Add this import near the other `from backend import ...` lines at the top:

```python
from backend import sessions_store
```

(b) Add this Pydantic model near the other model classes (e.g. after `SessionRequest`):

```python
class LabelRequest(BaseModel):
    label: str
```

(c) Add these four routes in the routes section — **above** the `app.mount("/sessions", ...)` line near the bottom of the file (so the `/api` routes are registered before the static mounts):

```python
@app.get("/api/sessions")
def list_sessions_endpoint():
    return {"sessions": sessions_store.list_sessions(SESSIONS_DIR)}


@app.get("/api/sessions/{session_id}")
def get_session_endpoint(session_id: str):
    data = sessions_store.load_session(SESSIONS_DIR, session_id)
    if data is None:
        raise HTTPException(404, "session not found")
    return data


@app.delete("/api/sessions/{session_id}")
def delete_session_endpoint(session_id: str):
    if not sessions_store.delete_session(SESSIONS_DIR, session_id):
        raise HTTPException(404, "session not found")
    return {"deleted": session_id}


@app.patch("/api/sessions/{session_id}")
def rename_session_endpoint(session_id: str, req: LabelRequest):
    data = sessions_store.set_label(SESSIONS_DIR, session_id, req.label)
    if data is None:
        raise HTTPException(404, "session not found")
    return data
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pytest tests/test_sessions_api.py -v`
Expected: all PASS (Task 1 test + the six endpoint tests).

- [ ] **Step 5: Run the whole suite**

Run: `pytest -q`
Expected: every test passes (Phase 1 `test_shell.py`, existing `test_main.py` etc., and the new Phase 2 tests).

- [ ] **Step 6: Commit**

```bash
git add backend/main.py tests/test_sessions_api.py
git commit -m "feat(api): add list/get/delete/rename session endpoints"
```

---

## Phase 2 Done — Definition of Done

- `GET /api/sessions` returns all sessions (newest first) with id, created_at, role, label, duration, question count, and the four scores.
- `GET /api/sessions/{id}` returns one full session summary (404 on missing/invalid id).
- `DELETE /api/sessions/{id}` removes a session (404 on missing/invalid id).
- `PATCH /api/sessions/{id}` sets a friendly label.
- New sessions persist `role` and `created_at`. Invalid/path-traversal ids are rejected.
- `pytest -q` is green across the whole suite.

**Next:** Plan 3 — build the real Dashboard, History, and rewired Session Report screens (Clean Studio), consuming these endpoints via `frontend/api.js`, with client-side SVG charts (timeline from `emotion_mediapipe.timeline` / per-question scores, and the score/emotion displays from `summary.overall` and `emotion_mediapipe.overall_distribution`).
```
