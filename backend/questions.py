# backend/questions.py
"""Generate a tailored set of interview questions with Claude for the Practice
Interview page. The chosen set drives the live session (see deepgram.py)."""
import json
import re

from anthropic import Anthropic

from backend.deepgram import FOCUS_GUIDANCE, THINK_MODEL

# Scenario -> what kind of questions/prompts Claude should generate.
SCENARIO_QUESTION_CONTEXT = {
    "job":      "You write interview questions for a mock job interview.",
    "present":  "You write evaluator prompts for a practice presentation session.",
    "tough":    "You write scenario prompts for practising a tough, high-stakes conversation.",
    "pitch":    "You write evaluator questions for a practice pitch or persuasion session.",
    "teach":    "You write prompts for a teaching or explanation practice session.",
    "language": "You write conversation topics and prompts for spoken language practice.",
}

# Controls question COMPLEXITY for pre-generation (not live interviewer tone).
# Deliberately separate from DIFFICULTY_GUIDANCE in deepgram.py, which governs
# how the live AI interviewer behaves during the session.
DIFFICULTY_QUESTION_GUIDANCE = {
    "Warm-up": (
        "Write simple, friendly, open-ended questions — the kind heard in the first few minutes "
        "of a relaxed, welcoming interview. Focus on background, motivation, and general "
        "experience. No trick questions, no deep technical dives, no edge cases. "
        "Questions should feel easy and inviting, like 'Tell me about yourself' or "
        "'What made you interested in this field?'"
    ),
    "Realistic": (
        "Write clear, direct questions that a typical interviewer would ask in a real industry "
        "interview for this role. Include a mix of experience-based questions "
        "('Tell me about a time when...'), situational questions ('How would you handle...'), "
        "and one or two role-specific questions. Keep each question concrete and answerable "
        "without requiring 10+ years of experience unless the role demands it."
    ),
    "Hard": (
        "Write challenging questions requiring deep expertise, nuanced trade-off reasoning, or "
        "scenario-based problem-solving. Include design decisions, edge cases, or situations "
        "with no single right answer. Questions should push the candidate for depth, "
        "specificity, and evidence of senior-level thinking."
    ),
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
    focus_line      = FOCUS_GUIDANCE.get(focus, FOCUS_GUIDANCE["Mixed"])
    difficulty_line = DIFFICULTY_QUESTION_GUIDANCE.get(difficulty, DIFFICULTY_QUESTION_GUIDANCE["Realistic"])
    scenario_ctx    = SCENARIO_QUESTION_CONTEXT.get(scenario, SCENARIO_QUESTION_CONTEXT["job"])
    lang_instruction = " Write all questions in Japanese." if language == "ja" else ""

    system_prompt = (
        f"{scenario_ctx} "
        "Return ONLY a JSON array of interview questions (strings). "
        "Questions must sound natural and conversational — exactly as a real interviewer would "
        "speak them aloud. Keep each question short and direct (1-2 sentences). "
        "Do not pad questions with elaborate context or preamble. "
        "No numbering, no markdown, no extra keys — just the JSON array of question strings."
        f"{lang_instruction}"
    )
    item_word = "questions" if scenario == "job" else "questions or prompts"
    client = Anthropic(api_key=api_key, timeout=30.0)
    resp = client.messages.create(
        model=THINK_MODEL,
        max_tokens=800,
        temperature=0.85,
        system=system_prompt,
        messages=[{"role": "user", "content": (
            f"Scenario: {scenario}\n"
            f"Role: {role or 'general'}\n"
            f"Focus: {focus} — {focus_line}\n"
            f"Difficulty: {difficulty} — {difficulty_line}\n"
            f"Write exactly {n} {item_word} as a JSON array of strings."
        )}],
    )
    return parse_questions(resp.content[0].text)[:n]
