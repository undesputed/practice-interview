# Readiness Scoring — Plan 2: Voice Analysis Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record the candidate's audio during the interview, and at the end compute a **Delivery** sub-score (0–100) from voice metrics — pace, fillers, pauses (from a Deepgram pre-recorded pass) plus pitch variation and loudness (from in-browser DSP) — store it on the session, and show it on the results page.

**Architecture:** A new browser recorder (`MediaRecorder` on the existing mic stream) + an in-browser pitch/energy DSP ported from molave-ai. On finish, the browser computes acoustic features and uploads the audio + features to a new `POST /api/voice` endpoint. The backend runs a Deepgram pre-recorded transcription (word timings + fillers), computes prosody, combines it with the browser features into a Delivery score against **absolute target bands**, deletes the audio, and returns the result. The live screen passes that result into `createSession`, which stores it as `summary.voice`; the report renders a Voice section.

**Tech Stack:** Vanilla ES modules (frontend), FastAPI + httpx + pytest (backend), Deepgram pre-recorded REST API, Web Audio API.

**This is Plan 2 of 4.** Plan 1 (capture wiring) is done. Plan 3 (fused verdict) will combine this Delivery score with Presence + Content. Plan 4 (progress linking + privacy/caveat).

> **Why absolute bands, not molave's self-relative baseline:** molave scores each segment against the speaker's own median (a self-improvement "effort" signal). A readiness verdict needs "is this good?", so we score against fixed target ranges instead. The DSP and measurement code is ported from molave; the *scoring* is new.

> **Mic-processing caveat:** the live mic runs with `autoGainControl` + `noiseSuppression` on (set in interview-engine.js). AGC normalizes loudness, so the energy/loudness metric is the least reliable of the five — it gets the lowest weight, and pace/fillers/pauses (from word timings, unaffected by AGC) carry the most.

---

## File Structure

- **Create** `backend/voice.py` — prosody measurement (from Deepgram words) + Delivery scoring (absolute bands) + the Deepgram pre-recorded call. Pure functions are unit-tested; the network call is a thin wrapper.
- **Modify** `backend/main.py` — add `POST /api/voice` (multipart: audio + acoustic features); add optional `voice` field to `SessionRequest`; store `summary["voice"]`.
- **Create** `tests/test_voice.py` — unit tests for prosody + Delivery scoring + word parsing (no network).
- **Create** `frontend/audio-recorder.js` — `MediaRecorder` wrapper over the mic stream.
- **Create** `frontend/acoustic-features.js` — in-browser pitch/energy DSP (ported from molave `acousticFeatures.ts`).
- **Modify** `frontend/api.js` — add `analyzeVoice(audioBlob, acoustic)` multipart helper.
- **Modify** `frontend/screens/live.js` — start/stop the recorder; on finish compute features, call `analyzeVoice`, include the result as `voice` in the session payload.
- **Modify** `frontend/screens/report.js` — add a Voice / Delivery section rendered from `summary.voice`.

**Data shapes (consistent across all tasks):**

- Browser acoustic features: `{ pitchMeanHz, pitchStdHz, energyMean, energyStd, voicedRatio }`
- `POST /api/voice` → `{ available: bool, delivery_score: int|null, metrics: {...}, breakdown: [{key, score, weight, points}] }`
- `summary.voice` = that response object (or `{available: false}`)

---

## Task 1: Backend prosody + Delivery scoring (pure logic, TDD)

**Files:**
- Create: `backend/voice.py`
- Test: `tests/test_voice.py`

- [ ] **Step 1: Write the failing tests**

