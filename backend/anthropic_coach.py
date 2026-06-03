# backend/anthropic_coach.py
import json, re
from anthropic import Anthropic

COACH_MODEL = "claude-sonnet-4-6"

SYSTEM_PROMPT = (
    "You are an expert interview coach. Given an interview transcript, return ONLY a JSON "
    "object with keys: summary (string), strengths (string[]), improvements (string[]), "
    "score (integer 1-10), rationale (string). No prose outside the JSON."
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


def generate_coaching(api_key: str, transcript_text: str, role: str) -> dict:
    """Call Claude to produce structured interview coaching. Prompt caching on the system block."""
    client = Anthropic(api_key=api_key)
    resp = client.messages.create(
        model=COACH_MODEL,
        max_tokens=1024,
        system=[{"type": "text", "text": SYSTEM_PROMPT,
                 "cache_control": {"type": "ephemeral"}}],
        messages=[{"role": "user",
                   "content": f"Role: {role}\n\nTranscript:\n{transcript_text}"}],
    )
    return parse_coaching(resp.content[0].text)
