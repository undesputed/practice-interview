# tests/test_sessions_readiness.py
"""list_sessions should surface each session's readiness (score + band)."""
import json

from backend import sessions_store


def _write(tmp_path, sid, summary):
    d = tmp_path / sid
    d.mkdir()
    (d / "summary.json").write_text(json.dumps(summary), encoding="utf-8")


def test_list_sessions_includes_readiness(tmp_path):
    _write(tmp_path, "2026-06-16T120000", {
        "role": "Software Engineer", "per_question": [],
        "overall": {"attention": 80, "confidence": 70, "composure": 60, "nervousness": 20},
        "verdict": {"readiness_score": 72, "band": "ready"},
    })
    rows = sessions_store.list_sessions(str(tmp_path))
    assert len(rows) == 1
    assert rows[0]["readiness"] == {"score": 72, "band": "ready"}


def test_list_sessions_readiness_none_when_no_verdict(tmp_path):
    _write(tmp_path, "2026-06-16T120001", {"role": "X", "per_question": [], "overall": {}})
    rows = sessions_store.list_sessions(str(tmp_path))
    assert rows[0]["readiness"] == {"score": None, "band": None}
