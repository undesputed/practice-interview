# tests/test_verdict.py
"""Unit tests for the fused readiness rubric."""
from backend import verdict


def test_presence_score_mean_of_composites():
    overall = {"attention": 80, "confidence": 72, "composure": 64, "nervousness": 20}
    # mean(80, 72, 64, 100-20=80) = 296/4 = 74
    assert verdict.presence_score(overall) == 74


def test_presence_score_missing_returns_none():
    assert verdict.presence_score({}) is None
    assert verdict.presence_score(None) is None


def test_band_cutoffs():
    assert verdict.band(70) == "ready"
    assert verdict.band(69) == "almost"
    assert verdict.band(50) == "almost"
    assert verdict.band(49) == "needs_work"


def test_compute_readiness_full():
    r = verdict.compute_readiness(80, 60, 40)   # .40*80 + .35*60 + .25*40 = 63
    assert r["readiness_score"] == 63
    assert r["band"] == "almost"
    assert r["components"] == {"delivery": 80, "presence": 60, "content": 40}
    assert set(r["weights_used"]) == {"delivery", "presence", "content"}


def test_compute_readiness_reweights_when_content_missing():
    r = verdict.compute_readiness(80, 60, None)
    # (.40/.75)*80 + (.35/.75)*60 = 42.667 + 28 = 70.667 -> 71
    assert r["readiness_score"] == 71
    assert r["band"] == "ready"
    assert set(r["weights_used"]) == {"delivery", "presence"}
    assert r["components"]["content"] is None


def test_compute_readiness_presence_only():
    r = verdict.compute_readiness(None, 55, None)
    assert r["readiness_score"] == 55
    assert r["band"] == "almost"
    assert set(r["weights_used"]) == {"presence"}


def test_compute_readiness_all_missing():
    r = verdict.compute_readiness(None, None, None)
    assert r["readiness_score"] is None
    assert r["band"] is None
    assert r["weights_used"] == {}


def test_parse_verdict_extracts_fields():
    from backend import anthropic_coach
    raw = ('```json\n{"content_score": 72, "headline": "Almost there",'
           ' "delivery_note": "Good pace", "presence_note": "Steady",'
           ' "content_note": "Add specifics", "strengths": ["clear"],'
           ' "improvements": ["more detail"], "next_action": "Practice STAR"}\n```')
    v = anthropic_coach.parse_verdict(raw)
    assert v["content_score"] == 72
    assert v["headline"] == "Almost there"
    assert v["strengths"] == ["clear"]
    assert v["next_action"] == "Practice STAR"


def test_parse_verdict_bad_input_defaults():
    from backend import anthropic_coach
    v = anthropic_coach.parse_verdict("not json at all")
    assert v["content_score"] is None
    assert v["strengths"] == [] and v["improvements"] == []
