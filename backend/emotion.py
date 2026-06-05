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
        dom_counts[s["dominant"]] = dom_counts.get(s["dominant"], 0) + 1
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
