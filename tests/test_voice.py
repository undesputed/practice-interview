# tests/test_voice.py
"""Unit tests for voice prosody measurement and Delivery scoring (no network)."""
from backend import voice


def _word(text, start_s, end_s):
    return {"word": text, "punctuated_word": text, "start": start_s, "end": end_s}


def test_parse_words_prefers_punctuated_and_converts_ms():
    raw = {"results": {"channels": [{"alternatives": [{"words": [
        {"word": "hello", "punctuated_word": "Hello", "start": 0.0, "end": 0.5},
        {"word": "world", "punctuated_word": "world.", "start": 0.6, "end": 1.0},
    ]}]}]}}
    words = voice.parse_words(raw)
    assert [w["text"] for w in words] == ["Hello", "world."]
    assert words[0]["start_ms"] == 0 and words[0]["end_ms"] == 500


def test_measure_prosody_counts_pace_pauses_fillers():
    words = [
        {"text": "I", "start_ms": 0, "end_ms": 200},
        {"text": "um", "start_ms": 250, "end_ms": 450},
        {"text": "think", "start_ms": 500, "end_ms": 900},
        {"text": "so", "start_ms": 2500, "end_ms": 2700},
        {"text": "really", "start_ms": 2750, "end_ms": 3000},
        {"text": "yes", "start_ms": 3000, "end_ms": 3000},
    ]
    p = voice.measure_prosody(words)
    assert p["word_count"] == 6
    assert p["filler_count"] == 1
    assert p["long_pause_count"] == 1
    assert p["pause_count"] >= 1
    assert 110 <= p["wpm"] <= 130
    assert round(p["filler_rate_per100"], 1) == round(100 / 6, 1)


def test_measure_prosody_empty():
    p = voice.measure_prosody([])
    assert p["word_count"] == 0 and p["wpm"] == 0 and p["filler_count"] == 0


def test_delivery_score_good_delivery_is_high():
    prosody = {"wpm": 135, "filler_rate_per100": 1.0, "long_pause_count": 1,
               "word_count": 200, "pause_count": 3, "avg_pause_ms": 400,
               "filler_count": 2, "talk_time_s": 90.0}
    acoustic = {"pitchStdHz": 30.0, "energyMean": 0.05, "voicedRatio": 0.6,
                "pitchMeanHz": 140.0, "energyStd": 0.02}
    r = voice.compute_delivery(prosody, acoustic)
    assert r["available"] is True
    assert r["delivery_score"] >= 75
    keys = {b["key"] for b in r["breakdown"]}
    assert keys == {"pace", "fillers", "pauses", "pitch", "energy"}


def test_delivery_score_poor_delivery_is_low():
    prosody = {"wpm": 250, "filler_rate_per100": 14.0, "long_pause_count": 9,
               "word_count": 50, "pause_count": 12, "avg_pause_ms": 1800,
               "filler_count": 7, "talk_time_s": 20.0}
    acoustic = {"pitchStdHz": 4.0, "energyMean": 0.001, "voicedRatio": 0.2,
                "pitchMeanHz": 120.0, "energyStd": 0.001}
    r = voice.compute_delivery(prosody, acoustic)
    assert r["delivery_score"] <= 40


def test_delivery_score_weights_sum_to_one():
    assert abs(sum(w for w in voice.DELIVERY_WEIGHTS.values()) - 1.0) < 1e-9


def test_delivery_reweights_without_acoustic():
    prosody = {"wpm": 135, "filler_rate_per100": 1.0, "long_pause_count": 1,
               "word_count": 200, "pause_count": 3, "avg_pause_ms": 400,
               "filler_count": 2, "talk_time_s": 90.0}
    r = voice.compute_delivery(prosody, {})
    assert r["available"] is True
    assert isinstance(r["delivery_score"], int)
    assert {b["key"] for b in r["breakdown"]} == {"pace", "fillers", "pauses"}
    assert r["delivery_score"] >= 70           # good prosody, reweighted, not penalized
    assert isinstance(voice.compute_delivery(prosody, None)["delivery_score"], int)  # None must not raise
