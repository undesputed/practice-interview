from backend.emotion import aggregate_emotions, EMOTION_CLASSES

def _scores(dominant):
    s = {c: 0.0 for c in EMOTION_CLASSES}
    s[dominant] = 90.0
    return s

def _shot(t, turn, dominant):
    return {"t": t, "turn": turn, "dominant": dominant, "scores": _scores(dominant)}

def test_aggregate_empty_is_unavailable():
    assert aggregate_emotions([]) == {"available": False}

def test_aggregate_overall_and_per_question():
    shots = [
        _shot(0.0, 0, "neutral"), _shot(100.0, 0, "happy"),
        _shot(200.0, 1, "neutral"), _shot(300.0, 1, "neutral"),
    ]
    out = aggregate_emotions(shots)
    assert out["available"] is True
    assert out["dominant"] == "neutral"                      # 3 of 4 shots
    assert out["overall_distribution"]["neutral"] == 75.0
    assert out["overall_distribution"]["happy"] == 25.0
    assert [q["turn"] for q in out["per_question"]] == [0, 1]
    assert out["per_question"][1]["dominant"] == "neutral"   # both turn-1 shots neutral
    assert out["per_question"][1]["distribution"]["neutral"] == 100.0
    assert [s["t"] for s in out["timeline"]] == [0.0, 100.0, 200.0, 300.0]

def test_aggregate_timeline_is_time_sorted():
    shots = [_shot(300.0, 1, "sad"), _shot(0.0, 0, "happy")]
    out = aggregate_emotions(shots)
    assert [s["t"] for s in out["timeline"]] == [0.0, 300.0]

def test_aggregate_ignores_unknown_dominant_class():
    shots = [_shot(0.0, 0, "neutral"),
             {"t": 100.0, "turn": 0, "dominant": "contempt", "scores": _scores("neutral")}]
    out = aggregate_emotions(shots)
    assert out["available"] is True
    assert "contempt" not in out["overall_distribution"]
    assert out["overall_distribution"]["neutral"] == 50.0  # 1 of 2 shots; unknown still counts in denominator

from backend import emotion as emotion_mod

def test_score_emotions_raises_when_deepface_missing(monkeypatch):
    # Simulate DeepFace not installed: the lazy import inside score_emotions fails.
    import builtins
    real_import = builtins.__import__

    def fake_import(name, *a, **k):
        if name == "deepface" or name.startswith("deepface."):
            raise ImportError("No module named 'deepface'")
        return real_import(name, *a, **k)

    monkeypatch.setattr(builtins, "__import__", fake_import)
    import pytest
    with pytest.raises(ImportError):
        emotion_mod.score_emotions([b"not-a-real-jpeg"])

import json
from fastapi.testclient import TestClient
from backend.main import app

_client = TestClient(app)

def _canned_scores(dominant):
    s = {c: 0.0 for c in EMOTION_CLASSES}
    s[dominant] = 88.0
    return {"dominant": dominant, "scores": s}

def test_emotion_endpoint_disabled_returns_unavailable(monkeypatch):
    monkeypatch.delenv("EMOTION_ANALYSIS", raising=False)
    files = [("images", ("f.jpg", b"x", "image/jpeg"))]
    data = {"meta": json.dumps([{"t": 0.0, "turn": 0}])}
    resp = _client.post("/api/emotion", data=data, files=files)
    assert resp.status_code == 200
    assert resp.json() == {"available": False}

def test_emotion_endpoint_aggregates_when_enabled(monkeypatch):
    monkeypatch.setenv("EMOTION_ANALYSIS", "1")
    import backend.main as main
    monkeypatch.setattr(main, "score_emotions",
                        lambda bufs: [_canned_scores("happy") for _ in bufs])
    files = [("images", ("a.jpg", b"x", "image/jpeg")),
             ("images", ("b.jpg", b"y", "image/jpeg"))]
    data = {"meta": json.dumps([{"t": 0.0, "turn": 0}, {"t": 100.0, "turn": 0}])}
    resp = _client.post("/api/emotion", data=data, files=files)
    assert resp.status_code == 200
    out = resp.json()
    assert out["available"] is True
    assert out["dominant"] == "happy"
    assert out["overall_distribution"]["happy"] == 100.0

def test_emotion_endpoint_unavailable_when_scoring_raises(monkeypatch):
    monkeypatch.setenv("EMOTION_ANALYSIS", "1")
    import backend.main as main
    def boom(_bufs):
        raise ImportError("no deepface")
    monkeypatch.setattr(main, "score_emotions", boom)
    files = [("images", ("a.jpg", b"x", "image/jpeg"))]
    data = {"meta": json.dumps([{"t": 0.0, "turn": 0}])}
    resp = _client.post("/api/emotion", data=data, files=files)
    assert resp.json() == {"available": False}
