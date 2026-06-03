from backend.anthropic_coach import parse_coaching

def test_parse_coaching_valid_json():
    raw = ('{"summary":"Solid answers.","strengths":["clear"],'
           '"improvements":["more detail"],"score":7,"rationale":"good structure"}')
    out = parse_coaching(raw)
    assert out["score"] == 7
    assert out["strengths"] == ["clear"]

def test_parse_coaching_handles_fenced_json():
    raw = "```json\n{\"summary\":\"x\",\"strengths\":[],\"improvements\":[],\"score\":5,\"rationale\":\"y\"}\n```"
    out = parse_coaching(raw)
    assert out["score"] == 5

def test_parse_coaching_bad_input_returns_fallback():
    out = parse_coaching("not json at all")
    assert out["score"] is None
    assert "summary" in out
