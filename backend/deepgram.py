# backend/deepgram.py
import httpx

DEEPGRAM_AGENT_URL = "wss://agent.deepgram.com/v1/agent/converse"
THINK_MODEL = "claude-sonnet-4-6"
TTS_MODEL = "aura-2-thalia-en"


def build_interviewer_prompt(role: str) -> str:
    return (
        f"You are Judy, a warm but professional interviewer conducting a mock job "
        f"interview for a {role} position. Ask one question at a time. Start with an "
        f"easy warm-up, then progressively ask behavioral and role-relevant questions. "
        f"Keep your turns short (1-3 sentences). Listen to the candidate's full answer "
        f"before asking the next question. Do not give feedback during the interview; "
        f"just conduct it naturally. After about 5 questions, thank them and end."
    )


def build_greeting(role: str) -> str:
    return (f"Hi, thanks for joining. I'll be interviewing you for the {role} role today. "
            f"Whenever you're ready, tell me a little about yourself.")


def build_agent_config(role: str) -> dict:
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
                "prompt": build_interviewer_prompt(role),
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
