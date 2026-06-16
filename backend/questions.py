# backend/questions.py
"""Generate a tailored set of interview questions with Claude for the Practice
Interview page. The chosen set drives the live interview (see deepgram.py)."""
import json
import re

from anthropic import Anthropic

from backend.deepgram import FOCUS_GUIDANCE, DIFFICULTY_GUIDANCE, THINK_MODEL

SYSTEM_PROMPT = (
    "You write interview questions for a mock job interview. Given a role, a focus, and a "
    "difficulty, return ONLY a JSON array of concise interview questions (strings) tailored to "
    "them — no preamble, no numbering, no markdown, just the JSON array."
)


def parse_questions(raw: str) -> list:
    """Extract a JSON array of question strings from the model response, tolerating fences."""
    text = raw.strip()
    fenced = re.search(r"```(?:json)?\s*(\[.*\])\s*```", text, re.DOTALL)
    if fenced:
        text = fenced.group(1)
    else:
        bracket = re.search(r"\[.*\]", text, re.DOTALL)
        if bracket:
            text = bracket.group(0)
    try:
        data = json.loads(text)
    except (ValueError, TypeError):
        return []
    if not isinstance(data, list):
        return []
    return [str(q).strip() for q in data if str(q).strip()]


def generate_questions(api_key: str, role: str, focus: str, difficulty: str, n: int) -> list:
    """One Claude call returning up to `n` interview questions for the settings."""
    n = max(1, int(n))
    focus_line = FOCUS_GUIDANCE.get(focus, FOCUS_GUIDANCE["Mixed"])
    difficulty_line = DIFFICULTY_GUIDANCE.get(difficulty, DIFFICULTY_GUIDANCE["Realistic"])
    client = Anthropic(api_key=api_key)
    resp = client.messages.create(
        model=THINK_MODEL,
        max_tokens=1024,
        temperature=0.9,
        system=SYSTEM_PROMPT,
        messages=[{"role": "user", "content": (
            f"Role: {role}\nFocus: {focus} — {focus_line}\n"
            f"Difficulty: {difficulty} — {difficulty_line}\n"
            f"Write exactly {n} interview questions for this candidate as a JSON array of strings."
        )}],
    )
    return parse_questions(resp.content[0].text)[:n]
