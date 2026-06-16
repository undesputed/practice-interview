# backend/verdict.py
"""Fused readiness rubric: combine Delivery (voice), Presence (face/body), and
Content (transcript) into one readiness score + band.

The numbers here are authoritative; the Claude call in anthropic_coach.py only
writes the explanation prose and the Content score. Weights are the approved
delivery+presence-first split. Missing signals are dropped and the remaining
weights renormalized, so a partial result is reweighted, never penalized.
"""

WEIGHTS = {"delivery": 0.40, "presence": 0.35, "content": 0.25}
READY_MIN = 70    # >= -> "ready"
ALMOST_MIN = 50   # >= -> "almost", else "needs_work"


def presence_score(overall):
    """Presence (0-100) = mean(Attention, Confidence, Composure, 100 - Nervousness).

    Uses whatever composites are present in `overall`; returns None if none are.
    """
    overall = overall or {}
    parts = []
    for key in ("attention", "confidence", "composure"):
        v = overall.get(key)
        if isinstance(v, (int, float)):
            parts.append(float(v))
    nervousness = overall.get("nervousness")
    if isinstance(nervousness, (int, float)):
        parts.append(100.0 - float(nervousness))
    return round(sum(parts) / len(parts)) if parts else None


def band(score):
    if score >= READY_MIN:
        return "ready"
    if score >= ALMOST_MIN:
        return "almost"
    return "needs_work"


def compute_readiness(delivery, presence, content):
    """Weighted fusion of the three 0-100 sub-scores (any may be None).

    Returns {readiness_score, band, components, weights_used}. When some signals
    are absent, the present weights are renormalized to sum to 1.0.
    """
    components = {"delivery": delivery, "presence": presence, "content": content}
    present = {k: v for k, v in components.items() if isinstance(v, (int, float))}
    if not present:
        return {"readiness_score": None, "band": None,
                "components": components, "weights_used": {}}
    weight_sum = sum(WEIGHTS[k] for k in present)
    score = sum((WEIGHTS[k] / weight_sum) * float(present[k]) for k in present)
    rs = round(score)
    return {"readiness_score": rs, "band": band(rs), "components": components,
            "weights_used": {k: round(WEIGHTS[k] / weight_sum, 3) for k in present}}
