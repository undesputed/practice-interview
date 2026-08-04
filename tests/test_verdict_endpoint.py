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
    def _fake_verdict(api_key, text, role, delivery_score=None, presence_score=None,
                      scenario="job", language="en"):
        assert delivery_score == 80
        return {"content_score": 60, "headline": "Almost there", "delivery_note": "",
                "presence_note": "", "content_note": "", "strengths": ["a"],
                "improvements": ["b"], "next_action": "c"}
    monkeypatch.setattr(main, "generate_verdict", _fake_verdict)
    monkeypatch.setattr(main, "generate_coaching",
                        lambda *a, **k: {"summary": "", "strengths": [],
                                         "improvements": [], "score": None, "rationale": ""})
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


def test_session_verdict_degrades_when_claude_raises(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    monkeypatch.setattr(main, "generate_coaching", lambda *a, **k: None)
    def _boom(api_key, text, role, delivery_score=None, presence_score=None,
              scenario="job", language="en"):
        raise RuntimeError("anthropic 401")
    monkeypatch.setattr(main, "generate_verdict", _boom)
    res = client.post("/api/session", json=_payload())
    assert res.status_code == 200, res.text          # session still succeeds
    sid = res.json()["session_id"]
    try:
        v = res.json()["summary"]["verdict"]
        assert v["components"]["content"] is None     # verdict degraded to delivery+presence
        assert v["components"]["delivery"] == 80
        assert isinstance(v["readiness_score"], int)
    finally:
        sessions_store.delete_session(SESSIONS_DIR, sid)


def test_session_verdict_without_anthropic_key(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    res = client.post("/api/session", json=_payload())
    assert res.status_code == 200, res.text
    sid = res.json()["session_id"]
    try:
        v = res.json()["summary"]["verdict"]
        assert v["components"]["content"] is None
        assert v["components"]["delivery"] == 80
        assert isinstance(v["readiness_score"], int)
    finally:
        sessions_store.delete_session(SESSIONS_DIR, sid)
