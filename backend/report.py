# backend/report.py
from __future__ import annotations  # PEP 604 (X | Y) on Python 3.9
import csv, json, os
import matplotlib
matplotlib.use("Agg")  # headless backend — no display needed
import matplotlib.pyplot as plt
from backend.analysis import matrix_to_euler, SMILE_THRESHOLD, GAZE_MAX, UPRIGHT_RATIO


def _write_csv(path: str, frames: list[dict]) -> None:
    import math as _m
    with open(path, "w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        w.writerow(["t", "turn", "face", "pitch", "yaw", "roll",
                    "smileL", "smileR", "blinkL", "blinkR",
                    "gaze_on", "pose_present", "upright", "shoulder_tilt", "hands_present"])
        for f in frames:
            pitch, yaw, roll = matrix_to_euler(f["m"]) if f.get("face") else (0, 0, 0)
            bs = f.get("bs", {})
            horiz = max(bs.get("eyeLookOutLeft", 0), bs.get("eyeLookOutRight", 0),
                        bs.get("eyeLookInLeft", 0), bs.get("eyeLookInRight", 0))
            vert = max(bs.get("eyeLookUpLeft", 0), bs.get("eyeLookUpRight", 0),
                       bs.get("eyeLookDownLeft", 0), bs.get("eyeLookDownRight", 0))
            gaze_on = int(bool(f.get("face")) and horiz < GAZE_MAX and vert < GAZE_MAX)
            p = f.get("pose")
            if p:
                width = abs(p["leftShoulder"]["x"] - p["rightShoulder"]["x"]) or 1e-6
                mid_y = (p["leftShoulder"]["y"] + p["rightShoulder"]["y"]) / 2.0
                upright = int((mid_y - p["nose"]["y"]) / width > UPRIGHT_RATIO)
                tilt = round(abs(_m.degrees(_m.atan2(
                    p["rightShoulder"]["y"] - p["leftShoulder"]["y"],
                    p["rightShoulder"]["x"] - p["leftShoulder"]["x"]))), 2)
            else:
                upright, tilt = "", ""
            w.writerow([f["t"], f.get("turn"), int(bool(f.get("face"))),
                        round(pitch, 2), round(yaw, 2), round(roll, 2),
                        bs.get("mouthSmileLeft", 0), bs.get("mouthSmileRight", 0),
                        bs.get("eyeBlinkLeft", 0), bs.get("eyeBlinkRight", 0),
                        gaze_on, int(p is not None), upright, tilt,
                        int(f.get("hands") is not None)])


def _build_charts(path: str, frames: list[dict]) -> None:
    ts = [f["t"] / 1000.0 for f in frames]
    smile, yaw_s, pitch_s = [], [], []
    for f in frames:
        bs = f["bs"]
        smile.append((bs.get("mouthSmileLeft", 0) + bs.get("mouthSmileRight", 0)) / 2.0)
        if f.get("face"):
            pitch, yaw, _ = matrix_to_euler(f["m"])
        else:
            pitch, yaw = 0.0, 0.0
        yaw_s.append(yaw); pitch_s.append(pitch)

    # vertical lines where the interviewer turn changes
    boundaries = [frames[i]["t"] / 1000.0 for i in range(1, len(frames))
                  if frames[i]["turn"] != frames[i - 1]["turn"]]

    upright_series, ts_pose = [], []
    for f in frames:
        p = f.get("pose")
        if p:
            width = abs(p["leftShoulder"]["x"] - p["rightShoulder"]["x"]) or 1e-6
            mid_y = (p["leftShoulder"]["y"] + p["rightShoulder"]["y"]) / 2.0
            upright_series.append(1 if (mid_y - p["nose"]["y"]) / width > UPRIGHT_RATIO else 0)
            ts_pose.append(f["t"] / 1000.0)

    fig, (ax1, ax2, ax3) = plt.subplots(3, 1, figsize=(10, 8), sharex=True)
    ax1.plot(ts, smile, label="smile")
    ax1.axhline(SMILE_THRESHOLD, ls="--", lw=0.8, color="gray")
    ax1.set_ylabel("smile"); ax1.legend(loc="upper right")
    ax2.plot(ts, yaw_s, label="yaw"); ax2.plot(ts, pitch_s, label="pitch")
    ax2.set_ylabel("degrees"); ax2.legend(loc="upper right")
    if ts_pose:
        ax3.step(ts_pose, upright_series, where="post", label="upright (1/0)")
    ax3.set_ylabel("posture"); ax3.set_xlabel("seconds"); ax3.legend(loc="upper right")
    for b in boundaries:
        for ax in (ax1, ax2, ax3):
            ax.axvline(b, color="red", lw=0.6, alpha=0.5)
    fig.suptitle("Interview timeline (red = new question)")
    fig.tight_layout()
    fig.savefig(path, dpi=100)
    plt.close(fig)


def save_session(session_dir: str, frames: list[dict], transcript: dict,
                 summary: dict, coaching: dict | None) -> None:
    os.makedirs(session_dir, exist_ok=True)
    _write_csv(os.path.join(session_dir, "data.csv"), frames)
    with open(os.path.join(session_dir, "data.json"), "w", encoding="utf-8") as fh:
        json.dump(frames, fh)
    out = dict(summary)
    out["coaching"] = coaching
    with open(os.path.join(session_dir, "summary.json"), "w", encoding="utf-8") as fh:
        json.dump(out, fh, indent=2)
    with open(os.path.join(session_dir, "transcript.txt"), "w", encoding="utf-8") as fh:
        fh.write(transcript.get("full_text", ""))
    _build_charts(os.path.join(session_dir, "charts.png"), frames)
