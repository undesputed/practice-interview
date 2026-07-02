# backend/anthropic_coach.py
import json, re
from anthropic import Anthropic

COACH_MODEL = "claude-sonnet-4-6"

# Scenario -> coach persona and session label used in system prompts.
_SCENARIO_COACH = {
    "job":      ("an expert interview coach",           "mock job interview"),
    "present":  ("an expert presentation coach",        "practice presentation"),
    "tough":    ("a communication coach",               "tough conversation practice"),
    "pitch":    ("a pitch and persuasion coach",        "pitch/persuasion practice"),
    "teach":    ("an expert educator",                  "teaching or explanation session"),
    "language": ("a language fluency coach",            "spoken language practice session"),
}


def _coaching_system_prompt(scenario: str = "job") -> str:
    coach, label = _SCENARIO_COACH.get(scenario, _SCENARIO_COACH["job"])
    return (
        f"You are {coach}. Given a {label} transcript, return ONLY a JSON object with keys: "
        "summary (string), strengths (string[]), improvements (string[]), score (integer 1-10), "
        "rationale (string). No prose outside the JSON."
    )


def _verdict_system_prompt(scenario: str = "job") -> str:
    coach, label = _SCENARIO_COACH.get(scenario, _SCENARIO_COACH["job"])
    return (
        f"You are {coach} giving READINESS feedback for a {label} (self-improvement, never a "
        "hiring decision). You are given the candidate's transcript plus two already-computed "
        "scores: a Delivery score (voice: pace, fillers, pauses, expressiveness) and a Presence "
        "score (on-camera: eye contact, posture, composure), each 0-100. Judge ONLY the Content "
        "of their performance yourself. Return ONLY a JSON object with keys: content_score "
        "(integer 0-100 rating clarity, structure, specificity, and relevance of WHAT they said), "
        "headline (one warm sentence), delivery_note (one line on their voice, referencing the "
        "Delivery score), presence_note (one line on their on-camera presence, referencing the "
        "Presence score), content_note (one line on their content), strengths (string[] of 2-3), "
        "improvements (string[] of 2-3), next_action (one concrete next step). Plain, encouraging "
        "language. No prose outside the JSON."
    )


def parse_coaching(raw: str) -> dict:
    """Extract the coaching JSON from the model response, tolerating code fences."""
    text = raw.strip()
    fenced = re.search(r"```(?:json)?\s*(\{.*\})\s*```", text, re.DOTALL)
    if fenced:
        text = fenced.group(1)
    else:
        brace = re.search(r"\{.*\}", text, re.DOTALL)
        if brace:
            text = brace.group(0)
    try:
        data = json.loads(text)
        return {"summary": data.get("summary", ""),
                "strengths": data.get("strengths", []),
                "improvements": data.get("improvements", []),
                "score": data.get("score"),
                "rationale": data.get("rationale", "")}
    except (ValueError, AttributeError):
        return {"summary": "Coaching unavailable (could not parse model output).",
                "strengths": [], "improvements": [], "score": None, "rationale": ""}


def generate_coaching(api_key: str, transcript_text: str, role: str,
                      scenario: str = "job") -> dict:
    """Call Claude to produce structured coaching. System prompt is scenario-aware."""
    client = Anthropic(api_key=api_key)
    resp = client.messages.create(
        model=COACH_MODEL,
        max_tokens=1024,
        system=[{"type": "text", "text": _coaching_system_prompt(scenario),
                 "cache_control": {"type": "ephemeral"}}],
        messages=[{"role": "user",
                   "content": (f"Scenario: {scenario}\nRole: {role or 'general'}\n\n"
                                f"Transcript:\n{transcript_text}")}],
    )
    return parse_coaching(resp.content[0].text)



def parse_verdict(raw: str) -> dict:
    """Extract the verdict JSON from the model response, tolerating code fences."""
    text = raw.strip()
    fenced = re.search(r"```(?:json)?\s*(\{.*\})\s*```", text, re.DOTALL)
    if fenced:
        text = fenced.group(1)
    else:
        brace = re.search(r"\{.*\}", text, re.DOTALL)
        if brace:
            text = brace.group(0)
    try:
        data = json.loads(text)
        score = data.get("content_score")
        return {"content_score": int(score) if isinstance(score, (int, float)) else None,
                "headline": data.get("headline", ""),
                "delivery_note": data.get("delivery_note", ""),
                "presence_note": data.get("presence_note", ""),
                "content_note": data.get("content_note", ""),
                "strengths": data.get("strengths", []),
                "improvements": data.get("improvements", []),
                "next_action": data.get("next_action", "")}
    except (ValueError, AttributeError, TypeError):
        return {"content_score": None, "headline": "", "delivery_note": "",
                "presence_note": "", "content_note": "", "strengths": [],
                "improvements": [], "next_action": ""}


def generate_verdict(api_key: str, transcript_text: str, role: str,
                     delivery_score=None, presence_score=None,
                     scenario: str = "job") -> dict:
    """One Claude call: score Content (0-100) and write the readiness explanation,
    given the already-computed Delivery + Presence numbers. Scenario-aware."""
    client = Anthropic(api_key=api_key)
    d = "n/a" if delivery_score is None else str(delivery_score)
    p = "n/a" if presence_score is None else str(presence_score)
    resp = client.messages.create(
        model=COACH_MODEL,
        max_tokens=1024,
        system=[{"type": "text", "text": _verdict_system_prompt(scenario),
                 "cache_control": {"type": "ephemeral"}}],
        messages=[{"role": "user",
                   "content": (f"Scenario: {scenario}\nRole: {role or 'general'}\n"
                               f"Delivery score (voice): {d}/100\n"
                               f"Presence score (face/body): {p}/100\n\n"
                               f"Transcript:\n{transcript_text}")}],
    )
    return parse_verdict(resp.content[0].text)
