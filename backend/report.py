# backend/report.py
from __future__ import annotations
import csv, io, json, logging
from concurrent.futures import ThreadPoolExecutor, as_completed
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from backend.analysis import (matrix_to_euler, SMILE_THRESHOLD, GAZE_MAX,
                              UPRIGHT_RATIO, FRAME_ASPECT)
from backend.emotion import EMOTION_CLASSES
from backend import storage, sessions_store


def _csv_bytes(frames: list[dict]) -> bytes:
    import math as _m
    buf = io.StringIO()
    w = csv.writer(buf)
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
            upright = int(((mid_y - p["nose"]["y"]) / FRAME_ASPECT) / width > UPRIGHT_RATIO)
            tilt = round(abs(_m.degrees(_m.atan2(
                (p["rightShoulder"]["y"] - p["leftShoulder"]["y"]) / FRAME_ASPECT,
                p["rightShoulder"]["x"] - p["leftShoulder"]["x"]))), 2)
        else:
            upright, tilt = "", ""
        w.writerow([f["t"], f.get("turn"), int(bool(f.get("face"))),
                    round(pitch, 2), round(yaw, 2), round(roll, 2),
                    bs.get("mouthSmileLeft", 0), bs.get("mouthSmileRight", 0),
                    bs.get("eyeBlinkLeft", 0), bs.get("eyeBlinkRight", 0),
                    gaze_on, int(p is not None), upright, tilt,
                    int(f.get("hands") is not None)])
    return buf.getvalue().encode()


def _charts_png(frames: list[dict]) -> bytes:
    ts = [f["t"] / 1000.0 for f in frames]
    smile, yaw_s, pitch_s = [], [], []
    for f in frames:
        bs = f.get("bs", {})
        smile.append((bs.get("mouthSmileLeft", 0) + bs.get("mouthSmileRight", 0)) / 2.0)
        if f.get("face"):
            pitch, yaw, _ = matrix_to_euler(f["m"])
        else:
            pitch, yaw = 0.0, 0.0
        yaw_s.append(yaw); pitch_s.append(pitch)

    boundaries = [frames[i]["t"] / 1000.0 for i in range(1, len(frames))
                  if frames[i]["turn"] != frames[i - 1]["turn"]]

    upright_series, ts_pose = [], []
    for f in frames:
        p = f.get("pose")
        if p:
            width = abs(p["leftShoulder"]["x"] - p["rightShoulder"]["x"]) or 1e-6
            mid_y = (p["leftShoulder"]["y"] + p["rightShoulder"]["y"]) / 2.0
            upright_series.append(
                1 if ((mid_y - p["nose"]["y"]) / FRAME_ASPECT) / width > UPRIGHT_RATIO else 0)
            ts_pose.append(f["t"] / 1000.0)

    mouth, gaze_on, ts_face = [], [], []
    for f in frames:
        bs = f.get("bs", {})
        mouth.append(bs.get("jawOpen", 0.0))
        horiz = max(bs.get("eyeLookOutLeft", 0), bs.get("eyeLookOutRight", 0),
                    bs.get("eyeLookInLeft", 0), bs.get("eyeLookInRight", 0))
        vert = max(bs.get("eyeLookUpLeft", 0), bs.get("eyeLookUpRight", 0),
                   bs.get("eyeLookDownLeft", 0), bs.get("eyeLookDownRight", 0))
        gaze_on.append(1 if (f.get("face") and horiz < GAZE_MAX and vert < GAZE_MAX) else 0)
        ts_face.append(f["t"] / 1000.0)

    fig, (ax1, ax2, ax3, ax4) = plt.subplots(4, 1, figsize=(14, 11), sharex=True)
    ax1.plot(ts, smile, label="smile"); ax1.plot(ts_face, mouth, label="mouth open", alpha=0.7)
    ax1.axhline(SMILE_THRESHOLD, ls="--", lw=0.8, color="gray")
    ax1.set_ylabel("expression"); ax1.legend(loc="upper right")
    ax2.plot(ts, yaw_s, label="yaw"); ax2.plot(ts, pitch_s, label="pitch")
    ax2.set_ylabel("head °"); ax2.legend(loc="upper right")
    if ts_pose:
        ax3.step(ts_pose, upright_series, where="post", label="upright (1/0)")
    ax3.set_ylabel("posture"); ax3.legend(loc="upper right")
    ax4.step(ts_face, gaze_on, where="post", color="teal", label="gaze on-camera (1/0)")
    ax4.set_ylabel("gaze"); ax4.set_xlabel("seconds"); ax4.legend(loc="upper right")
    for b in boundaries:
        for ax in (ax1, ax2, ax3, ax4):
            ax.axvline(b, color="red", lw=0.6, alpha=0.5)
    fig.suptitle("Interview timeline (red = new question)")
    fig.tight_layout()
    buf = io.BytesIO()
    fig.savefig(buf, format="png", dpi=120)
    plt.close(fig)
    buf.seek(0)
    return buf.read()


