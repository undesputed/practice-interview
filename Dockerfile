# syntax=docker/dockerfile:1

# ── Base image ────────────────────────────────────────────────────────────────
# Python 3.11 slim keeps the image small. Every dependency (numpy 2, fastapi,
# and the optional deepface/TensorFlow stack) supports 3.9–3.12, so 3.11 is a
# safe, modern target. The app is developed/tested on 3.9 — bump this back to
# python:3.9-slim if you want exact parity with that environment.
FROM python:3.11-slim AS base

# INCLUDE_EMOTION=true bakes in the heavy DeepFace + TensorFlow stack (and the
# system libraries OpenCV needs). It is OFF by default to keep the image small
# (~250 MB vs ~3-4 GB). The app runs fine without it — emotion analysis stays
# disabled unless EMOTION_ANALYSIS=1 is also set at runtime.
#   docker build --build-arg INCLUDE_EMOTION=true -t interview .
ARG INCLUDE_EMOTION=false

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    MPLBACKEND=Agg

WORKDIR /app

# OpenCV (pulled in transitively by DeepFace) needs libGL + glib at runtime.
# Install them only when the emotion stack is baked in, then drop the apt cache.
RUN if [ "$INCLUDE_EMOTION" = "true" ]; then \
        apt-get update && \
        apt-get install -y --no-install-recommends libgl1 libglib2.0-0 && \
        rm -rf /var/lib/apt/lists/*; \
    fi

# Install Python deps first so they stay cached across code-only changes.
COPY backend/requirements.txt backend/requirements-emotion.txt ./backend/
RUN pip install -r backend/requirements.txt && \
    if [ "$INCLUDE_EMOTION" = "true" ]; then \
        pip install -r backend/requirements-emotion.txt; \
    fi

# Application code + static frontend (FastAPI serves the frontend itself).
COPY backend/ ./backend/
COPY frontend/ ./frontend/

# Run as a non-root user. sessions/ is written at runtime, so it must be owned
# by that user. NOTE: on ECS this directory is ephemeral — mount EFS at
# /app/sessions if you need session reports to survive task restarts.
RUN useradd --create-home --uid 10001 appuser && \
    mkdir -p /app/sessions && \
    chown -R appuser:appuser /app
USER appuser

EXPOSE 8000

# Local liveness signal for `docker run`. On ECS, configure the ALB target-group
# health check to hit "/" instead — this HEALTHCHECK is ignored there.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/').status==200 else 1)"

# Bind 0.0.0.0 so the container is reachable. TLS is terminated upstream by the
# ALB (browsers require HTTPS for camera/mic) — the container speaks plain HTTP.
CMD ["uvicorn", "backend.main:app", "--host", "0.0.0.0", "--port", "8000"]
