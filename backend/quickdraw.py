# backend/quickdraw.py
# Claude Vision-based drawing guesser for the Quick Draw challenge page.
import base64
import json
import logging
import re

from anthropic import Anthropic

GUESS_MODEL = "claude-sonnet-4-6"

_SYSTEM = (
    "You are an AI in a Quick Draw-style game. "
    "The player drew on a black canvas with white finger-strokes. "
    "You guess what they drew even if it is partial or rough. "
    "ALWAYS reply with ONLY valid JSON — no markdown, no explanation."
)

_PROMPT = (
    'The player was asked to draw: "{prompt}". '
    "Look at their white-on-black finger drawing (may be partial or rough) and reply ONLY with JSON: "
    '{{"guesses": [{{"word": "...", "score": <0-100>}}, {{"word": "...", "score": <0-100>}}, {{"word": "...", "score": <0-100>}}], "comment": "<one short fun sentence>"}} '
    "Return exactly 3 guesses ranked by confidence (best first). "
    "Scoring: clear match → 70-90, rough but recognisable → 55-70, possible → 30-54, empty/wrong → 5-30. "
    "Be generous — air-drawn finger doodles are always rough. Never refuse to guess."
)


def _parse_json(raw: str) -> dict:
    """Extract JSON from Claude's response, tolerating markdown fences and surrounding text."""
    raw = raw.strip()
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        pass
    # Strip markdown fences
    if "```" in raw:
        for part in raw.split("```")[1::2]:
            cleaned = part.lstrip("json").strip()
            try:
                return json.loads(cleaned)
            except json.JSONDecodeError:
                pass
    # Find outermost { ... } (handles nested arrays/objects)
    start = raw.find('{')
    end = raw.rfind('}')
    if start != -1 and end > start:
        try:
            return json.loads(raw[start:end + 1])
        except json.JSONDecodeError:
            pass
    raise ValueError(f"No JSON found in response: {raw[:200]!r}")


def guess_drawing(api_key: str, image_bytes: bytes, prompt: str) -> dict:
    client = Anthropic(api_key=api_key, timeout=30.0)
    b64 = base64.b64encode(image_bytes).decode()
    resp = client.messages.create(
        model=GUESS_MODEL,
        max_tokens=300,
        system=_SYSTEM,
        messages=[{
            "role": "user",
            "content": [
                {
                    "type": "image",
                    "source": {"type": "base64", "media_type": "image/png", "data": b64},
                },
                {"type": "text", "text": _PROMPT.format(prompt=prompt)},
            ],
        }],
    )
    raw = resp.content[0].text
    logging.debug("quickdraw raw response: %r", raw[:300])
    data = _parse_json(raw)

    # Normalise: guarantee both "guesses" array and legacy "guess"/"score" fields.
    guesses = data.get("guesses") or []
    if not guesses and "guess" in data:
        guesses = [{"word": data["guess"], "score": data.get("score", 50)}]
    top = guesses[0] if guesses else {"word": "mystery drawing", "score": 30}
    data["guesses"] = guesses
    data.setdefault("guess", top.get("word", "mystery drawing"))
    data.setdefault("score", top.get("score", 30))
    return data
