import math
import httpx
from fastapi.testclient import TestClient
from backend.main import app

client = TestClient(app)


def _raise_grant_403(*_a, **_k):
    req = httpx.Request("POST", "https://api.deepgram.com/v1/auth/grant")
    raise httpx.HTTPStatusError("403", request=req, response=httpx.Response(403, request=req))


def test_token_uses_bearer_scheme_for_ephemeral(monkeypatch):
    import backend.main as main
    monkeypatch.setenv("DEEPGRAM_API_KEY", "rawkey")

    async def fake_grant(_key, ttl_seconds=300):
        return "eph-token"
    monkeypatch.setattr(main, "grant_ephemeral_token", fake_grant)

    data = client.post("/api/interview/token", json={"role": "X"}).json()
    assert data["token"] == "eph-token"
    assert data["scheme"] == "bearer"   # ephemeral tokens MUST use the bearer subprotocol


def test_token_uses_token_scheme_on_browser_key_fallback(monkeypatch):
    import backend.main as main
    monkeypatch.setenv("DEEPGRAM_API_KEY", "rawkey")
    monkeypatch.setenv("DEEPGRAM_ALLOW_BROWSER_KEY", "1")
    monkeypatch.setattr(main, "grant_ephemeral_token", _raise_grant_403)

    data = client.post("/api/interview/token", json={"role": "X"}).json()
    assert data["token"] == "rawkey"
    assert data["scheme"] == "token"   # a raw API key uses the token subprotocol

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

def test_session_summary_has_timing(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "")
    body = {"role": "X", "frames": [_frame(i*100.0) for i in range(5)],
            "transcript": {"full_text": "INTERVIEWER: hi",
                           "segments": [{"speaker": "interviewer", "text": "hi", "t": 0.0},
                                        {"speaker": "candidate", "text": "yo", "t": 1500.0}]}}
    data = client.post("/api/session", json=body).json()
    assert "timing" in data["summary"]
    assert data["summary"]["timing"]["per_question_response_sec"] == [1.5]
