# tests/test_voice_endpoint.py
"""Endpoint tests for POST /api/voice and the session voice field (no network)."""
import io
import json
import os

import pytest
from fastapi.testclient import TestClient

import backend.main as main
from backend.main import app

client = TestClient(app)

FAKE_DG = {"results": {"channels": [{"alternatives": [{"words": [
    {"punctuated_word": "Hello", "word": "hello", "start": 0.0, "end": 0.4},
    {"punctuated_word": "um", "word": "um", "start": 0.5, "end": 0.7},
    {"punctuated_word": "world.", "word": "world", "start": 0.8, "end": 1.2},
]}]}]}}


@pytest.fixture
def fake_deepgram(monkeypatch):
    async def _fake(audio_bytes, content_type, api_key):
        return FAKE_DG
    monkeypatch.setattr(main.voice, "transcribe_prerecorded", _fake)
    monkeypatch.setenv("DEEPGRAM_API_KEY", "test-key")


def _post_voice():
    meta = json.dumps({"acoustic": {"pitchStdHz": 28.0, "energyMean": 0.05,
                                    "voicedRatio": 0.6, "pitchMeanHz": 140.0,
                                    "energyStd": 0.02}})
    files = {"audio": ("a.webm", io.BytesIO(b"fakeaudio"), "audio/webm")}
    return client.post("/api/voice", data={"meta": meta}, files=files)


def test_voice_endpoint_returns_delivery(fake_deepgram):
    res = _post_voice()
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["available"] is True
    assert isinstance(body["delivery_score"], int)
    assert body["metrics"]["filler_count"] == 1


def test_voice_endpoint_degrades_without_key(monkeypatch):
    monkeypatch.delenv("DEEPGRAM_API_KEY", raising=False)
    res = _post_voice()
    assert res.status_code == 200
    assert res.json() == {"available": False}


def test_voice_endpoint_degrades_when_deepgram_raises(monkeypatch):
    async def _boom(audio_bytes, content_type, api_key):
        raise RuntimeError("deepgram down")
    monkeypatch.setattr(main.voice, "transcribe_prerecorded", _boom)
    monkeypatch.setenv("DEEPGRAM_API_KEY", "test-key")
    res = _post_voice()
    assert res.status_code == 200
    assert res.json() == {"available": False}


def test_session_stores_voice_field(fake_deepgram):
    from backend.main import SESSIONS_DIR
    from backend import sessions_store
    frame = {"t": 0.0, "turn": 0, "face": True, "face_count": 1,
             "bs": {}, "m": [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]}
    voice_block = {"available": True, "delivery_score": 80, "metrics": {}, "breakdown": []}
    payload = {"role": "Software Engineer", "frames": [frame],
               "transcript": {"full_text": "", "segments": []},
               "events": [], "emotion": None, "voice": voice_block}
    res = client.post("/api/session", json=payload)
    assert res.status_code == 200, res.text
    sid = res.json()["session_id"]
    try:
        assert res.json()["summary"]["voice"]["delivery_score"] == 80
    finally:
        sessions_store.delete_session(SESSIONS_DIR, sid)
