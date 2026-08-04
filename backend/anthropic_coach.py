# backend/anthropic_coach.py
import json, re
from typing import Optional
from anthropic import Anthropic

COACH_MODEL = "claude-sonnet-4-6"

# Scenario -> coach persona and session label used in system prompts.
_SCENARIO_COACH = {
    "job":      ("an expert interview coach",           "mock job interview"),
    "present":  ("an expert presentation coach",        "practice presentation"),
    "tough":    ("a communication coach",               "tough conversation practice"),
    "pitch":    ("a pitch and persuasion coach",        "pitch/persuasion practice"),
    "negotiate": ("a negotiation coach",                  "negotiation practice session"),
    "case":      ("a case interview coach",               "case interview practice session"),
}


def _lang_instruction(language: str = "en") -> str:
    if language == "ja":
        return (
            " CRITICAL LANGUAGE RULE: Every user-facing string MUST be written in natural "
            "Japanese (日本語). Never English. This includes headline, delivery_note, "
            "presence_note, content_note, strengths, improvements, next_action, summary, "
            "and rationale. Keep JSON keys in English. Prefer short scannable phrases a busy "
            "executive can grasp in seconds — no long explanations of why."
        )
    return (
        " Keep every user-facing string short and scannable for a busy executive: "
        "headline ≤12 words; each strength/improvement ≤10 words; next_action one concrete step. "
        "No long explanations of why — just what and what to do."
    )


def _coaching_system_prompt(scenario: str = "job", language: str = "en") -> str:
    coach, label = _SCENARIO_COACH.get(scenario, _SCENARIO_COACH["job"])
    return (
        f"You are {coach}. Given a {label} transcript, return ONLY a JSON object with keys: "
        "summary (string), strengths (string[]), improvements (string[]), score (integer 1-10), "
        "rationale (string). No prose outside the JSON."
        + _lang_instruction(language)
    )


def _verdict_system_prompt(scenario: str = "job", language: str = "en") -> str:
    coach, label = _SCENARIO_COACH.get(scenario, _SCENARIO_COACH["job"])
    return (
        f"You are {coach} giving READINESS feedback for a {label} (self-improvement, never a "
        "hiring decision). You are given the candidate's transcript plus two already-computed "
        "scores: a Delivery score (voice: pace, fillers, pauses, expressiveness) and a Presence "
        "score (on-camera: eye contact, posture, composure), each 0-100. Judge ONLY the Content "
        "of their performance yourself. Return ONLY a JSON object with keys: content_score "
        "(integer 0-100 rating clarity, structure, specificity, and relevance of WHAT they said), "
        "headline (one short sentence — the whole takeaway), delivery_note (one short line on "
        "their voice, referencing the Delivery score), presence_note (one short line on their "
        "on-camera presence, referencing the Presence score), content_note (one short line on "
        "their content), strengths (string[] of 2-3 short phrases), improvements (string[] of "
        "2-3 short action phrases — what to fix, not why), next_action (one concrete next step). "
        "Plain, encouraging language. No prose outside the JSON."
        + _lang_instruction(language)
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
                      scenario: str = "job", language: str = "en") -> dict:
    """Call Claude to produce structured coaching. System prompt is scenario-aware."""
    client = Anthropic(api_key=api_key, timeout=42.0)
    resp = client.messages.create(
        model=COACH_MODEL,
        max_tokens=700,
        system=[{"type": "text", "text": _coaching_system_prompt(scenario, language),
                 "cache_control": {"type": "ephemeral"}}],
        messages=[{"role": "user",
                   "content": (f"Scenario: {scenario}\nRole: {role or 'general'}\n"
                                f"Output language: {language}\n\n"
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
                     scenario: str = "job", language: str = "en") -> dict:
    """One Claude call: score Content (0-100) and write the readiness explanation,
    given the already-computed Delivery + Presence numbers. Scenario-aware."""
    client = Anthropic(api_key=api_key, timeout=42.0)
    d = "n/a" if delivery_score is None else str(delivery_score)
    p = "n/a" if presence_score is None else str(presence_score)
    resp = client.messages.create(
        model=COACH_MODEL,
        max_tokens=900,
        system=[{"type": "text", "text": _verdict_system_prompt(scenario, language),
                 "cache_control": {"type": "ephemeral"}}],
        messages=[{"role": "user",
                   "content": (f"Scenario: {scenario}\nRole: {role or 'general'}\n"
                               f"Output language: {language}\n"
                               f"Delivery score (voice): {d}/100\n"
                               f"Presence score (face/body): {p}/100\n\n"
                               f"Transcript:\n{transcript_text}")}],
    )
    return parse_verdict(resp.content[0].text)


_VERDICT_TEXT_KEYS = (
    "headline", "delivery_note", "presence_note", "content_note",
    "strengths", "improvements", "next_action",
)
_COACH_TEXT_KEYS = ("summary", "strengths", "improvements", "rationale")


def translate_feedback(api_key: str, verdict: Optional[dict] = None,
                       coaching: Optional[dict] = None,
                       language: str = "ja") -> dict:
    """Translate saved verdict/coaching prose into `language`. Scores are not touched.

    Returns {"verdict": {...text fields...}, "coaching": {...}} with only the
    translatable fields filled in. Empty input sections stay None.
    """
    if language != "ja":
        return {"verdict": None, "coaching": None}

    payload = {}
    if verdict:
        payload["verdict"] = {k: verdict.get(k) for k in _VERDICT_TEXT_KEYS if k in verdict}
    if coaching:
        payload["coaching"] = {k: coaching.get(k) for k in _COACH_TEXT_KEYS if k in coaching}
    if not payload:
        return {"verdict": None, "coaching": None}

    client = Anthropic(api_key=api_key, timeout=42.0)
    resp = client.messages.create(
        model=COACH_MODEL,
        max_tokens=900,
        system=[{
            "type": "text",
            "text": (
                "You translate interview-feedback JSON into concise natural Japanese for a "
                "busy executive. Return ONLY a JSON object with the same shape as the input. "
                "Keep every JSON key identical. Translate every string value (and every string "
                "inside arrays) into Japanese. Do not add keys. Do not explain. Keep bullets "
                "short — no long why-explanations."
            ),
            "cache_control": {"type": "ephemeral"},
        }],
        messages=[{"role": "user", "content": json.dumps(payload, ensure_ascii=False)}],
    )
    text = resp.content[0].text.strip()
    fenced = re.search(r"```(?:json)?\s*(\{.*\})\s*```", text, re.DOTALL)
    if fenced:
        text = fenced.group(1)
    else:
        brace = re.search(r"\{.*\}", text, re.DOTALL)
        if brace:
            text = brace.group(0)
    try:
        data = json.loads(text)
    except (ValueError, AttributeError):
        return {"verdict": None, "coaching": None}

    out_v = None
    out_c = None
    if isinstance(data.get("verdict"), dict):
        src = data["verdict"]
        out_v = {k: src.get(k, verdict.get(k) if verdict else "") for k in _VERDICT_TEXT_KEYS}
        # Preserve list types
        for k in ("strengths", "improvements"):
            if not isinstance(out_v.get(k), list):
                out_v[k] = list(verdict.get(k) or []) if verdict else []
    if isinstance(data.get("coaching"), dict):
        src = data["coaching"]
        out_c = {k: src.get(k, coaching.get(k) if coaching else "") for k in _COACH_TEXT_KEYS}
        for k in ("strengths", "improvements"):
            if not isinstance(out_c.get(k), list):
                out_c[k] = list(coaching.get(k) or []) if coaching else []
    return {"verdict": out_v, "coaching": out_c}
