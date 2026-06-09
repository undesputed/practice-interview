import json, math, os
from backend.report import save_session

def _frame(t, turn=0, smileL=0.2, yaw_deg=0.0):
    a = math.radians(yaw_deg); c, s = math.cos(a), math.sin(a)
    m = [c,0,s,0, 0,1,0,0, -s,0,c,0, 0,0,0,1]
    return {"t": t, "turn": turn, "face": True,
            "bs": {"mouthSmileLeft": smileL, "mouthSmileRight": smileL,
                   "eyeBlinkLeft": 0.0, "eyeBlinkRight": 0.0, "browInnerUp": 0.0,
                   "eyeLookInLeft": 0.0, "eyeLookInRight": 0.0,
                   "eyeLookOutLeft": 0.0, "eyeLookOutRight": 0.0,
                   "eyeLookUpLeft": 0.0, "eyeLookUpRight": 0.0,
                   "eyeLookDownLeft": 0.0, "eyeLookDownRight": 0.0},
            "m": m}

def test_save_session_writes_all_files(tmp_path):
    frames = [_frame(i * 100.0) for i in range(10)]
    summary = {"duration_sec": 1.0, "frame_count": 10, "no_face_pct": 0.0,
               "overall": {}, "per_question": []}
    coaching = {"summary": "good", "strengths": [], "improvements": [], "score": 7, "rationale": ""}
    transcript = {"full_text": "INTERVIEWER: hi\nCANDIDATE: hello", "segments": []}

    session_dir = str(tmp_path / "sess1")
    save_session(session_dir, frames, transcript, summary, coaching)

    for name in ("data.csv", "data.json", "summary.json", "transcript.txt", "charts.png"):
        assert os.path.exists(os.path.join(session_dir, name)), f"missing {name}"
    with open(os.path.join(session_dir, "summary.json")) as fh:
        assert json.load(fh)["frame_count"] == 10


import csv as _csv
from backend.emotion import EMOTION_CLASSES

def _pose(nose_y=0.2):
    return {"nose": {"x": 0.5, "y": nose_y}, "leftShoulder": {"x": 0.4, "y": 0.5},
            "rightShoulder": {"x": 0.6, "y": 0.5}, "leftEar": {"x": 0.45, "y": 0.3},
            "rightEar": {"x": 0.55, "y": 0.3}, "leftHip": {"x": 0.42, "y": 0.9},
            "rightHip": {"x": 0.58, "y": 0.9}}

def test_csv_has_body_columns(tmp_path):
    frames = []
    for i in range(6):
        f = _frame(i * 100.0)
        f["pose"] = _pose()
        frames.append(f)
    summary = {"duration_sec": 0.5, "frame_count": 6, "no_face_pct": 0.0,
               "overall": {}, "per_question": []}
    d = str(tmp_path / "s")
    save_session(d, frames, {"full_text": "", "segments": []}, summary, None)
    with open(d + "/data.csv") as fh:
        header = next(_csv.reader(fh))
    for col in ("gaze_on", "pose_present", "upright", "hands_present"):
        assert col in header


def _emotion_summary():
    def dist(dom): return {c: (100.0 if c == dom else 0.0) for c in EMOTION_CLASSES}
    def scores(dom): return {c: (90.0 if c == dom else 1.0) for c in EMOTION_CLASSES}
    return {"available": True, "dominant": "neutral",
            "overall_distribution": dist("neutral"),
            "per_question": [{"turn": 0, "dominant": "neutral", "distribution": dist("neutral")}],
            "timeline": [{"t": i * 1000.0, "turn": 0, "dominant": "neutral",
                          "scores": scores("neutral")} for i in range(4)]}

def test_save_session_writes_emotion_png_when_available(tmp_path):
    frames = [_frame(i * 100.0) for i in range(5)]
    summary = {"duration_sec": 0.5, "frame_count": 5, "no_face_pct": 0.0,
               "overall": {}, "per_question": [], "emotion": _emotion_summary()}
    d = str(tmp_path / "s")
    save_session(d, frames, {"full_text": "", "segments": []}, summary, None)
    assert os.path.exists(os.path.join(d, "emotion.png"))

def test_save_session_skips_emotion_png_when_unavailable(tmp_path):
    frames = [_frame(i * 100.0) for i in range(5)]
    summary = {"duration_sec": 0.5, "frame_count": 5, "no_face_pct": 0.0,
               "overall": {}, "per_question": [], "emotion": {"available": False}}
    d = str(tmp_path / "s2")
    save_session(d, frames, {"full_text": "", "segments": []}, summary, None)
    assert not os.path.exists(os.path.join(d, "emotion.png"))


def test_save_session_writes_mediapipe_emotion_png(tmp_path):
    frames = [_frame(i * 100.0) for i in range(5)]
    summary = {"duration_sec": 0.5, "frame_count": 5, "no_face_pct": 0.0,
               "overall": {}, "per_question": [],
               "emotion_mediapipe": _emotion_summary()}
    d = str(tmp_path / "smp")
    save_session(d, frames, {"full_text": "", "segments": []}, summary, None)
    assert os.path.exists(os.path.join(d, "emotion_mediapipe.png"))

def test_save_session_skips_mediapipe_emotion_png_when_unavailable(tmp_path):
    frames = [_frame(i * 100.0) for i in range(5)]
    summary = {"duration_sec": 0.5, "frame_count": 5, "no_face_pct": 0.0,
               "overall": {}, "per_question": [],
               "emotion_mediapipe": {"available": False}}
    d = str(tmp_path / "smp2")
    save_session(d, frames, {"full_text": "", "segments": []}, summary, None)
    assert not os.path.exists(os.path.join(d, "emotion_mediapipe.png"))

def test_save_session_survives_malformed_emotion(tmp_path):
    frames = [_frame(i * 100.0) for i in range(5)]
    bad_emotion = {"available": True, "dominant": "neutral",
                   "overall_distribution": {}, "per_question": [],
                   "timeline": [{"t": 0.0, "turn": 0}]}  # missing "scores" -> chart would raise
    summary = {"duration_sec": 0.5, "frame_count": 5, "no_face_pct": 0.0,
               "overall": {}, "per_question": [], "emotion": bad_emotion}
    d = str(tmp_path / "bad")
    save_session(d, frames, {"full_text": "", "segments": []}, summary, None)  # must NOT raise
    assert os.path.exists(os.path.join(d, "data.csv"))
    assert os.path.exists(os.path.join(d, "charts.png"))
    assert not os.path.exists(os.path.join(d, "emotion.png"))  # chart skipped on error
