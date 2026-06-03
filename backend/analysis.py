# backend/analysis.py
from __future__ import annotations  # PEP 604 (X | Y) on Python 3.9
import math
from typing import Sequence

# A "frame" dict has the shape:
#   {"t": float_ms, "turn": int, "face": bool,
#    "bs": {"mouthSmileLeft","mouthSmileRight","eyeBlinkLeft","eyeBlinkRight","browInnerUp" -> float},
#    "m": [16 floats]  # row-major 4x4 facial transformation matrix}

# --- Tunable thresholds ---
EYE_CONTACT_MAX_DEG = 15.0
SMILE_THRESHOLD = 0.3
BLINK_THRESHOLD = 0.5
STEADINESS_K = 4.0
GAZE_MAX = 0.5  # eyeLook* magnitude above which gaze is "off camera"
UPRIGHT_RATIO = 0.5       # headRise / shoulderWidth above this = upright
BODY_FIDGET_SCALE = 2000  # maps mean normalized body movement to a 0-100 steadiness drop
FACE_TOUCH_RADIUS = 0.6   # × shoulder width: hand-point within this of the nose = touching


def matrix_to_euler(m: Sequence[float]) -> tuple[float, float, float]:
    """Decompose a row-major 4x4 transform's rotation into (pitch, yaw, roll) degrees.

    `m` must have 16 elements (row-major). Near-vertical poses (gimbal lock) yield degenerate yaw/roll.
    """
    def R(i, j):  # row-major: element at row i, col j
        return m[i * 4 + j]
    pitch = math.atan2(R(2, 1), R(2, 2))
    yaw = math.atan2(-R(2, 0), math.sqrt(R(2, 1) ** 2 + R(2, 2) ** 2))
    roll = math.atan2(R(1, 0), R(0, 0))
    return math.degrees(pitch), math.degrees(yaw), math.degrees(roll)


def gaze_eye_contact_pct(frames: list[dict]) -> float:
    """% of frames with a face whose gaze is on-camera (eyeLook* below GAZE_MAX). Denominator = total."""
    total = len(frames)
    if total == 0:
        return 0.0
    on = 0
    for f in frames:
        if not f.get("face", False):
            continue
        bs = f.get("bs", {})
        horiz = max(bs.get("eyeLookOutLeft", 0.0), bs.get("eyeLookOutRight", 0.0),
                    bs.get("eyeLookInLeft", 0.0), bs.get("eyeLookInRight", 0.0))
        vert = max(bs.get("eyeLookUpLeft", 0.0), bs.get("eyeLookUpRight", 0.0),
                   bs.get("eyeLookDownLeft", 0.0), bs.get("eyeLookDownRight", 0.0))
        if horiz < GAZE_MAX and vert < GAZE_MAX:
            on += 1
    return round(100.0 * on / total, 1)


def _metric_block(frames: list[dict]) -> dict:
    """Compute a MetricBlock for a list of frames (any subset)."""
    total = len(frames)
    if total == 0:
        return {"gaze_eye_contact_pct": 0.0, "head_movement": 0.0, "steadiness_score": 0.0,
                "mean_smile": 0.0, "pct_smiling": 0.0, "peak_smile": 0.0,
                "blink_count": 0, "blinks_per_min": 0.0,
                "upright_pct": 0.0, "lean": 0.0, "body_steadiness": 0.0,
                "hand_fidget": 0.0, "face_touch_count": 0}

    poses, smiles = [], []
    for f in frames:
        if not f.get("face", False) or "m" not in f or "bs" not in f:
            continue
        pitch, yaw, roll = matrix_to_euler(f["m"])
        poses.append((pitch, yaw, roll))
        bs = f["bs"]
        smiles.append((bs.get("mouthSmileLeft", 0.0) + bs.get("mouthSmileRight", 0.0)) / 2.0)

    # head movement: mean per-frame absolute change across consecutive face poses
    movement = 0.0
    if len(poses) >= 2:
        deltas = []
        for (p0, y0, r0), (p1, y1, r1) in zip(poses, poses[1:]):
            deltas.append(abs(p1 - p0) + abs(y1 - y0) + abs(r1 - r0))
        movement = sum(deltas) / len(deltas)
    steadiness = max(0.0, min(100.0, 100.0 - STEADINESS_K * movement))

    mean_smile = round(sum(smiles) / len(smiles), 3) if smiles else 0.0
    pct_smiling = round(100.0 * sum(1 for s in smiles if s > SMILE_THRESHOLD) / total, 1)
    peak_smile = round(max(smiles), 3) if smiles else 0.0

    # blinks: rising edges of max(eyeBlinkLeft, eyeBlinkRight) crossing BLINK_THRESHOLD
    blink_count, prev_closed = 0, False
    for f in frames:
        bs = f.get("bs", {})
        val = max(bs.get("eyeBlinkLeft", 0.0), bs.get("eyeBlinkRight", 0.0))
        closed = val >= BLINK_THRESHOLD
        if closed and not prev_closed:
            blink_count += 1
        prev_closed = closed

    duration_min = ((frames[-1]["t"] - frames[0]["t"]) / 1000.0 / 60.0) if total >= 2 else 0.0
    blinks_per_min = round(blink_count / duration_min, 1) if duration_min > 0 else 0.0

    block = {"gaze_eye_contact_pct": gaze_eye_contact_pct(frames),
             "head_movement": round(movement, 2), "steadiness_score": round(steadiness, 1),
             "mean_smile": mean_smile, "pct_smiling": pct_smiling, "peak_smile": peak_smile,
             "blink_count": blink_count, "blinks_per_min": blinks_per_min}
    block.update(pose_metrics(frames))
    block.update(hand_metrics(frames))
    return block