```python
# tests/test_voice.py
"""Unit tests for voice prosody measurement and Delivery scoring (no network)."""
from backend import voice


def _word(text, start_s, end_s):
    return {"word": text, "punctuated_word": text, "start": start_s, "end": end_s}


def test_parse_words_prefers_punctuated_and_converts_ms():
    raw = {"results": {"channels": [{"alternatives": [{"words": [
        {"word": "hello", "punctuated_word": "Hello", "start": 0.0, "end": 0.5},
        {"word": "world", "punctuated_word": "world.", "start": 0.6, "end": 1.0},
    ]}]}]}}
    words = voice.parse_words(raw)
    assert [w["text"] for w in words] == ["Hello", "world."]
    assert words[0]["start_ms"] == 0 and words[0]["end_ms"] == 500


def test_measure_prosody_counts_pace_pauses_fillers():
    # 6 words over 3.0s of talk-time -> 120 wpm. One >=1.5s gap = one long pause.
    words = [
        {"text": "I", "start_ms": 0, "end_ms": 200},
        {"text": "um", "start_ms": 250, "end_ms": 450},        # filler
        {"text": "think", "start_ms": 500, "end_ms": 900},
        {"text": "so", "start_ms": 2500, "end_ms": 2700},      # 1.6s gap -> long pause
        {"text": "really", "start_ms": 2750, "end_ms": 3000},
        {"text": "yes", "start_ms": 3000, "end_ms": 3000},
    ]
    p = voice.measure_prosody(words)
    assert p["word_count"] == 6
    assert p["filler_count"] == 1
    assert p["long_pause_count"] == 1
    assert p["pause_count"] >= 1
    assert 110 <= p["wpm"] <= 130           # ~120 wpm
    assert round(p["filler_rate_per100"], 1) == round(100 / 6, 1)


def test_measure_prosody_empty():
    p = voice.measure_prosody([])
    assert p["word_count"] == 0 and p["wpm"] == 0 and p["filler_count"] == 0


def test_delivery_score_good_delivery_is_high():
    prosody = {"wpm": 135, "filler_rate_per100": 1.0, "long_pause_count": 1,
               "word_count": 200, "pause_count": 3, "avg_pause_ms": 400,
               "filler_count": 2, "talk_time_s": 90.0}
    acoustic = {"pitchStdHz": 30.0, "energyMean": 0.05, "voicedRatio": 0.6,
                "pitchMeanHz": 140.0, "energyStd": 0.02}
    r = voice.compute_delivery(prosody, acoustic)
    assert r["available"] is True
    assert r["delivery_score"] >= 75
    keys = {b["key"] for b in r["breakdown"]}
    assert keys == {"pace", "fillers", "pauses", "pitch", "energy"}


def test_delivery_score_poor_delivery_is_low():
    prosody = {"wpm": 250, "filler_rate_per100": 14.0, "long_pause_count": 9,
               "word_count": 50, "pause_count": 12, "avg_pause_ms": 1800,
               "filler_count": 7, "talk_time_s": 20.0}
    acoustic = {"pitchStdHz": 4.0, "energyMean": 0.001, "voicedRatio": 0.2,
                "pitchMeanHz": 120.0, "energyStd": 0.001}
    r = voice.compute_delivery(prosody, acoustic)
    assert r["delivery_score"] <= 40


def test_delivery_score_weights_sum_to_one():
    assert abs(sum(w for w in voice.DELIVERY_WEIGHTS.values()) - 1.0) < 1e-9
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd /Users/carrieyu/Desktop/Hipe/mediapipe-test && python -m pytest tests/test_voice.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'backend.voice'` (or attribute errors).

- [ ] **Step 3: Implement `backend/voice.py`**

