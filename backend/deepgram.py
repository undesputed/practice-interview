# backend/deepgram.py
import httpx

DEEPGRAM_AGENT_URL = "wss://agent.deepgram.com/v1/agent/converse"
THINK_MODEL = "claude-sonnet-4-6"
TTS_MODEL = "aura-2-thalia-en"


# How the New-interview "Focus" choice shapes the kinds of questions Claude asks.
FOCUS_GUIDANCE = {
    "Behavioral": "Ask behavioral and situational questions, and encourage STAR-style answers "
                  "(Situation, Task, Action, Result).",
    "Technical": "Ask technical, role-specific questions that probe depth of knowledge and "
                 "problem-solving for this role.",
    "Mixed": "Mix behavioral questions with technical, role-specific ones.",
}

# How the "Difficulty" choice shapes tone and follow-up intensity.
DIFFICULTY_GUIDANCE = {
    "Warm-up": "Keep the questions gentle and supportive, with little pressure and minimal "
               "follow-ups.",
    "Realistic": "Use a realistic interview tone, with occasional follow-up probes to clarify "
                 "answers.",
    "Hard": "Be rigorous and challenging: ask demanding questions and dig in with pointed "
            "follow-ups.",
}


def build_interviewer_prompt(role: str, focus: str = "Mixed",
                             difficulty: str = "Realistic", question_count: int = 5) -> str:
    """System prompt for the Claude 'think' provider, shaped by the New-interview settings."""
    focus_line = FOCUS_GUIDANCE.get(focus, FOCUS_GUIDANCE["Mixed"])
    difficulty_line = DIFFICULTY_GUIDANCE.get(difficulty, DIFFICULTY_GUIDANCE["Realistic"])
    n = max(1, int(question_count))
    plural = "s" if n != 1 else ""
    return (
        f"You are Judy, a warm but professional interviewer conducting a mock job "
        f"interview for a {role} position. {focus_line} {difficulty_line} "
        f"Ask exactly {n} question{plural}, one at a time, beginning with an easy warm-up. "
        f"Everything you say is read aloud by a text-to-speech voice, so reply in plain, "
        f"natural spoken sentences only — no markdown, asterisks, bullet points, headings, "
        f"numbered lists, emoji, or labels like 'First Question:'. Just ask the question "
        f"conversationally. "
        f"Keep your turns short (1-3 sentences). Listen to the candidate's full answer "
        f"before asking the next question. Do not give feedback during the interview; "
        f"just conduct it naturally. Once the candidate has answered all {n} question{plural}, "
        f"thank them, give a brief goodbye, then call the end_interview function to finish. "
        f"After that, do not ask anything else."
    )


def build_greeting(role: str) -> str:
    return (f"Hi, thanks for joining. I'll be interviewing you for the {role} role today. "
            f"Whenever you're ready, tell me a little about yourself.")


def build_agent_config(role: str, focus: str = "Mixed",
                       difficulty: str = "Realistic", question_count: int = 5) -> dict:
    """Deepgram Voice Agent Settings payload (sent as first WS message)."""
    return {
        "type": "Settings",
        "audio": {
            "input": {"encoding": "linear16", "sample_rate": 48000},
            "output": {"encoding": "linear16", "sample_rate": 24000, "container": "none"},
        },
        "agent": {
            "language": "en",
            "listen": {"provider": {"type": "deepgram", "model": "nova-3",
                                    "keyterms": ["STAR", "behavioral", "strengths", "weaknesses", role]}},
            "think": {
                "provider": {"type": "anthropic", "model": THINK_MODEL},
                "prompt": build_interviewer_prompt(role, focus, difficulty, question_count),
                # Client-side function (no server endpoint) the interviewer calls when the
                # interview is over. The browser ACKs it and closes the socket, which ends
                # and scores the interview. Without this the agent never stops on its own.
                "functions": [{
                    "name": "end_interview",
                    "description": ("End the interview. Call this only after you have asked all the "
                                    "questions, the candidate has answered the final one, and you "
                                    "have thanked them and said goodbye."),
                    "parameters": {"type": "object", "properties": {}},
                }],
            },
            "speak": {"provider": {"type": "deepgram", "model": TTS_MODEL}},
            "greeting": build_greeting(role),
        },
    }


async def grant_ephemeral_token(api_key: str, ttl_seconds: int = 300) -> str:
    """Mint a short-lived Deepgram token; the long-lived key never leaves the server."""
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.post(
            "https://api.deepgram.com/v1/auth/grant",
            headers={"Authorization": f"Token {api_key}"},
            json={"ttl_seconds": ttl_seconds},
        )
        resp.raise_for_status()
        return resp.json()["access_token"]
