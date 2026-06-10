from __future__ import annotations
import logging

# DeepFace's FER model emits these 7 classes (no "contempt").
EMOTION_CLASSES = ["angry", "disgust", "fear", "happy", "sad", "surprise", "neutral"]


def aggregate_emotions(shots: list[dict]) -> dict:
    """Aggregate per-shot emotion records into the report's emotion summary.

    Each shot: {"t": float_ms, "turn": int, "dominant": str, "scores": {class: 0-100}}.
    Distribution = percent of shots for which a class is the dominant emotion.
    Returns {"available": False} when there are no shots.
    """
    if not shots:
        return {"available": False}

    n = len(shots)
    dom_counts = {c: 0 for c in EMOTION_CLASSES}
    for s in shots:
        if s["dominant"] in dom_counts:
            dom_counts[s["dominant"]] += 1
    overall = {c: round(100.0 * dom_counts[c] / n, 1) for c in EMOTION_CLASSES}
    dominant = max(dom_counts, key=dom_counts.get)

    by_turn: dict[int, list[dict]] = {}
    for s in shots:
        by_turn.setdefault(s.get("turn", -1), []).append(s)
    per_question = []
    for turn in sorted(t for t in by_turn if t >= 0):
        group = by_turn[turn]
        c = {cl: 0 for cl in EMOTION_CLASSES}
        for s in group:
            if s["dominant"] in c:
                c[s["dominant"]] += 1
        m = len(group)
        per_question.append({
            "turn": turn,
            "dominant": max(c, key=c.get),
            "distribution": {cl: round(100.0 * c[cl] / m, 1) for cl in EMOTION_CLASSES},
        })

    timeline = [{"t": s["t"], "turn": s.get("turn", -1),
                 "dominant": s["dominant"], "scores": s["scores"]}
                for s in sorted(shots, key=lambda s: s["t"])]

    return {"available": True, "dominant": dominant, "overall_distribution": overall,
            "per_question": per_question, "timeline": timeline}


def score_emotions(images: list[bytes], detector_backend: str = "skip") -> list[dict | None]:
    """Run DeepFace emotion analysis on each JPEG byte string.

    Returns a list aligned with `images`; each element is
    {"dominant": str, "scores": {class: 0-100}} or None if that shot failed.
    `detector_backend` controls DeepFace's face detection + alignment: "skip" trusts
    the caller's crop (fast — the batch path), while a real backend like "retinaface"
    or "opencv" detects and eye-aligns the face before scoring, which is markedly more
    accurate on rough crops (the live single-frame path). With enforce_detection=False
    a failed detect falls back to the whole image, so a real backend is never worse.
    Lazy-imports DeepFace (and cv2/numpy) so the app boots without them; raises
    ImportError if DeepFace is unavailable. Images are never written to disk.
    """
    from deepface import DeepFace  # lazy, heavy (TensorFlow)
    import numpy as np
    import cv2

    out: list[dict | None] = []
    for buf in images:
        try:
            arr = cv2.imdecode(np.frombuffer(buf, np.uint8), cv2.IMREAD_COLOR)
            if arr is None:
                raise ValueError("could not decode image")
            res = DeepFace.analyze(arr, actions=["emotion"], detector_backend=detector_backend,
                                   enforce_detection=False, silent=True)
            r = res[0] if isinstance(res, list) else res
            emo = r["emotion"]
            out.append({"dominant": r["dominant_emotion"],
                        "scores": {c: round(float(emo.get(c, 0.0)), 1) for c in EMOTION_CLASSES}})
        except Exception as exc:  # one bad frame must not sink the batch
            logging.warning("emotion shot skipped: %s", exc)
            out.append(None)
    return out