```python
# backend/voice.py
"""Voice (audio delivery) analysis for a finished interview.

Two halves:
  - prosody from Deepgram pre-recorded words (pace, pauses, fillers) — exact
    counts, unaffected by mic AGC;
  - a Delivery score (0-100) that combines prosody with the browser-computed
    pitch/energy features against ABSOLUTE target bands.

Ported measurement logic from molave-ai (voiceMetrics.ts); the scoring is new
(absolute bands, because a readiness verdict needs "is this good?").
"""
import logging

import httpx

DEEPGRAM_PRERECORDED_URL = "https://api.deepgram.com/v1/listen"

# Vocalized fillers Deepgram returns when filler_words=true (ported from molave).
FILLER_TOKENS = {
    "um", "umm", "uhm", "uh", "er", "err", "ah", "ahh", "eh", "mm", "mmm",
    "hmm", "mhm",
}
PAUSE_MIN_MS = 300       # a gap >= this counts as a pause
LONG_PAUSE_MS = 1500     # a gap >= this is a "long pause"

# Delivery term weights (sum to 1.0). Pace/fillers/pauses come from word timings
# and are unaffected by mic AGC, so they carry the most. Energy is least reliable
# under AGC, so it gets the least.
DELIVERY_WEIGHTS = {
    "pace": 0.30,
    "fillers": 0.25,
    "pauses": 0.15,
    "pitch": 0.20,
    "energy": 0.10,
}


def parse_words(payload):
    """Extract a flat word list from a Deepgram pre-recorded JSON response.

    Returns [{text, start_ms, end_ms}] using the first channel's first
    alternative. Prefers punctuated_word; converts seconds to ms.
    """
    out = []
    try:
        alts = payload["results"]["channels"][0]["alternatives"]
        words = alts[0].get("words", []) if alts else []
    except (KeyError, IndexError, TypeError):
        return out
    for w in words:
        if not isinstance(w, dict):
            continue
        text = w.get("punctuated_word") or w.get("word") or ""
        if not text:
            continue
        out.append({
            "text": text,
            "start_ms": int(round(float(w.get("start", 0.0)) * 1000)),
            "end_ms": int(round(float(w.get("end", 0.0)) * 1000)),
        })
    return out


def _is_filler(text):
    token = "".join(ch for ch in text.lower() if ch.isalpha())
    return token in FILLER_TOKENS


def measure_prosody(words):
    """Pace / pauses / fillers from a flat word list. Ported from molave."""
    n = len(words)
    if n == 0:
        return {"word_count": 0, "talk_time_s": 0.0, "wpm": 0, "pause_count": 0,
                "long_pause_count": 0, "avg_pause_ms": 0, "filler_count": 0,
                "filler_rate_per100": 0.0}
    start_ms = words[0]["start_ms"]
    end_ms = words[-1]["end_ms"]
    talk_time_s = max(0.0, (end_ms - start_ms) / 1000.0)
    wpm = round((n / talk_time_s) * 60) if talk_time_s > 0 else 0

    filler_count = sum(1 for w in words if _is_filler(w["text"]))

    pause_gaps = []
    long_pause_count = 0
    for i in range(1, n):
        gap = words[i]["start_ms"] - words[i - 1]["end_ms"]
        if gap >= PAUSE_MIN_MS:
            pause_gaps.append(gap)
            if gap >= LONG_PAUSE_MS:
                long_pause_count += 1
    avg_pause_ms = round(sum(pause_gaps) / len(pause_gaps)) if pause_gaps else 0
    filler_rate = (filler_count / n) * 100 if n else 0.0

    return {"word_count": n, "talk_time_s": round(talk_time_s, 1), "wpm": wpm,
            "pause_count": len(pause_gaps), "long_pause_count": long_pause_count,
            "avg_pause_ms": avg_pause_ms, "filler_count": filler_count,
            "filler_rate_per100": round(filler_rate, 2)}


def _band(value, ideal_lo, ideal_hi, zero_lo, zero_hi):
    """1.0 inside [ideal_lo, ideal_hi]; linear down to 0 at zero_lo / zero_hi."""
    if ideal_lo <= value <= ideal_hi:
        return 1.0
    if value < ideal_lo:
        if value <= zero_lo:
            return 0.0
        return (value - zero_lo) / (ideal_lo - zero_lo)
    if value >= zero_hi:
        return 0.0
    return (zero_hi - value) / (zero_hi - ideal_hi)


def _decay_high(value, ideal_max, zero_at):
    """1.0 at <= ideal_max, linear down to 0 at zero_at (penalizes high values)."""
    if value <= ideal_max:
        return 1.0
    if value >= zero_at:
        return 0.0
    return (zero_at - value) / (zero_at - ideal_max)


def _ramp_low(value, ideal_min, zero_at):
    """1.0 at >= ideal_min, linear down to 0 at zero_at (penalizes low values)."""
    if value >= ideal_min:
        return 1.0
    if value <= zero_at:
        return 0.0
    return (value - zero_at) / (ideal_min - zero_at)


def compute_delivery(prosody, acoustic):
    """Combine prosody + browser acoustic features into a 0-100 Delivery score."""
    acoustic = acoustic or {}
    pace = _band(prosody.get("wpm", 0), 110, 160, 60, 220)
    fillers = _decay_high(prosody.get("filler_rate_per100", 0.0), 3.0, 15.0)
    pauses = _decay_high(prosody.get("long_pause_count", 0), 2, 10)
    pitch = _ramp_low(float(acoustic.get("pitchStdHz", 0.0)), 25.0, 5.0)
    energy = _ramp_low(float(acoustic.get("energyMean", 0.0)), 0.02, 0.002)

    scores = {"pace": pace, "fillers": fillers, "pauses": pauses,
              "pitch": pitch, "energy": energy}
    breakdown = []
    total = 0.0
    for key, weight in DELIVERY_WEIGHTS.items():
        s = scores[key]
        pts = weight * s
        total += pts
        breakdown.append({"key": key, "score": round(s, 3), "weight": weight,
                          "points": round(pts * 100, 1)})
    return {"available": True, "delivery_score": round(total * 100),
            "metrics": {**prosody,
                        "pitch_std_hz": round(float(acoustic.get("pitchStdHz", 0.0)), 1),
                        "energy_mean": round(float(acoustic.get("energyMean", 0.0)), 4),
                        "voiced_ratio": round(float(acoustic.get("voicedRatio", 0.0)), 2)},
            "breakdown": breakdown}


async def transcribe_prerecorded(audio_bytes, content_type, api_key):
    """Deepgram pre-recorded transcription with word timings + fillers.

    Returns the raw JSON payload (parse with parse_words). Raises on HTTP error.
    """
    params = {"model": "nova-2", "filler_words": "true", "punctuate": "true",
              "smart_format": "true"}
    async with httpx.AsyncClient(timeout=60.0) as client:
        resp = await client.post(
            DEEPGRAM_PRERECORDED_URL,
            params=params,
            headers={"Authorization": f"Token {api_key}",
                     "Content-Type": content_type or "audio/webm"},
            content=audio_bytes,
        )
        resp.raise_for_status()
        return resp.json()
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /Users/carrieyu/Desktop/Hipe/mediapipe-test && python -m pytest tests/test_voice.py -v`
Expected: all tests PASS. If a band assertion is off (e.g. the "good" case scores 74 not ≥75), adjust the band constants in `voice.py` (not the test intent) until a clearly-good sample scores ≥75 and a clearly-poor sample scores ≤40, then re-run.