def compute_metrics(frames: list[dict], questions: dict | None = None) -> dict:
    """Compute overall + per-question metrics. `questions` maps turn index -> question text."""
    total = len(frames)
    no_face = sum(1 for f in frames if not f.get("face", False))
    no_face_pct = round(100.0 * no_face / total, 1) if total else 0.0
    duration_sec = round((frames[-1]["t"] - frames[0]["t"]) / 1000.0, 1) if total >= 2 else 0.0

    by_turn: dict[int, list[dict]] = {}
    for f in frames:
        by_turn.setdefault(f.get("turn", -1), []).append(f)

    per_question = []
    for turn in sorted(t for t in by_turn if t >= 0):
        per_question.append({
            "turn": turn,
            "question": (questions or {}).get(turn, f"Question {turn + 1}"),
            "metrics": _metric_block(by_turn[turn]),
        })

    return {"duration_sec": duration_sec, "frame_count": total,
            "no_face_pct": no_face_pct, "overall": _metric_block(frames),
            "per_question": per_question}


def pose_metrics(frames: list[dict]) -> dict:
    """Posture/lean/steadiness from pose-bearing frames. Safe (zeros) when no pose present."""
    poses = [f["pose"] for f in frames if f.get("pose")]
    if not poses:
        return {"upright_pct": 0.0, "lean": 0.0, "body_steadiness": 0.0}

    upright, tilts, centers = 0, [], []
    for p in poses:
        ls, rs, nose = p["leftShoulder"], p["rightShoulder"], p["nose"]
        mid_y = (ls["y"] + rs["y"]) / 2.0
        width = abs(ls["x"] - rs["x"]) or 1e-6
        if (mid_y - nose["y"]) / width > UPRIGHT_RATIO:
            upright += 1
        tilts.append(abs(math.degrees(math.atan2(rs["y"] - ls["y"], rs["x"] - ls["x"]))))
        centers.append(((ls["x"] + rs["x"]) / 2.0, mid_y, nose["x"], nose["y"]))

    movement = 0.0
    if len(centers) >= 2:
        d = [abs(b[0]-a[0]) + abs(b[1]-a[1]) + abs(b[2]-a[2]) + abs(b[3]-a[3])
             for a, b in zip(centers, centers[1:])]
        movement = sum(d) / len(d)
    steadiness = max(0.0, min(100.0, 100.0 - BODY_FIDGET_SCALE * movement / 100.0))

    return {"upright_pct": round(100.0 * upright / len(poses), 1),
            "lean": round(sum(tilts) / len(tilts), 1),
            "body_steadiness": round(steadiness, 1)}


def hand_metrics(frames: list[dict]) -> dict:
    """Hand fidget + face-touch onset count from hand-bearing frames. Safe (zeros) when absent."""
    hand_frames = [f for f in frames if f.get("hands") is not None]
    if not hand_frames:
        return {"hand_fidget": 0.0, "face_touch_count": 0}

    # fidget: mean wrist (first hand) displacement across consecutive frames that have a hand
    wrists = [(f["hands"][0]["wrist"] if f["hands"] else None) for f in hand_frames]
    seq = [w for w in wrists if w is not None]
    fidget = 0.0
    if len(seq) >= 2:
        d = [abs(b["x"] - a["x"]) + abs(b["y"] - a["y"]) for a, b in zip(seq, seq[1:])]
        fidget = sum(d) / len(d)

    # face-touch: hand point within radius of nose; count rising edges
    touches, prev = 0, False
    for f in hand_frames:
        hands = f.get("hands") or []
        pose = f.get("pose")
        touching = False
        if hands and pose:
            nose = pose["nose"]; ls = pose["leftShoulder"]; rs = pose["rightShoulder"]
            radius = FACE_TOUCH_RADIUS * (abs(ls["x"] - rs["x"]) or 1e-6)
            for h in hands:
                for key in ("wrist", "indexTip", "middleTip"):
                    pt = h.get(key)
                    if pt and math.hypot(pt["x"] - nose["x"], pt["y"] - nose["y"]) <= radius:
                        touching = True
        if touching and not prev:
            touches += 1
        prev = touching

    return {"hand_fidget": round(fidget, 4), "face_touch_count": touches}


def questions_from_transcript(segments: list[dict]) -> dict:
    """Map interviewer turn index -> question text, in order of appearance."""
    questions: dict[int, str] = {}
    idx = 0
    for seg in segments:
        if seg.get("speaker") == "interviewer":
            questions[idx] = seg.get("text", "")
            idx += 1
    return questions
