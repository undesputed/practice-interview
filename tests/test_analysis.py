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
           blinkL=0.0, blinkR=0.0):
    import math
    a = math.radians(yaw_deg)
    c, s = math.cos(a), math.sin(a)
    m = [c,0,s,0, 0,1,0,0, -s,0,c,0, 0,0,0,1]
    return {"t": t, "turn": turn, "face": face,
            "bs": {"mouthSmileLeft": smileL, "mouthSmileRight": smileR,
                   "eyeBlinkLeft": blinkL, "eyeBlinkRight": blinkR, "browInnerUp": 0.0},
            "m": m}

def test_eye_contact_all_centered():
    frames = [_frame(t * 100.0, yaw_deg=0.0) for t in range(10)]
    out = compute_metrics(frames)
    assert out["overall"]["eye_contact_pct"] == 100.0
    assert out["no_face_pct"] == 0.0

def test_eye_contact_half_looking_away():
    frames = [_frame(t * 100.0, yaw_deg=0.0) for t in range(5)]
    frames += [_frame((t + 5) * 100.0, yaw_deg=40.0) for t in range(5)]
    out = compute_metrics(frames)
    assert out["overall"]["eye_contact_pct"] == 50.0

def test_no_face_counts_against_contact():
    frames = [_frame(t * 100.0, face=(t % 2 == 0)) for t in range(10)]
    out = compute_metrics(frames)
    assert out["no_face_pct"] == 50.0
    assert out["overall"]["eye_contact_pct"] == 50.0