- [ ] **Step 5: Commit**

```bash
git add backend/voice.py tests/test_voice.py
git commit -m "feat(voice): prosody measurement + Delivery scoring (absolute bands)"
```

---

## Task 2: `POST /api/voice` endpoint + session `voice` field

**Files:**
- Modify: `backend/main.py`
- Test: `tests/test_voice_endpoint.py` (create)

- [ ] **Step 1: Write the failing endpoint test (Deepgram monkeypatched)**

```python
# tests/test_voice_endpoint.py
"""Endpoint tests for POST /api/voice and the session voice field (no network)."""
import io
import json
import os

import pytest
from fastapi.testclient import TestClient

import backend.main as main
from backend.main import app

client = TestClient(app)

FAKE_DG = {"results": {"channels": [{"alternatives": [{"words": [
    {"punctuated_word": "Hello", "word": "hello", "start": 0.0, "end": 0.4},
    {"punctuated_word": "um", "word": "um", "start": 0.5, "end": 0.7},
    {"punctuated_word": "world.", "word": "world", "start": 0.8, "end": 1.2},
]}]}]}}


@pytest.fixture
def fake_deepgram(monkeypatch):
    async def _fake(audio_bytes, content_type, api_key):
        return FAKE_DG
    monkeypatch.setattr(main.voice, "transcribe_prerecorded", _fake)
    monkeypatch.setenv("DEEPGRAM_API_KEY", "test-key")


def _post_voice():
    meta = json.dumps({"acoustic": {"pitchStdHz": 28.0, "energyMean": 0.05,
                                    "voicedRatio": 0.6, "pitchMeanHz": 140.0,
                                    "energyStd": 0.02}})
    files = {"audio": ("a.webm", io.BytesIO(b"fakeaudio"), "audio/webm")}
    return client.post("/api/voice", data={"meta": meta}, files=files)


def test_voice_endpoint_returns_delivery(fake_deepgram):
    res = _post_voice()
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["available"] is True
    assert isinstance(body["delivery_score"], int)
    assert body["metrics"]["filler_count"] == 1


def test_voice_endpoint_degrades_without_key(monkeypatch):
    monkeypatch.delenv("DEEPGRAM_API_KEY", raising=False)
    res = _post_voice()
    assert res.status_code == 200
    assert res.json() == {"available": False}


def test_session_stores_voice_field(fake_deepgram):
    from backend.main import SESSIONS_DIR
    from backend import sessions_store
    # minimal valid session payload (one frame) + a voice block
    frame = {"t": 0.0, "turn": 0, "face": True, "face_count": 1,
             "bs": {}, "m": [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]}
    voice_block = {"available": True, "delivery_score": 80, "metrics": {}, "breakdown": []}
    payload = {"role": "Software Engineer", "frames": [frame],
               "transcript": {"full_text": "", "segments": []},
               "events": [], "emotion": None, "voice": voice_block}
    res = client.post("/api/session", json=payload)
    assert res.status_code == 200, res.text
    sid = res.json()["session_id"]
    try:
        assert res.json()["summary"]["voice"]["delivery_score"] == 80
    finally:
        sessions_store.delete_session(SESSIONS_DIR, sid)
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd /Users/carrieyu/Desktop/Hipe/mediapipe-test && python -m pytest tests/test_voice_endpoint.py -v`
Expected: FAIL (no `/api/voice` route → 404/405; `voice` not in summary).

- [ ] **Step 3: Wire the endpoint and session field in `backend/main.py`**

Add `voice` to the imports line (top of file) — change:
```python
from backend import sessions_store
```
to:
```python
from backend import sessions_store, voice
```

Add an optional `voice` field to `SessionRequest` (after the `emotion` field):
```python
    emotion: Optional[dict] = None
    voice: Optional[dict] = None
```

