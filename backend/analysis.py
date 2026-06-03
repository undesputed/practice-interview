# backend/analysis.py
from __future__ import annotations  # PEP 604 (X | Y) on Python 3.9
import math
from typing import Sequence

# --- Tunable thresholds ---
EYE_CONTACT_MAX_DEG = 15.0
SMILE_THRESHOLD = 0.3
BLINK_THRESHOLD = 0.5
STEADINESS_K = 4.0


def matrix_to_euler(m: Sequence[float]) -> tuple[float, float, float]:
    """Decompose a row-major 4x4 transform's rotation into (pitch, yaw, roll) degrees."""
    def R(i, j):  # row-major: element at row i, col j
        return m[i * 4 + j]
    pitch = math.atan2(R(2, 1), R(2, 2))
    yaw = math.atan2(-R(2, 0), math.sqrt(R(2, 1) ** 2 + R(2, 2) ** 2))
    roll = math.atan2(R(1, 0), R(0, 0))
    return math.degrees(pitch), math.degrees(yaw), math.degrees(roll)


def _metric_block(frames: list[dict]) -> dict:
    """Compute a MetricBlock for a list of frames (any subset)."""
    total = len(frames)
    if total == 0:
        return {"eye_contact_pct": 0.0, "head_movement": 0.0, "steadiness_score": 0.0,
                "mean_smile": 0.0, "pct_smiling": 0.0, "peak_smile": 0.0,
                "blink_count": 0, "blinks_per_min": 0.0}

    poses, smiles, on_camera = [], [], 0
    for f in frames:
        if not f.get("face", False):
            continue
        pitch, yaw, roll = matrix_to_euler(f["m"])
        poses.append((pitch, yaw, roll))
        if abs(yaw) <= EYE_CONTACT_MAX_DEG and abs(pitch) <= EYE_CONTACT_MAX_DEG:
            on_camera += 1
        bs = f["bs"]
        smiles.append((bs.get("mouthSmileLeft", 0.0) + bs.get("mouthSmileRight", 0.0)) / 2.0)

    eye_contact_pct = round(100.0 * on_camera / total, 1)

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
        bs = f["bs"]
        val = max(bs.get("eyeBlinkLeft", 0.0), bs.get("eyeBlinkRight", 0.0))
        closed = val >= BLINK_THRESHOLD
        if closed and not prev_closed:
            blink_count += 1
        prev_closed = closed

    duration_min = ((frames[-1]["t"] - frames[0]["t"]) / 1000.0 / 60.0) if total >= 2 else 0.0
    blinks_per_min = round(blink_count / duration_min, 1) if duration_min > 0 else 0.0

    return {"eye_contact_pct": eye_contact_pct, "head_movement": round(movement, 2),
            "steadiness_score": round(steadiness, 1), "mean_smile": mean_smile,
            "pct_smiling": pct_smiling, "peak_smile": peak_smile,
            "blink_count": blink_count, "blinks_per_min": blinks_per_min}


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
