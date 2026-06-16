# tests/test_questions.py
"""Tests for AI question generation + binding it into the interview."""
import backend.main as main
from backend.main import app
from backend import questions
from backend.deepgram import build_interviewer_prompt, build_greeting, build_agent_config
from fastapi.testclient import TestClient

client = TestClient(app)


def test_parse_questions_array():
    assert questions.parse_questions('["a","b","c"]') == ["a", "b", "c"]
    assert questions.parse_questions('```json\n["x", "y"]\n```') == ["x", "y"]


def test_parse_questions_bad_input():
    assert questions.parse_questions("not json") == []
    assert questions.parse_questions('{"a":1}') == []
    assert questions.parse_questions('["", "  ", "ok"]') == ["ok"]
    assert questions.parse_questions(None) == []          # None must not crash
    assert questions.parse_questions('[1, null, "ok"]') == ["ok"]   # non-strings dropped


def test_prompt_with_questions_lists_them_in_order():
    p = build_interviewer_prompt("Software Engineer",
                                 questions=["What is a closure?", "Describe a hard bug."])
    assert "1) What is a closure?" in p
    assert "2) Describe a hard bug." in p
    assert "these exact questions" in p
    assert "end_interview" in p


def test_prompt_without_questions_keeps_improvise_framing():
    p = build_interviewer_prompt("Software Engineer", question_count=5)
    assert "exactly 5 questions" in p
    assert "already in progress" in p


def test_greeting_with_questions_omits_self_intro():
    g = build_greeting("Software Engineer", has_questions=True).lower()
    assert "tell me a little about yourself" not in g
    assert "interview" in g


def test_agent_config_binds_questions():
    cfg = build_agent_config("Software Engineer", questions=["Q one", "Q two"])
    prompt = cfg["agent"]["think"]["prompt"]
    assert "Q one" in prompt and "Q two" in prompt
    assert "tell me a little about yourself" not in cfg["agent"]["greeting"].lower()


def test_questions_endpoint_returns_list(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    monkeypatch.setattr(main, "generate_questions",
                        lambda key, role, focus, difficulty, n: ["Q1", "Q2"])
    res = client.post("/api/questions", json={"role": "Software Engineer", "focus": "Mixed",
                                              "difficulty": "Realistic", "question_count": 2})
    assert res.status_code == 200
    assert res.json()["questions"] == ["Q1", "Q2"]


def test_questions_endpoint_no_key(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    res = client.post("/api/questions", json={"role": "Software Engineer"})
    assert res.status_code == 200
    assert res.json() == {"questions": []}


def test_questions_endpoint_degrades_on_error(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    def _boom(*a, **k): raise RuntimeError("anthropic down")
    monkeypatch.setattr(main, "generate_questions", _boom)
    res = client.post("/api/questions", json={"role": "Software Engineer"})
    assert res.status_code == 200
    assert res.json() == {"questions": []}
