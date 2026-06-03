# backend/report.py
from __future__ import annotations  # PEP 604 (X | Y) on Python 3.9
import csv, json, os
import matplotlib
matplotlib.use("Agg")  # headless backend — no display needed
import matplotlib.pyplot as plt
from backend.analysis import matrix_to_euler, SMILE_THRESHOLD


def _write_csv(path: str, frames: list[dict]) -> None:
    with open(path, "w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["t", "turn", "face", "pitch", "yaw", "roll",
                    "smileL", "smileR", "blinkL", "blinkR"])
        for f in frames:
            pitch, yaw, roll = matrix_to_euler(f["m"]) if f.get("face") else (0, 0, 0)
            bs = f["bs"]
            w.writerow([f["t"], f["turn"], int(f.get("face", False)),
                        round(pitch, 2), round(yaw, 2), round(roll, 2),
                        bs.get("mouthSmileLeft", 0), bs.get("mouthSmileRight", 0),
                        bs.get("eyeBlinkLeft", 0), bs.get("eyeBlinkRight", 0)])


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

    fig, (ax1, ax2) = plt.subplots(2, 1, figsize=(10, 6), sharex=True)
    ax1.plot(ts, smile, label="smile")
    ax1.axhline(SMILE_THRESHOLD, ls="--", lw=0.8, color="gray")
    ax1.set_ylabel("smile"); ax1.legend(loc="upper right")
    ax2.plot(ts, yaw_s, label="yaw"); ax2.plot(ts, pitch_s, label="pitch")
    ax2.set_ylabel("degrees"); ax2.set_xlabel("seconds"); ax2.legend(loc="upper right")
    for b in boundaries:
        ax1.axvline(b, color="red", lw=0.6, alpha=0.5)
        ax2.axvline(b, color="red", lw=0.6, alpha=0.5)
    fig.suptitle("Interview facial timeline (red = new question)")
    fig.tight_layout()
    fig.savefig(path, dpi=100)
    plt.close(fig)


def save_session(session_dir: str, frames: list[dict], transcript: dict,
                 summary: dict, coaching: dict | None) -> None:
    os.makedirs(session_dir, exist_ok=True)
    _write_csv(os.path.join(session_dir, "data.csv"), frames)
    with open(os.path.join(session_dir, "data.json"), "w") as fh:
        json.dump(frames, fh)
    out = dict(summary)
    out["coaching"] = coaching
    with open(os.path.join(session_dir, "summary.json"), "w") as fh:
        json.dump(out, fh, indent=2)
    with open(os.path.join(session_dir, "transcript.txt"), "w") as fh:
        fh.write(transcript.get("full_text", ""))
    _build_charts(os.path.join(session_dir, "charts.png"), frames)
