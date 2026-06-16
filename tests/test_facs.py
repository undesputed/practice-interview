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


def test_contempt_on_asymmetric_smile_with_dimple():
    bs = {"mouthSmileLeft": 0.7, "mouthSmileRight": 0.05,
          "mouthDimpleLeft": 0.5, "mouthDimpleRight": 0.0}
    scores = analysis._frame_emotion_scores(bs)
    assert "contempt" in scores
    assert max(scores, key=scores.get) == "contempt"


def test_symmetric_smile_is_not_contempt():
    bs = {"mouthSmileLeft": 0.7, "mouthSmileRight": 0.7,
          "cheekSquintLeft": 0.4, "cheekSquintRight": 0.4}
    scores = analysis._frame_emotion_scores(bs)
    assert scores["contempt"] == 0.0
    assert max(scores, key=scores.get) == "happy"


def test_mediapipe_track_distribution_includes_contempt():
    frame = {"face": True, "t": 0.0, "turn": 0,
             "bs": {"mouthSmileLeft": 0.7, "mouthSmileRight": 0.05,
                    "mouthDimpleLeft": 0.5, "mouthDimpleRight": 0.0}}
    out = analysis.emotion_from_blendshapes([frame])
    assert out["available"] is True
    assert "contempt" in out["overall_distribution"]


def test_action_units_breakdown_levels_and_floor():
    frames = [
        {"face": True, "bs": {"mouthSmileLeft": 0.9, "mouthSmileRight": 0.9}},   # AU12 strong
        {"face": True, "bs": {"mouthSmileLeft": 0.5, "mouthSmileRight": 0.5}},
    ]
    aus = analysis.action_units(frames)
    by = {a["au"]: a for a in aus}
    assert "AU12" in by
    assert by["AU12"]["peak"] == 0.9
    assert by["AU12"]["level"] == "E"           # 0.9 -> E
    assert by["AU12"]["name"] == "Lip corner puller"
    assert "AU4" not in by                        # never fired -> below floor, excluded


def test_action_units_empty_when_no_faces():
    assert analysis.action_units([{"face": False}]) == []