def _emotion_png(emotion: dict) -> bytes | None:
    timeline = emotion.get("timeline", [])
    if not timeline:
        return None
    ts = [s["t"] / 1000.0 for s in timeline]
    boundaries = [timeline[i]["t"] / 1000.0 for i in range(1, len(timeline))
                  if timeline[i]["turn"] != timeline[i - 1]["turn"]]
    fig, ax = plt.subplots(figsize=(14, 4))
    for c in EMOTION_CLASSES:
        ax.plot(ts, [s["scores"].get(c, 0.0) for s in timeline], label=c, lw=1.0)
    for b in boundaries:
        ax.axvline(b, color="red", lw=0.6, alpha=0.5)
    ax.set_xlabel("seconds"); ax.set_ylabel("emotion score (0-100)")
    ax.legend(loc="upper right", ncol=4, fontsize=8)
    fig.suptitle("Emotion over time (red = new question)")
    fig.tight_layout()
    buf = io.BytesIO()
    fig.savefig(buf, format="png", dpi=120)
    plt.close(fig)
    buf.seek(0)
    return buf.read()


def save_session(session_id: str, frames: list[dict], transcript: dict,
                 summary: dict, coaching: dict | None) -> None:
    prefix = f"sessions/{session_id}"

    # Generate all content on this thread first (matplotlib is not thread-safe).
    out = dict(summary)
    out["coaching"] = coaching
    uploads = [
        (f"{prefix}/data.csv",       _csv_bytes(frames),                    "text/csv"),
        (f"{prefix}/data.json",      json.dumps(frames).encode(),            "application/json"),
        (f"{prefix}/summary.json",   json.dumps(out, indent=2).encode(),     "application/json"),
        (f"{prefix}/transcript.txt", transcript.get("full_text", "").encode(),"text/plain"),
        (f"{prefix}/charts.png",     _charts_png(frames),                    "image/png"),
    ]
    emotion = summary.get("emotion") or {}
    if emotion.get("available"):
        try:
            png = _emotion_png(emotion)
            if png:
                uploads.append((f"{prefix}/emotion.png", png, "image/png"))
        except Exception as exc:
            logging.warning("emotion chart skipped: %s", exc)

    emotion_mp = summary.get("emotion_mediapipe") or {}
    if emotion_mp.get("available"):
        try:
            png = _emotion_png(emotion_mp)
            if png:
                uploads.append((f"{prefix}/emotion_mediapipe.png", png, "image/png"))
        except Exception as exc:
            logging.warning("mediapipe emotion chart skipped: %s", exc)

    # Upload all files in parallel.
    with ThreadPoolExecutor(max_workers=6) as ex:
        futs = [ex.submit(storage.put, key, body, ct) for key, body, ct in uploads]
        for f in as_completed(futs):
            f.result()  # re-raise any S3 error immediately

    # Update the session index so list_sessions stays fast.
    try:
        sessions_store.add_to_index(session_id, summary)
    except Exception as exc:
        logging.warning("index update failed (non-fatal): %s", exc)