In the `session(req)` handler, after the line that sets `summary["emotion_mediapipe"] = ...`, add:
```python
    summary["voice"] = req.voice if (req.voice and req.voice.get("available")) else {"available": False}
```

Add the new endpoint (place it right after the existing `emotion_frame` endpoint, before `@app.post("/api/session")`):
```python
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
    except Exception as exc:  # network / Deepgram failure -> degrade
        logging.warning("voice transcription unavailable: %s", exc)
        return {"available": False}
    words = voice.parse_words(payload)
    return voice.compute_delivery(voice.measure_prosody(words), acoustic)
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /Users/carrieyu/Desktop/Hipe/mediapipe-test && python -m pytest tests/test_voice_endpoint.py -v`
Expected: all PASS.

- [ ] **Step 5: Run the full suite (no regressions)**

Run: `cd /Users/carrieyu/Desktop/Hipe/mediapipe-test && python -m pytest -q`
Expected: all pass (Plan 1 tests + new voice tests).

- [ ] **Step 6: Commit**

```bash
git add backend/main.py tests/test_voice_endpoint.py
git commit -m "feat(voice): /api/voice endpoint and session voice field"
```

---

## Task 3: In-browser pitch/energy DSP

**Files:**
- Create: `frontend/acoustic-features.js`

- [ ] **Step 1: Create the DSP module (ported from molave `acousticFeatures.ts`)**

```javascript
// frontend/acoustic-features.js
// In-browser pitch + energy features for a recorded interview, ported from
// molave-ai's acousticFeatures.ts. Decodes the audio, runs autocorrelation pitch
// tracking + RMS energy per frame, and aggregates over the whole recording.
// Used to feed the Delivery score (pitch variation = expressiveness; energy = loudness).

const MIN_F0_HZ = 70;
const MAX_F0_HZ = 400;
const VOICING_THRESHOLD = 0.45;   // autocorr peak strength vs energy to count as voiced
const ENERGY_FLOOR = 1e-4;        // skip pitch in near-silence
const MAX_FRAMES = 24000;         // bound work on long recordings

function decimateTo8k(samples, sampleRate){
  const factor = Math.max(1, Math.round(sampleRate / 8000));
  if (factor === 1) return { samples, sampleRate };
  const length = Math.floor(samples.length / factor);
  const out = new Float32Array(length);
  for (let index = 0; index < length; index += 1){
    let sum = 0;
    for (let k = 0; k < factor; k += 1) sum += samples[index * factor + k];
    out[index] = sum / factor;
  }
  return { samples: out, sampleRate: sampleRate / factor };
}

function computeFrames(rawSamples, rawRate){
  const { samples, sampleRate } = decimateTo8k(rawSamples, rawRate);
  const window = Math.round(0.04 * sampleRate);
  let hop = Math.round(0.02 * sampleRate);
  const estimatedFrames = Math.floor((samples.length - window) / hop);
  if (estimatedFrames > MAX_FRAMES) hop = Math.ceil((samples.length - window) / MAX_FRAMES);

  const minLag = Math.floor(sampleRate / MAX_F0_HZ);
  const maxLag = Math.floor(sampleRate / MIN_F0_HZ);
  const f0 = [];
  const rms = [];

  for (let start = 0; start + window <= samples.length; start += hop){
    let energy = 0;
    for (let i = 0; i < window; i += 1){ const v = samples[start + i]; energy += v * v; }
    const frameRms = Math.sqrt(energy / window);
    rms.push(frameRms);
    if (frameRms < ENERGY_FLOOR){ f0.push(0); continue; }

    let bestLag = 0, bestCorr = 0;
    for (let lag = minLag; lag <= maxLag; lag += 1){
      let corr = 0;
      const limit = window - lag;
      for (let i = 0; i < limit; i += 1) corr += samples[start + i] * samples[start + i + lag];
      if (corr > bestCorr){ bestCorr = corr; bestLag = lag; }
    }
    const ratio = energy > 0 ? bestCorr / energy : 0;
    f0.push(bestLag > 0 && ratio > VOICING_THRESHOLD ? sampleRate / bestLag : 0);
  }
  return { f0, rms };
}

function mean(values){ return values.length ? values.reduce((s, v) => s + v, 0) / values.length : 0; }
function std(values, avg){
  if (!values.length) return 0;
  const variance = values.reduce((s, v) => s + (v - avg) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}
function median(values){
  const c = values.filter((v) => Number.isFinite(v)).slice().sort((a, b) => a - b);
  if (!c.length) return 0;
  const mid = Math.floor(c.length / 2);
  return c.length % 2 === 0 ? (c[mid - 1] + c[mid]) / 2 : c[mid];
}
function trimOctaveOutliers(values){
  if (values.length < 4) return values;
  const center = median(values);
  if (center <= 0) return values;
  const kept = values.filter((v) => v >= center * 0.6 && v <= center * 1.8);
  return kept.length >= 2 ? kept : values;
}

// Decode an audio Blob and return whole-recording acoustic features. Never throws:
// returns null when the audio can't be decoded so the caller can degrade.
export async function computeAcousticFeatures(blob){
  try {
    const buf = await blob.arrayBuffer();
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctx();
    const audio = await ctx.decodeAudioData(buf);
    ctx.close();
    const samples = audio.getChannelData(0);
    const { f0, rms } = computeFrames(samples, audio.sampleRate);
    const pitches = trimOctaveOutliers(f0.filter((v) => v > 0));
    const voiced = f0.filter((v) => v > 0).length;
    const pitchMean = mean(pitches);
    const energyMean = mean(rms);
    return {
      pitchMeanHz: Math.round(pitchMean * 10) / 10,
      pitchStdHz: Math.round(std(pitches, pitchMean) * 10) / 10,
      energyMean: Math.round(energyMean * 10000) / 10000,
      energyStd: Math.round(std(rms, energyMean) * 10000) / 10000,
      voicedRatio: f0.length ? Math.round((voiced / f0.length) * 100) / 100 : 0,
    };
  } catch (e){
    console.warn('[voice] acoustic feature extraction failed:', e && e.message);
    return null;
  }
}
```

