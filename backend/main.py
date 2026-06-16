# backend/main.py
import logging
import os
import json
from datetime import datetime
import httpx
from dotenv import load_dotenv
from typing import Optional
from fastapi import FastAPI, HTTPException, File, Form, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from backend.analysis import compute_metrics, questions_from_transcript, transcript_metrics, integrity_metrics, summarize_actions, emotion_from_blendshapes
from backend.report import save_session
from backend.deepgram import build_agent_config, grant_ephemeral_token, DEEPGRAM_AGENT_URL
from backend.anthropic_coach import generate_coaching, generate_verdict
from backend.emotion import score_emotions, aggregate_emotions
from backend import sessions_store, voice, verdict as verdict_mod

load_dotenv()
logging.basicConfig(level=logging.INFO)  # ensure our INFO/WARNING logs reach the console

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SESSIONS_DIR = os.path.join(ROOT, "sessions")
FRONTEND_DIR = os.path.join(ROOT, "frontend")
os.makedirs(SESSIONS_DIR, exist_ok=True)

app = FastAPI(title="molave.ai")


class TokenRequest(BaseModel):
    role: str = "Software Engineer"
    focus: str = "Mixed"
    difficulty: str = "Realistic"
    question_count: int = 5


class SessionRequest(BaseModel):
    role: str = "Software Engineer"
    frames: list[dict]
    transcript: dict
    events: list = []
    emotion: Optional[dict] = None
    voice: Optional[dict] = None


class LabelRequest(BaseModel):
    label: str


@app.post("/api/interview/token")
async def interview_token(req: TokenRequest):
    api_key = os.getenv("DEEPGRAM_API_KEY")
    if not api_key:
        raise HTTPException(500, "DEEPGRAM_API_KEY is not set")
    try:
        token = await grant_ephemeral_token(api_key)
        # Ephemeral tokens authenticate to the agent WebSocket with the "bearer"
        # subprotocol; a raw API key uses "token". The scheme MUST match the token type.
        scheme = "bearer"
        logging.info("Deepgram token issued via grant (ephemeral, scheme=bearer).")
    except httpx.HTTPStatusError as exc:
        if exc.response.status_code == 403:
            # The key can't mint ephemeral tokens (needs grant permission).
            # SAFE BY DEFAULT: never send the long-lived key to the browser.
            # Only fall back to it when the operator explicitly opts in for LOCAL
            # dev via DEEPGRAM_ALLOW_BROWSER_KEY=1 (must never be set on a deploy).
            if os.getenv("DEEPGRAM_ALLOW_BROWSER_KEY") == "1":
                logging.warning(
                    "Deepgram /auth/grant 403; DEEPGRAM_ALLOW_BROWSER_KEY=1 is set, so "
                    "falling back to the long-lived key (scheme=token). LOCAL DEV ONLY — "
                    "the key is sent to the browser. Do NOT set this on a deployed server."
                )
                token = api_key
                scheme = "token"
            else:
                logging.error("Deepgram /auth/grant 403 — key lacks grant permission.")
                raise HTTPException(
                    500,
                    "Deepgram key lacks permission to mint ephemeral tokens. Use a key "
                    "with grant permission, or set DEEPGRAM_ALLOW_BROWSER_KEY=1 for LOCAL "
                    "dev only (sends the key to the browser — never on a deployment).",
                )
        else:
            raise HTTPException(502, f"Deepgram token grant failed: {exc.response.status_code}")
    return {"url": DEEPGRAM_AGENT_URL, "token": token, "scheme": scheme,
            "config": build_agent_config(req.role, req.focus, req.difficulty, req.question_count)}


@app.post("/api/emotion")
async def emotion(meta: str = Form(...), images: list[UploadFile] = File(default=[])):
    """Score buffered face crops with HSEmotion and return the aggregated emotion summary.

    Optional + graceful: returns {"available": False} when EMOTION_ANALYSIS != "1",
    no images were sent, or the emotion model is unavailable. Images are scored in memory and
    never written to disk.
    """
    if os.getenv("EMOTION_ANALYSIS") != "1" or not images:
        return {"available": False}
    try:
        metas = json.loads(meta)
    except (ValueError, TypeError):
        raise HTTPException(400, "invalid meta JSON")
    bufs = [await im.read() for im in images]
    try:
        scored = score_emotions(bufs)
    except Exception as exc:  # emotion model import/runtime failure -> degrade
        logging.warning("emotion scoring unavailable: %s", exc)
        return {"available": False}
    if len(metas) != len(scored):
        logging.warning("emotion meta/image count mismatch: %d meta vs %d images",
                        len(metas), len(scored))
    shots = []
    for md, sc in zip(metas, scored):
        if sc is None:
            continue
        shots.append({"t": md.get("t", 0.0), "turn": md.get("turn", -1),
                      "dominant": sc["dominant"], "scores": sc["scores"]})
    return aggregate_emotions(shots)


@app.post("/api/emotion/frame")
async def emotion_frame(image: UploadFile = File(...)):
    """Score ONE pre-cropped face image with HSEmotion for the live Facial screen.
    Optional + graceful: returns {"available": False} when EMOTION_ANALYSIS != "1",
    the emotion model is unavailable, or no usable face was scored. The image is
    scored in memory and never written to disk."""
    if os.getenv("EMOTION_ANALYSIS") != "1":
        return {"available": False}
    buf = await image.read()
    try:
        scored = score_emotions([buf])
    except Exception as exc:  # emotion model import/runtime failure -> degrade
        logging.warning("emotion frame scoring unavailable: %s", exc)
        return {"available": False}
    r = scored[0] if scored else None
    if not r:
        return {"available": False}
    return {"available": True, "dominant": r["dominant"], "scores": r["scores"]}


