# tests/test_facs.py
"""Tests for the broadened FACS emotion model."""
from backend import analysis


def test_au_value_averages_present_keys_and_single():
    bs = {"mouthDimpleLeft": 0.4, "mouthDimpleRight": 0.6, "mouthClose": 0.5}
    assert analysis._au_value(bs, ["mouthDimpleLeft", "mouthDimpleRight"]) == 0.5
    assert analysis._au_value(bs, ["mouthClose"]) == 0.5
    assert analysis._au_value(bs, ["mouthShrugUpper", "mouthShrugLower"]) == 0.0


def test_au_map_includes_new_aus():
    for au in ("AU8", "AU14", "AU16", "AU17"):
        assert au in analysis._AU


def test_disgust_and_sadness_prototypes_completed():
    assert "AU16" in analysis._PROTOTYPES["disgust"]
    assert "AU17" in analysis._PROTOTYPES["sad"]


def test_disgust_uses_lower_lip_au16():
    bs = {"noseSneerLeft": 0.7, "noseSneerRight": 0.7, "mouthUpperUpLeft": 0.5,
          "mouthUpperUpRight": 0.5, "mouthLowerDownLeft": 0.5, "mouthLowerDownRight": 0.5,
          "mouthFrownLeft": 0.4, "mouthFrownRight": 0.4}
    scores = analysis._frame_emotion_scores(bs)
    assert max(scores, key=scores.get) == "disgust"
