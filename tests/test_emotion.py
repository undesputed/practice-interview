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
    # Intensity-weighted soft-mean: a strong happy shot outweighs flat one-hot
    # "neutral" shots (resting-face flood is what we intentionally reduce).
    assert out["dominant"] == "happy"
    assert out["overall_distribution"]["happy"] > out["overall_distribution"]["neutral"]
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
    # Soft-score mean: both shots carry neutral soft scores → ~100% neutral
    # (unknown dominant label is ignored; scores dictate the bars).
    assert out["overall_distribution"]["neutral"] == 100.0
    assert out["dominant"] == "neutral"


def test_aggregate_soft_scores_keep_secondary_emotions():
    """Winner-take-all would report 100% neutral here; soft-mean must surface happy."""
    def mixed(t, turn, neutral, happy):
        s = {c: 0.0 for c in EMOTION_CLASSES}
        s["neutral"] = neutral
        s["happy"] = happy
        return {"t": t, "turn": turn, "dominant": "neutral", "scores": s}

    shots = [
        mixed(0.0, 0, 55.0, 45.0),
        mixed(100.0, 0, 60.0, 40.0),
        mixed(200.0, 0, 50.0, 50.0),
    ]
    out = aggregate_emotions(shots)
    assert out["available"] is True
    # Neutral still leads, but happy must remain clearly visible (not wiped to 0).
    assert out["overall_distribution"]["happy"] >= 35.0
    assert out["overall_distribution"]["neutral"] >= 40.0
    assert out["overall_distribution"]["happy"] + out["overall_distribution"]["neutral"] >= 95.0


def test_aggregate_expressive_frames_outweigh_resting_face():
    """A few strong happy frames should not be drowned by many flat neutral ones."""
    def one(t, scores, dominant):
        return {"t": t, "turn": 0, "dominant": dominant, "scores": scores}

    flat = {c: 0.0 for c in EMOTION_CLASSES}
    flat["neutral"] = 100.0
    smile = {c: 0.0 for c in EMOTION_CLASSES}
    smile["happy"] = 80.0
    smile["neutral"] = 20.0
    shots = [one(float(i), flat, "neutral") for i in range(20)]
    shots += [one(1000.0 + i, smile, "happy") for i in range(3)]
    out = aggregate_emotions(shots)
    assert out["overall_distribution"]["happy"] >= 25.0  # would be ~13% under uniform mean / ~13% under WTA

from backend import emotion as emotion_mod

def test_score_emotions_raises_when_hsemotion_missing(monkeypatch):
    # Simulate hsemotion-onnx not installed: building the recognizer fails.
    emotion_mod._recognizer = None
    import builtins
    real_import = builtins.__import__

    def fake_import(name, *a, **k):
        if name == "hsemotion_onnx" or name.startswith("hsemotion_onnx."):
            raise ImportError("No module named 'hsemotion_onnx'")
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


def _frame(t, turn=0):
    m = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]
    return {"t": t, "turn": turn, "face": True,
            "bs": {"mouthSmileLeft": 0.1, "mouthSmileRight": 0.1,
                   "eyeBlinkLeft": 0.0, "eyeBlinkRight": 0.0, "browInnerUp": 0.0},
            "m": m}

def test_session_includes_emotion_and_chart_url(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)  # skip coaching
    emotion_summary = {
        "available": True, "dominant": "neutral",
        "overall_distribution": {c: (100.0 if c == "neutral" else 0.0) for c in EMOTION_CLASSES},
        "per_question": [{"turn": 0, "dominant": "neutral",
                          "distribution": {c: (100.0 if c == "neutral" else 0.0) for c in EMOTION_CLASSES}}],
        "timeline": [{"t": 0.0, "turn": 0, "dominant": "neutral",
                      "scores": {c: (90.0 if c == "neutral" else 0.0) for c in EMOTION_CLASSES}}],
    }
    body = {"role": "Software Engineer",
            "frames": [_frame(i * 100.0) for i in range(5)],
            "transcript": {"full_text": "", "segments": [
                {"speaker": "interviewer", "text": "hi", "t": 0}]},
            "emotion": emotion_summary}
    resp = _client.post("/api/session", json=body)
    assert resp.status_code == 200
    data = resp.json()
    assert data["summary"]["emotion"]["dominant"] == "neutral"
    assert data["emotion_chart_url"].endswith("emotion.png")

def test_session_emotion_absent_is_unavailable(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    body = {"role": "Software Engineer",
            "frames": [_frame(0.0)],
            "transcript": {"full_text": "", "segments": []}}
    data = _client.post("/api/session", json=body).json()
    assert data["summary"]["emotion"] == {"available": False}
    assert data["emotion_chart_url"] is None

def test_emotion_frame_disabled_returns_unavailable(monkeypatch):
    monkeypatch.delenv("EMOTION_ANALYSIS", raising=False)
    resp = _client.post("/api/emotion/frame",
                        files={"image": ("crop.jpg", b"\xff\xd8\xff", "image/jpeg")})
    assert resp.status_code == 200
    assert resp.json() == {"available": False}


def test_emotion_frame_scores_when_enabled(monkeypatch):
    monkeypatch.setenv("EMOTION_ANALYSIS", "1")
    import backend.main as main
    scores = {c: 0.0 for c in EMOTION_CLASSES}
    scores["fear"] = 80.0
    monkeypatch.setattr(main, "score_emotions",
                        lambda bufs: [{"dominant": "fear", "scores": scores}])
    resp = _client.post("/api/emotion/frame",
                        files={"image": ("crop.jpg", b"x", "image/jpeg")})
    assert resp.status_code == 200
    data = resp.json()
    assert data["available"] is True
    assert data["dominant"] == "fear"
    assert data["scores"]["fear"] == 80.0


def test_emotion_frame_unavailable_when_scoring_raises(monkeypatch):
    monkeypatch.setenv("EMOTION_ANALYSIS", "1")
    import backend.main as main
    def boom(bufs):
        raise ImportError("no emotion model")
    monkeypatch.setattr(main, "score_emotions", boom)
    resp = _client.post("/api/emotion/frame",
                        files={"image": ("crop.jpg", b"x", "image/jpeg")})
    assert resp.json() == {"available": False}


def test_emotion_frame_unavailable_when_no_face(monkeypatch):
    monkeypatch.setenv("EMOTION_ANALYSIS", "1")
    import backend.main as main
    monkeypatch.setattr(main, "score_emotions", lambda bufs: [None])
    resp = _client.post("/api/emotion/frame",
                        files={"image": ("crop.jpg", b"x", "image/jpeg")})
    assert resp.json() == {"available": False}


def test_session_includes_mediapipe_emotion(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)  # skip coaching

    def happy_frame(t):
        return {"t": t, "turn": 0, "face": True,
                "bs": {"mouthSmileLeft": 0.9, "mouthSmileRight": 0.9,
                       "cheekSquintLeft": 0.7, "cheekSquintRight": 0.7},
                "m": [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]}

    body = {"role": "Software Engineer",
            "frames": [happy_frame(i * 100.0) for i in range(5)],
            "transcript": {"full_text": "", "segments": [
                {"speaker": "interviewer", "text": "hi", "t": 0}]}}
    data = _client.post("/api/session", json=body).json()

    mp = data["summary"]["emotion_mediapipe"]
    assert mp["available"] is True
    assert mp["dominant"] == "happy"
    assert data["emotion_mediapipe_chart_url"].endswith("emotion_mediapipe.png")
    # DeepFace track is independent and absent (no crops sent here)
    assert data["summary"]["emotion"] == {"available": False}
    assert data["emotion_chart_url"] is None
