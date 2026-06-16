# tests/test_session.py
"""Contract test for POST /api/session.

Pins the frame / transcript / event shape the frontend (interview-engine.js +
live.js) must send. If this passes, the new live flow's payload will score.
"""
import shutil
import os

from fastapi.testclient import TestClient

from backend.main import app, SESSIONS_DIR
from backend import sessions_store

client = TestClient(app)

# The full blendshape set the frontend sends (mirrors frontend/config.js BLENDSHAPES).
BLENDSHAPES = [
    "mouthSmileLeft", "mouthSmileRight", "eyeBlinkLeft", "eyeBlinkRight", "browInnerUp",
    "eyeLookInLeft", "eyeLookInRight", "eyeLookOutLeft", "eyeLookOutRight",
    "eyeLookUpLeft", "eyeLookUpRight", "eyeLookDownLeft", "eyeLookDownRight",
    "jawOpen", "browOuterUpLeft", "browOuterUpRight",
    "eyeSquintLeft", "eyeSquintRight", "mouthPressLeft", "mouthPressRight",
    "browDownLeft", "browDownRight", "jawLeft", "jawRight",
    "noseSneerLeft", "noseSneerRight", "mouthFrownLeft", "mouthFrownRight",
    "cheekSquintLeft", "cheekSquintRight", "mouthUpperUpLeft", "mouthUpperUpRight",
    "eyeWideLeft", "eyeWideRight", "mouthStretchLeft", "mouthStretchRight",
]
IDENTITY_M = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]  # 4x4 row-major identity (MediaPipe transform matrix)


def _bs(value=0.0):
    return {k: value for k in BLENDSHAPES}


def _make_payload():
    # Two questions' worth of frames; turn advances as the interviewer speaks.
    frames = []
    for i in range(60):
        turn = 0 if i < 30 else 1
        frame = {
            "t": float(i * 33),
            "turn": turn,
            "face": True,
            "face_count": 1,
            "bs": _bs(0.1),
            "m": IDENTITY_M,
        }
        # Heavy detectors attach only on "throttled" frames (every ~4th here).
        if i % 4 == 0:
            frame["pose"] = None
            frame["hands"] = None
            frame["objects"] = None
        frames.append(frame)

    segments = [
        {"speaker": "interviewer", "text": "Tell me about yourself.", "t": 0.0},
        {"speaker": "candidate", "text": "I am a software engineer with five years of experience.", "t": 2000.0},
        {"speaker": "interviewer", "text": "Describe a hard problem you solved.", "t": 10000.0},
        {"speaker": "candidate", "text": "I optimized a slow data pipeline and cut its runtime in half.", "t": 12000.0},
    ]
    full_text = "\n".join(
        ("INTERVIEWER: " if s["speaker"] == "interviewer" else "CANDIDATE: ") + s["text"]
        for s in segments
    )
    return {
        "role": "Software Engineer",
        "frames": frames,
        "transcript": {"full_text": full_text, "segments": segments},
        "events": [],
        "emotion": None,
    }


def test_session_creates_report_with_expected_shape():
    payload = _make_payload()
    res = client.post("/api/session", json=payload)
    assert res.status_code == 200, res.text
    body = res.json()
    session_id = body["session_id"]
    try:
        assert "summary" in body
        summary = body["summary"]
        for key in ("overall", "per_question", "timing", "integrity", "actions", "emotion", "emotion_mediapipe"):
            assert key in summary, f"missing summary key: {key}"
        assert body["charts_url"] == f"/sessions/{session_id}/charts.png"
        assert os.path.exists(os.path.join(SESSIONS_DIR, session_id, "charts.png"))
    finally:
        sessions_store.delete_session(SESSIONS_DIR, session_id)


def test_session_rejects_empty_frames():
    payload = _make_payload()
    payload["frames"] = []
    res = client.post("/api/session", json=payload)
    assert res.status_code == 400