- [ ] **Step 2: Verify it parses**

Run: `cd /Users/carrieyu/Desktop/Hipe/mediapipe-test && node --input-type=module --check < frontend/acoustic-features.js && echo SYNTAX_OK`
Expected: `SYNTAX_OK`

- [ ] **Step 3: Commit**

```bash
git add frontend/acoustic-features.js
git commit -m "feat(voice): in-browser pitch/energy DSP (ported from molave)"
```

---

## Task 4: Audio recorder

**Files:**
- Create: `frontend/audio-recorder.js`

- [ ] **Step 1: Create the recorder module**

```javascript
// frontend/audio-recorder.js
// Records the candidate's microphone to a Blob during the interview, by tapping
// the same MediaStream the voice agent uses. Independent of the Deepgram agent
// connection — it just captures the audio for post-interview Delivery analysis.

// Pick a container the browser can record AND Deepgram can read (webm/opus, else mp4).
function pickMimeType(){
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
  for (const t of candidates){
    if (window.MediaRecorder && MediaRecorder.isTypeSupported(t)) return t;
  }
  return '';   // let the browser choose
}

// Start recording the audio tracks of `stream`. Returns a handle with stop().
// stop() resolves to a { blob, mime } object, or null if nothing was captured.
export function startRecording(stream){
  const audioTracks = stream ? stream.getAudioTracks() : [];
  if (!audioTracks.length) return null;   // no mic -> caller skips voice analysis
  const mime = pickMimeType();
  let recorder;
  try {
    recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
  } catch (e){
    console.warn('[voice] MediaRecorder unavailable:', e && e.message);
    return null;
  }
  const chunks = [];
  recorder.ondataavailable = (ev) => { if (ev.data && ev.data.size) chunks.push(ev.data); };
  recorder.start();   // single blob on stop (no timeslice needed)

  return {
    stop(){
      return new Promise((resolve) => {
        if (recorder.state === 'inactive'){ resolve(null); return; }
        recorder.onstop = () => {
          if (!chunks.length){ resolve(null); return; }
          const type = recorder.mimeType || mime || 'audio/webm';
          resolve({ blob: new Blob(chunks, { type }), mime: type });
        };
        try { recorder.stop(); } catch (_){ resolve(null); }
      });
    },
  };
}
```

- [ ] **Step 2: Verify it parses**

Run: `cd /Users/carrieyu/Desktop/Hipe/mediapipe-test && node --input-type=module --check < frontend/audio-recorder.js && echo SYNTAX_OK`
Expected: `SYNTAX_OK`

- [ ] **Step 3: Commit**

```bash
git add frontend/audio-recorder.js
git commit -m "feat(voice): MediaRecorder audio capture over the mic stream"
```

---

## Task 5: `api.analyzeVoice` + live-screen integration

**Files:**
- Modify: `frontend/api.js`
- Modify: `frontend/screens/live.js`

- [ ] **Step 1: Add the `analyzeVoice` helper to `frontend/api.js`**

