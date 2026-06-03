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

from backend.analysis import pose_metrics

def _pose(nose_y, ls=(0.4, 0.5), rs=(0.6, 0.5)):
    return {"nose": {"x": 0.5, "y": nose_y, "visibility": 0.9},
            "leftShoulder": {"x": ls[0], "y": ls[1], "visibility": 0.9},
            "rightShoulder": {"x": rs[0], "y": rs[1], "visibility": 0.9},
            "leftEar": {"x": 0.45, "y": 0.3}, "rightEar": {"x": 0.55, "y": 0.3},
            "leftHip": {"x": 0.42, "y": 0.9}, "rightHip": {"x": 0.58, "y": 0.9}}

def test_upright_vs_slouched():
    upright = [_frame(i * 100.0, pose=_pose(0.2)) for i in range(5)]
    assert pose_metrics(upright)["upright_pct"] == 100.0
    slouch = [_frame(i * 100.0, pose=_pose(0.48)) for i in range(5)]
    assert pose_metrics(slouch)["upright_pct"] == 0.0

def test_lean_level_vs_tilted():
    level = [_frame(i * 100.0, pose=_pose(0.2, ls=(0.4, 0.5), rs=(0.6, 0.5))) for i in range(5)]
    assert pose_metrics(level)["lean"] == 0.0
    tilted = [_frame(i * 100.0, pose=_pose(0.2, ls=(0.4, 0.45), rs=(0.6, 0.55))) for i in range(5)]
    assert pose_metrics(tilted)["lean"] > 0.0

def test_body_steadiness_still_vs_moving():
    still = [_frame(i * 100.0, pose=_pose(0.2)) for i in range(5)]
    assert pose_metrics(still)["body_steadiness"] == 100.0
    moving = [_frame(i * 100.0, pose=_pose(0.2, ls=(0.4 + 0.05 * i, 0.5), rs=(0.6 + 0.05 * i, 0.5)))
              for i in range(5)]
    assert pose_metrics(moving)["body_steadiness"] < 100.0

def test_pose_metrics_no_pose_safe():
    out = pose_metrics([_frame(i * 100.0) for i in range(3)])
    assert out == {"upright_pct": 0.0, "lean": 0.0, "body_steadiness": 0.0}

from backend.analysis import hand_metrics

def _hand(wx, wy, ix=None, iy=None):
    ix = wx if ix is None else ix
    iy = wy if iy is None else iy
    return {"handedness": "Right", "wrist": {"x": wx, "y": wy},
            "indexTip": {"x": ix, "y": iy}, "middleTip": {"x": ix, "y": iy}}

def test_hand_fidget_still_vs_moving():
    still = [_frame(i * 100.0, hands=[_hand(0.4, 0.7)]) for i in range(5)]
    assert hand_metrics(still)["hand_fidget"] == 0.0
    moving = [_frame(i * 100.0, hands=[_hand(0.4 + 0.05 * i, 0.7)]) for i in range(5)]
    assert hand_metrics(moving)["hand_fidget"] > 0.0

def test_face_touch_counts_rising_edges():
    p = _pose(0.3)
    away = _frame(0.0, pose=p, hands=[_hand(0.9, 0.9)])
    near = _frame(100.0, pose=p, hands=[_hand(0.5, 0.32)])
    seq = [away, near, away, near]
    assert hand_metrics(seq)["face_touch_count"] == 2

def test_hand_metrics_no_hands_safe():
    out = hand_metrics([_frame(i * 100.0) for i in range(3)])
    assert out == {"hand_fidget": 0.0, "face_touch_count": 0}