@app.post("/api/voice")
async def voice_analyze(meta: str = Form(...), audio: UploadFile = File(...)):
    """Score the candidate's voice delivery from a recorded interview.

    Multipart: `meta` JSON `{acoustic: {...}}` (browser pitch/energy features) +
    `audio` file. Runs a Deepgram pre-recorded pass for word timings + fillers,
    combines with the acoustic features into a Delivery score, and returns it.
    The audio is scored in memory and never written to disk.
    Graceful: returns {"available": False} when the key is missing or Deepgram fails.
    """
    api_key = os.getenv("DEEPGRAM_API_KEY")
    if not api_key:
        return {"available": False}
    try:
        acoustic = json.loads(meta).get("acoustic", {})
    except (ValueError, TypeError):
        raise HTTPException(400, "invalid meta JSON")
    buf = await audio.read()
    try:
        payload = await voice.transcribe_prerecorded(buf, audio.content_type, api_key)
        words = voice.parse_words(payload)
        return voice.compute_delivery(voice.measure_prosody(words), acoustic)
    except Exception as exc:  # network / Deepgram / parsing failure -> degrade
        logging.warning("voice analysis unavailable: %s", exc)
        return {"available": False}


@app.post("/api/session")
def session(req: SessionRequest):
    if not req.frames:
        raise HTTPException(400, "no frames captured")
    questions = questions_from_transcript(req.transcript.get("segments", []))
    summary = compute_metrics(req.frames, questions)
    summary["timing"] = transcript_metrics(req.transcript.get("segments", []))
    summary["integrity"] = integrity_metrics(req.frames)
    summary["actions"] = summarize_actions(req.events)
    summary["emotion"] = req.emotion if (req.emotion and req.emotion.get("available")) else {"available": False}
    summary["emotion_mediapipe"] = emotion_from_blendshapes(req.frames)
    summary["voice"] = req.voice if (req.voice and req.voice.get("available")) else {"available": False}

    coaching = None
    anthropic_key = os.getenv("ANTHROPIC_API_KEY")
    full_text = req.transcript.get("full_text", "")
    run_claude = bool(anthropic_key and full_text.strip())
    if run_claude:
        try:
            coaching = generate_coaching(anthropic_key, full_text, req.role)
        except Exception as exc:
            logging.warning("coaching unavailable: %s", exc)

    # Fused readiness verdict: Delivery (voice) + Presence (composites) + Content (Claude).
    presence = verdict_mod.presence_score(summary["overall"])
    delivery = summary["voice"].get("delivery_score") if summary["voice"].get("available") else None
    explanation = None
    content = None
    if run_claude:
        try:
            explanation = generate_verdict(anthropic_key, full_text, req.role, delivery, presence)
            content = explanation.get("content_score")
        except Exception as exc:
            logging.warning("verdict unavailable: %s", exc)
    readiness = verdict_mod.compute_readiness(delivery, presence, content)
    summary["verdict"] = {
        "readiness_score": readiness["readiness_score"],
        "band": readiness["band"],
        "components": readiness["components"],
        "weights_used": readiness["weights_used"],
        "content_score": content,
        "headline": (explanation or {}).get("headline", ""),
        "delivery_note": (explanation or {}).get("delivery_note", ""),
        "presence_note": (explanation or {}).get("presence_note", ""),
        "content_note": (explanation or {}).get("content_note", ""),
        "strengths": (explanation or {}).get("strengths", []),
        "improvements": (explanation or {}).get("improvements", []),
        "next_action": (explanation or {}).get("next_action", ""),
    }

    session_id = datetime.now().strftime("%Y-%m-%dT%H%M%S")
    summary["role"] = req.role
    summary["created_at"] = datetime.strptime(session_id, "%Y-%m-%dT%H%M%S").isoformat()
    save_session(os.path.join(SESSIONS_DIR, session_id),
                 req.frames, req.transcript, summary, coaching)

    emotion_chart_url = (f"/sessions/{session_id}/emotion.png"
                         if summary["emotion"].get("available") else None)
    emotion_mp_chart_url = (f"/sessions/{session_id}/emotion_mediapipe.png"
                            if summary["emotion_mediapipe"].get("available") else None)
    return {"session_id": session_id, "summary": summary, "coaching": coaching,
            "charts_url": f"/sessions/{session_id}/charts.png",
            "emotion_chart_url": emotion_chart_url,
            "emotion_mediapipe_chart_url": emotion_mp_chart_url}


@app.get("/api/sessions")
def list_sessions_endpoint():
    return {"sessions": sessions_store.list_sessions(SESSIONS_DIR)}


@app.get("/api/sessions/{session_id}")
def get_session_endpoint(session_id: str):
    data = sessions_store.load_session(SESSIONS_DIR, session_id)
    if data is None:
        raise HTTPException(404, "session not found")
    return data


@app.delete("/api/sessions/{session_id}")
def delete_session_endpoint(session_id: str):
    if not sessions_store.delete_session(SESSIONS_DIR, session_id):
        raise HTTPException(404, "session not found")
    return {"deleted": session_id}


@app.patch("/api/sessions/{session_id}")
def rename_session_endpoint(session_id: str, req: LabelRequest):
    data = sessions_store.set_label(SESSIONS_DIR, session_id, req.label)
    if data is None:
        raise HTTPException(404, "session not found")
    return data


# static mounts last so /api routes win
app.mount("/sessions", StaticFiles(directory=SESSIONS_DIR), name="sessions")

if os.path.isdir(FRONTEND_DIR):
    @app.get("/")
    def index():
        return FileResponse(os.path.join(FRONTEND_DIR, "index.html"))

    app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")
