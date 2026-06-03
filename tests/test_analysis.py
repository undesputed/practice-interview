import math
from backend.analysis import matrix_to_euler

IDENTITY = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]

def test_identity_is_zero():
    pitch, yaw, roll = matrix_to_euler(IDENTITY)
    assert abs(pitch) < 1e-6
    assert abs(yaw) < 1e-6
    assert abs(roll) < 1e-6

def test_yaw_30_degrees():
    a = math.radians(30)
    c, s = math.cos(a), math.sin(a)
    # Row-major rotation about Y by +30°
    m = [ c, 0, s, 0,
          0, 1, 0, 0,
         -s, 0, c, 0,
          0, 0, 0, 1]
    pitch, yaw, roll = matrix_to_euler(m)
    assert abs(yaw - 30) < 1e-3
    assert abs(pitch) < 1e-3
    assert abs(roll) < 1e-3

from backend.analysis import compute_metrics

def _frame(t, turn=0, face=True, yaw_deg=0.0, smileL=0.0, smileR=0.0,
           blinkL=0.0, blinkR=0.0, look_out=0.0, look_up=0.0, pose=None, hands=None):
    import math
    a = math.radians(yaw_deg)
    c, s = math.cos(a), math.sin(a)
    m = [c,0,s,0, 0,1,0,0, -s,0,c,0, 0,0,0,1]
    bs = {"mouthSmileLeft": smileL, "mouthSmileRight": smileR,
          "eyeBlinkLeft": blinkL, "eyeBlinkRight": blinkR, "browInnerUp": 0.0,
          "eyeLookInLeft": 0.0, "eyeLookInRight": 0.0,
          "eyeLookOutLeft": look_out, "eyeLookOutRight": look_out,
          "eyeLookUpLeft": look_up, "eyeLookUpRight": look_up,
          "eyeLookDownLeft": 0.0, "eyeLookDownRight": 0.0}
    f = {"t": t, "turn": turn, "face": face, "bs": bs, "m": m}
    if pose is not None: f["pose"] = pose
    if hands is not None: f["hands"] = hands
    return f

def test_gaze_all_centered():
    frames = [_frame(t * 100.0, look_out=0.0) for t in range(10)]
    out = compute_metrics(frames)
    assert out["overall"]["gaze_eye_contact_pct"] == 100.0

def test_gaze_half_looking_away():
    frames = [_frame(t * 100.0, look_out=0.0) for t in range(5)]
    frames += [_frame((t + 5) * 100.0, look_out=0.8) for t in range(5)]
    out = compute_metrics(frames)
    assert out["overall"]["gaze_eye_contact_pct"] == 50.0

def test_no_face_counts_against_gaze():
    frames = [_frame(t * 100.0, face=(t % 2 == 0)) for t in range(10)]
    out = compute_metrics(frames)
    assert out["no_face_pct"] == 50.0
    assert out["overall"]["gaze_eye_contact_pct"] == 50.0

def test_positivity_smile():
    frames = [_frame(t * 100.0, smileL=0.6, smileR=0.6) for t in range(5)]
    frames += [_frame((t + 5) * 100.0, smileL=0.0, smileR=0.0) for t in range(5)]
    out = compute_metrics(frames)
    assert out["overall"]["pct_smiling"] == 50.0
    assert out["overall"]["peak_smile"] == 0.6
    assert abs(out["overall"]["mean_smile"] - 0.3) < 1e-6

def test_blink_count_rising_edges():
    # two distinct blinks: closed, open, closed
    seq = [0.0, 0.0, 0.8, 0.8, 0.0, 0.0, 0.9, 0.0]
    frames = [_frame(i * 100.0, blinkL=v, blinkR=v) for i, v in enumerate(seq)]
    out = compute_metrics(frames)
    assert out["overall"]["blink_count"] == 2

def test_per_question_segmentation():
    frames = [_frame(t * 100.0, turn=0) for t in range(5)]
    frames += [_frame((t + 5) * 100.0, turn=1, look_out=0.8) for t in range(5)]
    out = compute_metrics(frames, questions={0: "Tell me about yourself", 1: "A challenge?"})
    assert len(out["per_question"]) == 2
    assert out["per_question"][0]["question"] == "Tell me about yourself"
    assert out["per_question"][0]["metrics"]["gaze_eye_contact_pct"] == 100.0
    assert out["per_question"][1]["metrics"]["gaze_eye_contact_pct"] == 0.0

def test_empty_frames_safe():
    out = compute_metrics([])
    assert out["frame_count"] == 0
    assert out["overall"]["gaze_eye_contact_pct"] == 0.0
    assert out["per_question"] == []

def test_pitch_30_degrees():
    a = math.radians(30)
    c, s = math.cos(a), math.sin(a)
    # Row-major rotation about X by +30°
    m = [1, 0, 0, 0,
         0, c, -s, 0,
         0, s, c, 0,
         0, 0, 0, 1]
    pitch, yaw, roll = matrix_to_euler(m)
    assert abs(pitch - 30) < 1e-3
    assert abs(yaw) < 1e-3
    assert abs(roll) < 1e-3

from backend.analysis import questions_from_transcript

def test_questions_from_transcript_maps_interviewer_turns():
    segments = [
        {"speaker": "interviewer", "text": "Tell me about yourself.", "t": 0},
        {"speaker": "candidate", "text": "Sure, I ...", "t": 5000},
        {"speaker": "interviewer", "text": "Describe a challenge.", "t": 20000},
        {"speaker": "candidate", "text": "Once ...", "t": 25000},
    ]
    q = questions_from_transcript(segments)
    assert q == {0: "Tell me about yourself.", 1: "Describe a challenge."}
