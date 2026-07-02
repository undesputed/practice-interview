# backend/questions.py
"""Generate a tailored set of interview questions with Claude for the Practice
Interview page. The chosen set drives the live session (see deepgram.py)."""
import json
import re

from anthropic import Anthropic

from backend.deepgram import FOCUS_GUIDANCE, DIFFICULTY_GUIDANCE, THINK_MODEL

# Scenario -> what kind of questions/prompts Claude should generate.
SCENARIO_QUESTION_CONTEXT = {
    "job":      "You write interview questions for a mock job interview.",
    "present":  "You write evaluator prompts for a practice presentation session.",
    "tough":    "You write scenario prompts for practising a tough, high-stakes conversation.",
    "pitch":    "You write evaluator questions for a practice pitch or persuasion session.",
    "teach":    "You write prompts for a teaching or explanation practice session.",
    "language": "You write conversation topics and prompts for spoken language practice.",
}


def parse_questions(raw: str) -> list:
    """Extract a JSON array of question strings from the model response, tolerating fences."""
    text = (raw or "").strip()
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
    return [q.strip() for q in data if isinstance(q, str) and q.strip()]


def generate_questions(api_key: str, role: str, focus: str, difficulty: str, n: int,
                       scenario: str = "job", language: str = "en") -> list:
    """One Claude call returning up to `n` scenario-appropriate questions for the settings."""
    n = max(1, int(n))
    focus_line = FOCUS_GUIDANCE.get(focus, FOCUS_GUIDANCE["Mixed"])
    difficulty_line = DIFFICULTY_GUIDANCE.get(difficulty, DIFFICULTY_GUIDANCE["Realistic"])
    scenario_ctx = SCENARIO_QUESTION_CONTEXT.get(scenario, SCENARIO_QUESTION_CONTEXT["job"])
    lang_instruction = " Write all questions in Japanese." if language == "ja" else ""
    system_prompt = (
        f"{scenario_ctx} Given a scenario, role, focus, and difficulty, return ONLY a JSON array "
        "of concise questions or prompts (strings) tailored to them — no preamble, no numbering, "
        f"no markdown, just the JSON array.{lang_instruction}"
    )
    item_word = "questions" if scenario == "job" else "questions or prompts"
    client = Anthropic(api_key=api_key)
    resp = client.messages.create(
        model=THINK_MODEL,
        max_tokens=1024,
        temperature=0.9,
        system=system_prompt,
        messages=[{"role": "user", "content": (
            f"Scenario: {scenario}\nRole: {role or 'general'}\n"
            f"Focus: {focus} — {focus_line}\n"
            f"Difficulty: {difficulty} — {difficulty_line}\n"
            f"Write exactly {n} {item_word} as a JSON array of strings."
        )}],
    )
    return parse_questions(resp.content[0].text)[:n]
