# backend/main.py
import asyncio
import logging
import os
import re
import json
from datetime import datetime
import httpx
from dotenv import load_dotenv
from typing import Optional
from fastapi import FastAPI, HTTPException, File, Form, UploadFile
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from backend.analysis import compute_metrics, questions_from_transcript, transcript_metrics, integrity_metrics, summarize_actions, emotion_from_blendshapes, action_units, compound_emotion
from backend.report import save_session
from backend import storage
from backend.deepgram import build_agent_config, grant_ephemeral_token, DEEPGRAM_AGENT_URL
from backend.anthropic_coach import generate_coaching, generate_verdict
from backend.questions import generate_questions
from backend.emotion import score_emotions, aggregate_emotions
from backend import sessions_store, voice, verdict as verdict_mod
from backend.quickdraw import guess_drawing
from backend import notes_store

load_dotenv()
logging.basicConfig(level=logging.INFO)  # ensure our INFO/WARNING logs reach the console

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FRONTEND_DIR = os.path.join(ROOT, "frontend")

_SESSION_ID_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{6}\Z")
_SAFE_ASSET = re.compile(r"^[a-z_]+\.(?:png|json|txt|csv)$")

app = FastAPI(title="molave.ai")


class TokenRequest(BaseModel):
    scenario: str = "job"
    role: str = "Software Engineer"
    focus: str = "Mixed"
    difficulty: str = "Realistic"
    question_count: int = 5
    questions: list[str] = []
    tone: str = "Professional"
    language: str = "en"


class QuestionsRequest(BaseModel):
    scenario: str = "job"
    role: str = "Software Engineer"
    focus: str = "Mixed"
    difficulty: str = "Realistic"
    question_count: int = 5
    language: str = "en"


class SessionRequest(BaseModel):
    scenario: str = "job"
    role: str = ""
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
            "config": build_agent_config(req.role, req.focus, req.difficulty,
                                         req.question_count, req.questions,
                                         tone=req.tone, scenario=req.scenario,
                                         language=req.language)}


@app.post("/api/questions")
def questions_endpoint(req: QuestionsRequest):
    """Generate a tailored interview question set for the Practice Interview page.
    Graceful: returns {"questions": []} when no ANTHROPIC_API_KEY or generation fails."""
    api_key = os.getenv("ANTHROPIC_API_KEY")
    if not api_key:
        return {"questions": []}
    try:
        qs = generate_questions(api_key, req.role, req.focus, req.difficulty,
                                req.question_count, req.scenario, req.language)
    except Exception as exc:  # network / model failure -> degrade
        logging.warning("question generation unavailable: %s", exc)
        return {"questions": []}
    return {"questions": qs}


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


class SpeakRequest(BaseModel):
    text: str


class NotebookSave(BaseModel):
    title: str
    role: str = ""
    scenario: str = "job"
    pages: list  # list[list[{ts, text}]]

@app.post("/api/quickdraw/speak")
async def quickdraw_speak(req: SpeakRequest):
    """Proxy Deepgram TTS (Amalthea voice) for Quick Draw voice announcements."""
    api_key = os.getenv("DEEPGRAM_API_KEY")
    text = req.text.strip()[:300]
    if not api_key or not text:
        raise HTTPException(503, "TTS unavailable")
    try:
        async with httpx.AsyncClient(timeout=12.0) as client:
            r = await client.post(
                "https://api.deepgram.com/v1/speak",
                params={"model": "aura-2-amalthea-en", "encoding": "mp3"},
                json={"text": text},
                headers={"Authorization": f"Token {api_key}"},
            )
            r.raise_for_status()
            return Response(content=r.content, media_type="audio/mpeg")
    except Exception as exc:
        logging.warning("quickdraw TTS failed: %s", exc)
        raise HTTPException(502, "TTS failed")


@app.post("/api/quickdraw/guess")
async def quickdraw_guess(prompt: str = Form(...), image: UploadFile = File(...)):
    """Guess what the player drew and score the match using Claude Vision.
    Graceful: returns a fallback response when ANTHROPIC_API_KEY is missing or the call fails."""
    api_key = os.getenv("ANTHROPIC_API_KEY")
    if not api_key:
        return {"guess": "mystery drawing", "score": 50, "comment": "AI unavailable — nice try!", "debug": "no_api_key"}
    try:
        data = await image.read()
        if not data:
            return {"guess": "mystery drawing", "score": 30, "comment": "No image received!", "debug": "empty_image"}
        return await asyncio.to_thread(guess_drawing, api_key, data, prompt)
    except Exception as exc:
        logging.warning("quickdraw guess failed: %s", exc)
        return {"guess": "mystery drawing", "score": 30, "comment": "Couldn't analyze this one!", "debug": str(exc)[:300]}


# ── Notes (single master notebook) ────────────────────────────────────────────

@app.get("/api/notes/master")
def get_notes_master():
    try:
        return notes_store.load_master()
    except Exception as exc:
        logging.warning("notes master load failed: %s", exc)
        return {"title": "My Notebook", "pages": [[] for _ in range(10)]}


@app.put("/api/notes/master")
def put_notes_master(req: NotebookSave):
    try:
        notes_store.save_master(req.title, req.pages)
        return {"ok": True}
    except Exception as exc:
        logging.warning("notes master save failed: %s", exc)
        return {"ok": False, "error": str(exc)[:200]}


