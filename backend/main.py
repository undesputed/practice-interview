# backend/main.py
import logging
import os
from datetime import datetime
import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from backend.analysis import compute_metrics, questions_from_transcript
from backend.report import save_session
from backend.deepgram import build_agent_config, grant_ephemeral_token, DEEPGRAM_AGENT_URL
from backend.anthropic_coach import generate_coaching

load_dotenv()

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SESSIONS_DIR = os.path.join(ROOT, "sessions")
FRONTEND_DIR = os.path.join(ROOT, "frontend")
os.makedirs(SESSIONS_DIR, exist_ok=True)

app = FastAPI()


class TokenRequest(BaseModel):
    role: str = "Software Engineer"


class SessionRequest(BaseModel):
    role: str = "Software Engineer"
    frames: list[dict]
    transcript: dict


@app.post("/api/interview/token")
async def interview_token(req: TokenRequest):
    api_key = os.getenv("DEEPGRAM_API_KEY")
    if not api_key:
        raise HTTPException(500, "DEEPGRAM_API_KEY is not set")
    try:
        token = await grant_ephemeral_token(api_key)
    except httpx.HTTPStatusError as exc:
        if exc.response.status_code == 403:
            # The key can't mint ephemeral tokens (needs grant permission).
            # For LOCAL dev, fall back to the long-lived key — the Voice Agent
            # WebSocket accepts it directly. This exposes the key to the browser,
            # so for an EC2 deploy use a Deepgram key WITH grant permission instead.
            logging.warning(
                "Deepgram /auth/grant returned 403 (insufficient permissions); "
                "falling back to the long-lived key. LOCAL DEV ONLY — the key is "
                "sent to the browser. Use a key with grant permission before deploying."
            )
            token = api_key
        else:
            raise HTTPException(502, f"Deepgram token grant failed: {exc.response.status_code}")
    return {"url": DEEPGRAM_AGENT_URL, "token": token,
            "config": build_agent_config(req.role)}


@app.post("/api/session")
def session(req: SessionRequest):
    if not req.frames:
        raise HTTPException(400, "no frames captured")
    questions = questions_from_transcript(req.transcript.get("segments", []))
    summary = compute_metrics(req.frames, questions)

    coaching = None
    anthropic_key = os.getenv("ANTHROPIC_API_KEY")
    full_text = req.transcript.get("full_text", "")
    if anthropic_key and full_text.strip():
        coaching = generate_coaching(anthropic_key, full_text, req.role)

    session_id = datetime.now().strftime("%Y-%m-%dT%H%M%S")
    save_session(os.path.join(SESSIONS_DIR, session_id),
                 req.frames, req.transcript, summary, coaching)

    return {"session_id": session_id, "summary": summary, "coaching": coaching,
            "charts_url": f"/sessions/{session_id}/charts.png"}


# static mounts last so /api routes win
app.mount("/sessions", StaticFiles(directory=SESSIONS_DIR), name="sessions")

if os.path.isdir(FRONTEND_DIR):
    @app.get("/")
    def index():
        return FileResponse(os.path.join(FRONTEND_DIR, "index.html"))

    app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")
