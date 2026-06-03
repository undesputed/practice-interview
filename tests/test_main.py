import math
from fastapi.testclient import TestClient
from backend.main import app

client = TestClient(app)

def _frame(t, turn=0):
    m = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]
    return {"t": t, "turn": turn, "face": True,
            "bs": {"mouthSmileLeft": 0.1, "mouthSmileRight": 0.1,
                   "eyeBlinkLeft": 0.0, "eyeBlinkRight": 0.0, "browInnerUp": 0.0},
            "m": m}

def test_session_endpoint_returns_summary(monkeypatch):
    # avoid a real Anthropic call
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    import backend.main as main
    monkeypatch.setattr(main, "generate_coaching",
                        lambda *a, **k: {"summary": "ok", "strengths": [], "improvements": [],
                                         "score": 8, "rationale": ""})
    body = {"role": "Software Engineer",
            "frames": [_frame(i * 100.0) for i in range(10)],
            "transcript": {"full_text": "INTERVIEWER: hi", "segments": [
                {"speaker": "interviewer", "text": "hi", "t": 0}]}}
    resp = client.post("/api/session", json=body)
    assert resp.status_code == 200
    data = resp.json()
    assert data["summary"]["frame_count"] == 10
    assert data["coaching"]["score"] == 8
    assert data["charts_url"].endswith("charts.png")

def test_session_empty_frames_returns_422_or_message():
    body = {"role": "X", "frames": [], "transcript": {"full_text": "", "segments": []}}
    resp = client.post("/api/session", json=body)
    assert resp.status_code == 400