@app.post("/api/session")
async def session(req: SessionRequest):
    if not req.frames:
        raise HTTPException(400, "no frames captured")
    try:
        questions = questions_from_transcript(req.transcript.get("segments", []))
        summary = compute_metrics(req.frames, questions)
        summary["timing"] = transcript_metrics(req.transcript.get("segments", []))
        summary["integrity"] = integrity_metrics(req.frames)
        summary["actions"] = summarize_actions(req.events)
        summary["emotion"] = req.emotion if (req.emotion and req.emotion.get("available")) else {"available": False}
        summary["emotion_mediapipe"] = emotion_from_blendshapes(req.frames)
        summary["action_units"] = action_units(req.frames)
        summary["emotion_compound"] = compound_emotion(
            summary["emotion_mediapipe"].get("overall_distribution", {}))
        summary["voice"] = req.voice if (req.voice and req.voice.get("available")) else {"available": False}

        anthropic_key = os.getenv("ANTHROPIC_API_KEY")
        full_text = req.transcript.get("full_text", "")
        run_claude = bool(anthropic_key and full_text.strip())

        # Fused readiness verdict: Delivery (voice) + Presence (composites) + Content (Claude).
        presence = verdict_mod.presence_score(summary["overall"])
        delivery = summary["voice"].get("delivery_score") if summary["voice"].get("available") else None

        coaching = None
        explanation = None
        content = None

        if run_claude:
            # Run coaching and verdict in parallel — they are independent Claude calls.
            # 45-second per-call timeout prevents a slow/overloaded Anthropic API from
            # hanging the whole session endpoint until the browser itself times out.
            _CLAUDE_TIMEOUT = 45.0
            raw = await asyncio.gather(
                asyncio.wait_for(
                    asyncio.to_thread(generate_coaching, anthropic_key, full_text, req.role, req.scenario),
                    timeout=_CLAUDE_TIMEOUT,
                ),
                asyncio.wait_for(
                    asyncio.to_thread(generate_verdict, anthropic_key, full_text, req.role, delivery,
                                      presence, req.scenario),
                    timeout=_CLAUDE_TIMEOUT,
                ),
                return_exceptions=True,
            )
            if isinstance(raw[0], Exception):
                label = "timed out" if isinstance(raw[0], asyncio.TimeoutError) else str(raw[0])
                logging.warning("coaching unavailable: %s", label)
            else:
                coaching = raw[0]
            if isinstance(raw[1], Exception):
                label = "timed out" if isinstance(raw[1], asyncio.TimeoutError) else str(raw[1])
                logging.warning("verdict unavailable: %s", label)
            else:
                explanation = raw[1]
                content = explanation.get("content_score") if explanation else None

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
        summary["scenario"] = req.scenario
        summary["role"] = req.role
        summary["created_at"] = datetime.strptime(session_id, "%Y-%m-%dT%H%M%S").isoformat()
        await asyncio.to_thread(save_session, session_id, req.frames, req.transcript, summary, coaching)

        emotion_chart_url = (f"/sessions/{session_id}/emotion.png"
                             if summary["emotion"].get("available") else None)
        emotion_mp_chart_url = (f"/sessions/{session_id}/emotion_mediapipe.png"
                                if summary["emotion_mediapipe"].get("available") else None)
        return {"session_id": session_id, "summary": summary, "coaching": coaching,
                "charts_url": f"/sessions/{session_id}/charts.png",
                "emotion_chart_url": emotion_chart_url,
                "emotion_mediapipe_chart_url": emotion_mp_chart_url}

    except HTTPException:
        raise
    except Exception as exc:
        logging.exception("session scoring failed: %s", exc)
        raise HTTPException(500, f"Scoring error: {type(exc).__name__}: {exc}")


@app.get("/api/sessions")
def list_sessions_endpoint():
    return {"sessions": sessions_store.list_sessions()}


@app.get("/api/sessions/{session_id}")
def get_session_endpoint(session_id: str):
    data = sessions_store.load_session(None, session_id)
    if data is None:
        raise HTTPException(404, "session not found")
    return data


@app.delete("/api/sessions/{session_id}")
def delete_session_endpoint(session_id: str):
    if not sessions_store.delete_session(None, session_id):
        raise HTTPException(404, "session not found")
    return {"deleted": session_id}


@app.patch("/api/sessions/{session_id}")
def rename_session_endpoint(session_id: str, req: LabelRequest):
    data = sessions_store.set_label(None, session_id, req.label)
    if data is None:
        raise HTTPException(404, "session not found")
    return data


_ASSET_CTYPE = {"png": "image/png", "json": "application/json",
                "txt": "text/plain", "csv": "text/csv"}


@app.get("/sessions/{session_id}/{filename}")
def session_asset(session_id: str, filename: str):
    """Proxy S3 session assets (charts, data files) so existing URL paths work."""
    if not _SESSION_ID_RE.match(session_id) or not _SAFE_ASSET.match(filename):
        raise HTTPException(404)
    data = storage.get_bytes(f"sessions/{session_id}/{filename}")
    if data is None:
        raise HTTPException(404)
    ext = filename.rsplit(".", 1)[-1]
    return Response(content=data, media_type=_ASSET_CTYPE.get(ext, "application/octet-stream"))

if os.path.isdir(FRONTEND_DIR):
    @app.get("/")
    def index():
        return FileResponse(os.path.join(FRONTEND_DIR, "index.html"))

    app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")
