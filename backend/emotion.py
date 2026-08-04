from __future__ import annotations
import logging
import os

# The 7 emotion classes used across the app (frontend display, report, charts).
EMOTION_CLASSES = ["angry", "disgust", "fear", "happy", "sad", "surprise", "neutral"]

# HSEmotion (AffectNet) emits 8 classes; map them onto our 7. "Contempt" has no FER
# equivalent, so it is dropped and the remaining scores are renormalized.
_HSE_TO_FER = {
    "Anger": "angry", "Disgust": "disgust", "Fear": "fear", "Happiness": "happy",
    "Neutral": "neutral", "Sadness": "sad", "Surprise": "surprise",
}

_recognizer = None  # cached HSEmotionRecognizer (the model downloads on first build)


def _get_recognizer():
    """Lazily build + cache the HSEmotion recognizer (ONNX). Raises ImportError when
    hsemotion-onnx is not installed, so callers can degrade to "unavailable"."""
    global _recognizer
    if _recognizer is None:
        from hsemotion_onnx.facial_emotions import HSEmotionRecognizer
        _recognizer = HSEmotionRecognizer(model_name=os.getenv("HSEMOTION_MODEL", "enet_b2_8"))
    return _recognizer


def aggregate_emotions(shots: list[dict], classes: list | None = None) -> dict:
    """Aggregate per-shot emotion records into the report's emotion summary.

    Each shot: {"t": float_ms, "turn": int, "dominant": str, "scores": {class: 0-100}}.

    overall_distribution is an intensity-weighted MEAN of each shot's soft scores
    (then renormalized to 100). It is NOT "percent of frames where X was #1" —
    winner-take-all collapses interviews to ~one emotion (usually neutral) because
    resting-face frames dominate. Soft-mean keeps secondary expressions visible;
    frames with stronger non-neutral activation weigh more than flat ones.
    """
    classes = classes or EMOTION_CLASSES
    if not shots:
        return {"available": False}

    def _weighted_distribution(group: list[dict]) -> dict:
        accum = {c: 0.0 for c in classes}
        wsum = 0.0
        for s in group:
            scores = s.get("scores") or {}
            expressive = max(
                (float(scores.get(c, 0) or 0) for c in classes if c != "neutral"),
                default=0.0,
            )
            # Flat/resting frames still count a little; clear expressions count more.
            w = 0.2 + expressive / 100.0
            for c in classes:
                accum[c] += w * float(scores.get(c, 0) or 0)
            wsum += w
        if wsum <= 0:
            return {c: (100.0 if c == "neutral" else 0.0) for c in classes}
        mean = {c: accum[c] / wsum for c in classes}
        total = sum(mean.values())
        if total <= 0:
            return {c: (100.0 if c == "neutral" else 0.0) for c in classes}
        return {c: round(100.0 * mean[c] / total, 1) for c in classes}

    overall = _weighted_distribution(shots)
    dominant = max(overall, key=overall.get)

    by_turn: dict[int, list[dict]] = {}
    for s in shots:
        by_turn.setdefault(s.get("turn", -1), []).append(s)
    per_question = []
    for turn in sorted(t for t in by_turn if t >= 0):
        group = by_turn[turn]
        dist = _weighted_distribution(group)
        per_question.append({
            "turn": turn,
            "dominant": max(dist, key=dist.get),
            "distribution": dist,
        })

    timeline = [{"t": s["t"], "turn": s.get("turn", -1),
                 "dominant": s["dominant"], "scores": s["scores"]}
                for s in sorted(shots, key=lambda s: s["t"])]

    return {"available": True, "dominant": dominant, "overall_distribution": overall,
            "per_question": per_question, "timeline": timeline}


def score_emotions(images: list[bytes]) -> list[dict | None]:
    """Classify each JPEG face crop with HSEmotion (AffectNet EfficientNet, ONNX).

    Returns a list aligned with `images`; each element is
    {"dominant": str, "scores": {class: 0-100}} mapped to the app's 7 classes
    (HSEmotion's "Contempt" is dropped and the rest renormalized), or None if that
    shot failed. Callers pre-crop the face (MediaPipe / interview capture), so no
    face detection happens here. Lazy-imports hsemotion-onnx (+cv2/numpy) so the app
    boots without them; raises ImportError if hsemotion-onnx is unavailable. Images
    are never written to disk.
    """
    import numpy as np
    import cv2

    rec = _get_recognizer()  # raises ImportError if hsemotion-onnx is missing
    out: list[dict | None] = []
    for buf in images:
        try:
            arr = cv2.imdecode(np.frombuffer(buf, np.uint8), cv2.IMREAD_COLOR)  # BGR
            if arr is None:
                raise ValueError("could not decode image")
            rgb = cv2.cvtColor(arr, cv2.COLOR_BGR2RGB)  # HSEmotion expects RGB
            _, scores = rec.predict_emotions(rgb, logits=False)  # probabilities over 8 classes
            idx_to_class = rec.idx_to_class
            fer = {c: 0.0 for c in EMOTION_CLASSES}
            for i, p in enumerate(scores):
                mapped = _HSE_TO_FER.get(idx_to_class[i])
                if mapped:
                    fer[mapped] += float(p)
            total = sum(fer.values())
            if total <= 0:
                raise ValueError("empty emotion distribution")
            out.append({
                "dominant": max(fer, key=fer.get),
                "scores": {c: round(fer[c] / total * 100.0, 1) for c in EMOTION_CLASSES},
            })
        except Exception as exc:  # one bad frame must not sink the batch
            logging.warning("emotion shot skipped: %s", exc)
            out.append(None)
    return out