Inside the `api` object, after `createSession`, add:
```javascript
  // POST the recorded audio + browser acoustic features for Delivery scoring.
  // Never throws: resolves to {available:false} when the server can't score it.
  analyzeVoice: (blob, acoustic) => {
    const fd = new FormData();
    fd.append('meta', JSON.stringify({ acoustic }));
    fd.append('audio', blob, 'interview' + (blob.type.includes('mp4') ? '.mp4' : '.webm'));
    return fetch('/api/voice', { method: 'POST', body: fd })
      .then((r) => (r.ok ? r.json() : { available: false }))
      .catch(() => ({ available: false }));
  },
```

- [ ] **Step 2: Import the recorder + DSP in `frontend/screens/live.js`**

At the top of `frontend/screens/live.js`, after the existing imports, add:
```javascript
import { startRecording } from '../audio-recorder.js';
import { computeAcousticFeatures } from '../acoustic-features.js';
```

- [ ] **Step 3: Add a recorder handle to the module state**

Next to `let pendingScore = null;`, add:
```javascript
let recorder = null;   // active audio recorder handle, or null
```

- [ ] **Step 4: Start recording when the interview starts**

In `startEngine`, AFTER the successful engine start and the `if (micOk) startAgent();` line, start the recorder from the engine's stream. Find this block:
```javascript
  if (micOk) startAgent();
  else setVoice('Mic unavailable — analysis only');
```
and change it to:
```javascript
  if (micOk){
    startAgent();
    recorder = startRecording(engine.getStream());   // capture audio for Delivery analysis
  } else {
    setVoice('Mic unavailable — analysis only');
  }
```

- [ ] **Step 5: In `finishInterview`, stop the recorder, compute features, analyze, and attach `voice`**

The current `finishInterview` grabs frames, tears down, then (when frames exist) builds `full_text` and calls `submitScore`. Change the body so it stops the recorder BEFORE teardown, then runs voice analysis before scoring. Replace the section of `finishInterview` from the `const frames = ...` line through the `await submitScore(...)` line with:

```javascript
  const frames = engine.getFrames().slice();   // copy before stop() releases it
  const rec = recorder; recorder = null;
  stopAgent();
  const audio = rec ? await rec.stop() : null;   // finalize the recording before we drop the stream
  engine.stop();
  setState('Processing…'); setVoice('Scoring your interview…');
  const live = document.getElementById('lv-live'); if (live) live.classList.remove('on');
  const stopBtn = document.getElementById('lv-stop'); if (stopBtn) stopBtn.style.display = 'none';

  if (!frames.length){
    setState('Stopped'); setVoice('Nothing to score');
    const startBtn = document.getElementById('lv-start');
    if (startBtn){ startBtn.style.display = ''; startBtn.textContent = 'Start'; }
    return;
  }

  // Voice (Delivery) analysis: compute pitch/energy locally, send audio + features
  // to the backend. Non-fatal — a failure just omits the Delivery signal.
  let voice = null;
  if (audio && audio.blob){
    setVoice('Analyzing your voice…');
    const acoustic = await computeAcousticFeatures(audio.blob);
    voice = await api.analyzeVoice(audio.blob, acoustic || {});
  }

  const full_text = segments
    .map((s) => (s.speaker === 'interviewer' ? 'INTERVIEWER: ' : 'CANDIDATE: ') + s.text)
    .join('\n');
  await submitScore({ role, frames, transcript: { full_text, segments }, events, emotion: null, voice });
```

> Note: `rec.stop()` must be awaited BEFORE `engine.stop()` because `engine.stop()` stops the mic tracks; stopping the recorder first flushes the final audio. The recorder taps the same stream but finalizes its blob on `stop()`.

- [ ] **Step 6: Reset the recorder reference on a fresh start**

In `startEngine`'s reset line (the one that sets `pendingScore = null; role = ...`), also clear any stale recorder:
```javascript
  pendingScore = null; role = getInterviewConfig().role; recorder = null;
```

- [ ] **Step 7: Verify both files parse**

Run: `cd /Users/carrieyu/Desktop/Hipe/mediapipe-test && node --input-type=module --check < frontend/api.js && node --input-type=module --check < frontend/screens/live.js && echo SYNTAX_OK`
Expected: `SYNTAX_OK`

- [ ] **Step 8: Commit**

```bash
git add frontend/api.js frontend/screens/live.js
git commit -m "feat(voice): record audio, analyze delivery, attach voice to session"
```

---

## Task 6: Render the Voice / Delivery section on the report

**Files:**
- Modify: `frontend/screens/report.js`

- [ ] **Step 1: Add a `voiceCard` renderer**

