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
