// frontend/deepgram-client.js
// Live voice-agent client. Ported from ai-interview-v2 InCall.tsx audio pipeline.
//
// Auth scheme matters: a raw Deepgram API key uses the "token" subprotocol;
// an ephemeral token (from /v1/auth/grant) uses "bearer". The backend tells us which.
export function startVoiceAgent({ url, token, scheme, config, micStream, onTranscript, onError, onClose, onSpeaking }) {
  const sub = scheme || "token";
  console.log(`[dg] connecting: scheme=${sub} tokenLen=${(token || "").length} url=${url}`);
  const ws = new WebSocket(url, [sub, token]);
  ws.binaryType = "arraybuffer";

  const inCtx = new AudioContext({ sampleRate: 48000 });
  const outCtx = new AudioContext({ sampleRate: 24000 });
  let nextStart = 0;
  let processor = null;
  let source = null;
  let audioChunks = 0;
  let muted = false;
  let speaking = false;
  let silenceTimer = null;

  ws.onopen = () => {
    console.log("[dg] ws OPEN — sending Settings; inCtx=%s outCtx=%s", inCtx.state, outCtx.state);
    // Browsers may start an AudioContext suspended; resume so TTS is audible.
    inCtx.resume().catch(() => {});
    outCtx.resume().catch(() => {});
    // Tell Deepgram the ACTUAL input sample rate (browsers may not honor 48k) to avoid
    // mislabeled PCM that garbles transcription.
    if (config && config.audio && config.audio.input) {
      config.audio.input.sample_rate = inCtx.sampleRate;
    }
    console.log("[dg] input sample_rate =", inCtx.sampleRate);
    ws.send(JSON.stringify(config)); // Settings first

    source = inCtx.createMediaStreamSource(micStream);
    processor = inCtx.createScriptProcessor(4096, 1, 1);
    processor.onaudioprocess = (e) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      if (muted) return;
      const input = e.inputBuffer.getChannelData(0);
      const int16 = new Int16Array(input.length);
      for (let i = 0; i < input.length; i++) {
        const s = Math.max(-1, Math.min(1, input[i]));
        int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      ws.send(int16.buffer);
    };
    source.connect(processor);
    processor.connect(inCtx.destination);
  };

  ws.onmessage = (event) => {
    if (event.data instanceof ArrayBuffer) {
      // binary = TTS audio (24kHz int16 mono)
      audioChunks += 1;
      if (audioChunks === 1) console.log("[dg] first TTS audio chunk received");
      const int16 = new Int16Array(event.data);
      const f32 = new Float32Array(int16.length);
      for (let i = 0; i < int16.length; i++) f32[i] = int16[i] / 32768;
      const buf = outCtx.createBuffer(1, f32.length, 24000);
      buf.getChannelData(0).set(f32);
      const src = outCtx.createBufferSource();
      src.buffer = buf;
      src.connect(outCtx.destination);
      const now = outCtx.currentTime;
      const start = Math.max(now, nextStart);
      src.start(start);
      nextStart = start + buf.duration;
      markSpeaking();
    } else {
      const msg = JSON.parse(event.data);
      console.log("[dg] <-", msg.type);
      if (msg.type === "ConversationText") {
        onTranscript({
          speaker: msg.role === "assistant" ? "interviewer" : "candidate",
          text: msg.content,
        });
      } else if (msg.type === "Error" || msg.type === "Warning") {
        console.error("[dg] agent message:", msg);
        if (onError) onError(msg.description || msg.message || msg.type);
      }
    }
  };

  ws.onclose = (e) => {
    console.warn(`[dg] ws CLOSED code=${e.code} reason="${e.reason}" — audioChunks=${audioChunks}`);
    if (onClose) onClose(e);
  };
  ws.onerror = (ev) => {
    console.error("[dg] ws ERROR", ev);
    if (onError) onError("voice connection error");
  };

  // The AI is "speaking" while TTS audio is queued; flips off shortly after the
  // last scheduled chunk finishes playing.
  function markSpeaking(){
    if (!speaking){ speaking = true; if (onSpeaking) onSpeaking(true); }
    clearTimeout(silenceTimer);
    const ms = Math.max(0, (nextStart - outCtx.currentTime) * 1000) + 150;
    silenceTimer = setTimeout(() => { speaking = false; if (onSpeaking) onSpeaking(false); }, ms);
  }

  return {
    stop() {
      console.log("[dg] stopping agent");
      clearTimeout(silenceTimer);
      try { if (processor) processor.disconnect(); } catch (_) {}
      try { if (source) source.disconnect(); } catch (_) {}
      try { inCtx.close(); } catch (_) {}
      try { outCtx.close(); } catch (_) {}
      if (ws.readyState === WebSocket.OPEN) ws.close();
    },
    setMuted(m) { muted = !!m; },
  };
}