In `frontend/screens/report.js`, add this function after the `emotionBars` function:
```javascript
function voiceCard(v){
  if (!v || !v.available) return '<p class="muted" style="font-size:12px">Voice delivery analysis not available for this session.</p>';
  const m = v.metrics || {};
  const rows = [
    ['Delivery score', (v.delivery_score == null ? '—' : v.delivery_score) + '/100'],
    ['Speaking pace', (m.wpm ?? '—') + ' wpm'],
    ['Filler words', (m.filler_count ?? '—') + ' (' + (m.filler_rate_per100 ?? '—') + '/100 words)'],
    ['Long pauses', (m.long_pause_count ?? '—')],
    ['Pitch variation', (m.pitch_std_hz ?? '—') + ' Hz'],
  ];
  return rows.map((r) => '<div class="r"><span>' + esc(r[0]) + '</span><b>' + esc(String(r[1])) + '</b></div>').join('');
}
```

- [ ] **Step 2: Render it in the report `view`**

In the `view(s)` function, after the line `const ig = s.integrity || {};`, add:
```javascript
  const v = s.voice || { available: false };
```
Then add a chart-card for it. Insert this immediately BEFORE the `'<div class="chart-card"><div class="ct">Emotion (MediaPipe)</div>'` line in the returned template:
```javascript
    '<div class="chart-card"><div class="ct">Voice (Delivery)</div>' +
      '<div class="cs">Pace, fillers, pauses, and pitch variation from your recorded audio.</div>' +
      voiceCard(v) + '</div>' +
```

- [ ] **Step 3: Verify it parses**

Run: `cd /Users/carrieyu/Desktop/Hipe/mediapipe-test && node --input-type=module --check < frontend/screens/report.js && echo SYNTAX_OK`
Expected: `SYNTAX_OK`

- [ ] **Step 4: Commit**

```bash
git add frontend/screens/report.js
git commit -m "feat(voice): show Voice (Delivery) section on the report"
```

---

## Task 7: Verification

- [ ] **Step 1: Full backend test suite**

Run: `cd /Users/carrieyu/Desktop/Hipe/mediapipe-test && python -m pytest -q`
Expected: all pass (Plan 1 + voice unit tests + voice endpoint tests).

- [ ] **Step 2: Manual browser test (requires DEEPGRAM_API_KEY)**

Run a short interview, speak a few sentences (include an "um" and a long pause), press Stop. Expected:
- The status briefly shows "Analyzing your voice…" then "Processing…".
- The report opens and the new **Voice (Delivery)** card shows a delivery score, a words-per-minute figure, a filler count (≥1 if you said "um"), long pauses, and pitch variation.
- If you deny the mic (vision-only), the Voice card shows "not available" and the rest of the report still renders.

- [ ] **Step 3: Confirm the audio is not persisted**

After a run, confirm the `sessions/<id>/` folder contains NO audio file (only the existing summary.json / transcript.txt / charts). The audio is scored in memory and discarded.

---

## Self-Review

**Spec coverage (Plan 2 scope — voice analysis):**
- Record candidate audio → Task 4 (recorder) + Task 5 (start/stop wiring). ✓
- Deepgram pre-recorded pass for word timings + fillers → Task 1 (`transcribe_prerecorded` + `parse_words`) + Task 2 (endpoint). ✓
- Pitch/energy DSP in browser → Task 3. ✓
- Delivery sub-score against absolute bands → Task 1 (`compute_delivery`). ✓
- Stored on the session + shown on report → Task 2 (`summary.voice`) + Task 6 (Voice card). ✓
- Privacy: audio scored in memory, never written to disk → Task 2 endpoint (no disk write) + Task 7 Step 3 check. ✓
- Fused verdict (Delivery + Presence + Content into one readiness number) → **out of scope; Plan 3.**

**Placeholder scan:** every code step contains complete code; commands have expected output. No TBD. ✓

**Type/name consistency:** `compute_delivery`/`measure_prosody`/`parse_words`/`transcribe_prerecorded`/`DELIVERY_WEIGHTS` defined in Task 1 and used in Task 2; `computeAcousticFeatures` (Task 3) returns `{pitchMeanHz, pitchStdHz, energyMean, energyStd, voicedRatio}` consumed by `compute_delivery` via the `acoustic` arg and by `api.analyzeVoice` (Task 5); `startRecording().stop()` resolves `{blob, mime}` used in Task 5; `summary.voice` written in Task 2 and read by `voiceCard` in Task 6. ✓

---

## Execution Handoff

After Plan 2 is implemented and verified, Plan 3 (fused readiness verdict) will combine `summary.voice.delivery_score` (Delivery) with the Presence composite and a Content score into a single readiness score + band + Claude explanation.
