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
