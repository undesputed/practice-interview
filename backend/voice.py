# backend/voice.py
"""Voice (audio delivery) analysis for a finished interview.

Two halves:
  - prosody from Deepgram pre-recorded words (pace, pauses, fillers) — exact
    counts, unaffected by mic AGC;
  - a Delivery score (0-100) that combines prosody with the browser-computed
    pitch/energy features against ABSOLUTE target bands.

Ported measurement logic from molave-ai (voiceMetrics.ts); the scoring is new
(absolute bands, because a readiness verdict needs "is this good?").
"""
import logging

import httpx

DEEPGRAM_PRERECORDED_URL = "https://api.deepgram.com/v1/listen"

# Vocalized fillers Deepgram returns when filler_words=true (ported from molave).
FILLER_TOKENS = {
    "um", "umm", "uhm", "uh", "er", "err", "ah", "ahh", "eh", "mm", "mmm",
    "hmm", "mhm",
}
PAUSE_MIN_MS = 300       # a gap >= this counts as a pause
LONG_PAUSE_MS = 1500     # a gap >= this is a "long pause"

# Delivery term weights (sum to 1.0). Pace/fillers/pauses come from word timings
# and are unaffected by mic AGC, so they carry the most. Energy is least reliable
# under AGC, so it gets the least.
DELIVERY_WEIGHTS = {
    "pace": 0.30,
    "fillers": 0.25,
    "pauses": 0.15,
    "pitch": 0.20,
    "energy": 0.10,
}


def parse_words(payload):
    """Extract a flat word list from a Deepgram pre-recorded JSON response.

    Returns [{text, start_ms, end_ms}] using the first channel's first
    alternative. Prefers punctuated_word; converts seconds to ms.
    """
    out = []
    try:
        alts = payload["results"]["channels"][0]["alternatives"]
        words = alts[0].get("words", []) if alts else []
    except (KeyError, IndexError, TypeError):
        return out
    for w in words:
        if not isinstance(w, dict):
            continue
        text = w.get("punctuated_word") or w.get("word") or ""
        if not text:
            continue
        out.append({
            "text": text,
            "start_ms": int(round(float(w.get("start", 0.0)) * 1000)),
            "end_ms": int(round(float(w.get("end", 0.0)) * 1000)),
        })
    return out


def _is_filler(text):
    token = "".join(ch for ch in text.lower() if ch.isalpha())
    return token in FILLER_TOKENS


def measure_prosody(words):
    """Pace / pauses / fillers from a flat word list. Ported from molave."""
    n = len(words)
    if n == 0:
        return {"word_count": 0, "talk_time_s": 0.0, "wpm": 0, "pause_count": 0,
                "long_pause_count": 0, "avg_pause_ms": 0, "filler_count": 0,
                "filler_rate_per100": 0.0}
    start_ms = words[0]["start_ms"]
    end_ms = words[-1]["end_ms"]
    talk_time_s = max(0.0, (end_ms - start_ms) / 1000.0)
    wpm = round((n / talk_time_s) * 60) if talk_time_s > 0 else 0

    filler_count = sum(1 for w in words if _is_filler(w["text"]))

    pause_gaps = []
    long_pause_count = 0
    for i in range(1, n):
        gap = words[i]["start_ms"] - words[i - 1]["end_ms"]
        if gap >= PAUSE_MIN_MS:
            pause_gaps.append(gap)
            if gap >= LONG_PAUSE_MS:
                long_pause_count += 1
    avg_pause_ms = round(sum(pause_gaps) / len(pause_gaps)) if pause_gaps else 0
    filler_rate = (filler_count / n) * 100

    return {"word_count": n, "talk_time_s": round(talk_time_s, 1), "wpm": wpm,
            "pause_count": len(pause_gaps), "long_pause_count": long_pause_count,
            "avg_pause_ms": avg_pause_ms, "filler_count": filler_count,
            "filler_rate_per100": round(filler_rate, 2)}


def _band(value, ideal_lo, ideal_hi, zero_lo, zero_hi):
    """1.0 inside [ideal_lo, ideal_hi]; linear down to 0 at zero_lo / zero_hi."""
    if ideal_lo <= value <= ideal_hi:
        return 1.0
    if value < ideal_lo:
        if value <= zero_lo:
            return 0.0
        return (value - zero_lo) / (ideal_lo - zero_lo)
    if value >= zero_hi:
        return 0.0
    return (zero_hi - value) / (zero_hi - ideal_hi)


def _decay_high(value, ideal_max, zero_at):
    """1.0 at <= ideal_max, linear down to 0 at zero_at (penalizes high values)."""
    if value <= ideal_max:
        return 1.0
    if value >= zero_at:
        return 0.0
    return (zero_at - value) / (zero_at - ideal_max)


def _ramp_low(value, ideal_min, zero_at):
    """1.0 at >= ideal_min, linear down to 0 at zero_at (penalizes low values)."""
    if value >= ideal_min:
        return 1.0
    if value <= zero_at:
        return 0.0
    return (value - zero_at) / (ideal_min - zero_at)


def compute_delivery(prosody, acoustic):
    """Combine prosody + browser acoustic features into a 0-100 Delivery score.

    When the browser couldn't produce acoustic features (DSP failed / no audio),
    the pitch + energy terms are dropped and the remaining weights are renormalized,
    so a missing-acoustic result is a reweighted prosody score, not a penalized one.
    """
    acoustic = acoustic or {}
    has_acoustic = "pitchStdHz" in acoustic and "energyMean" in acoustic
    scores = {
        "pace": _band(prosody.get("wpm", 0), 110, 160, 60, 220),
        "fillers": _decay_high(prosody.get("filler_rate_per100", 0.0), 3.0, 15.0),
        "pauses": _decay_high(prosody.get("long_pause_count", 0), 2, 10),
    }
    if has_acoustic:
        scores["pitch"] = _ramp_low(float(acoustic["pitchStdHz"]), 25.0, 5.0)
        scores["energy"] = _ramp_low(float(acoustic["energyMean"]), 0.02, 0.002)

    weight_sum = sum(DELIVERY_WEIGHTS[k] for k in scores)
    breakdown = []
    total = 0.0
    for key in scores:
        weight = DELIVERY_WEIGHTS[key] / weight_sum   # renormalize over present terms
        s = scores[key]
        total += weight * s
        breakdown.append({"key": key, "score": round(s, 3), "weight": round(weight, 3),
                          "points": round(weight * s * 100, 1)})
    return {"available": True, "delivery_score": round(total * 100),
            "metrics": {**prosody,
                        "pitch_std_hz": round(float(acoustic.get("pitchStdHz", 0.0)), 1),
                        "energy_mean": round(float(acoustic.get("energyMean", 0.0)), 4),
                        "voiced_ratio": round(float(acoustic.get("voicedRatio", 0.0)), 2)},
            "breakdown": breakdown}


async def transcribe_prerecorded(audio_bytes, content_type, api_key):
    """Deepgram pre-recorded transcription with word timings + fillers.

    Returns the raw JSON payload (parse with parse_words). Raises on HTTP error.
    """
    params = {"model": "nova-2", "filler_words": "true", "punctuate": "true",
              "smart_format": "true"}
    async with httpx.AsyncClient(timeout=60.0) as client:
        resp = await client.post(
            DEEPGRAM_PRERECORDED_URL,
            params=params,
            headers={"Authorization": f"Token {api_key}",
                     "Content-Type": content_type or "audio/webm"},
            content=audio_bytes,
        )
        resp.raise_for_status()
        return resp.json()
