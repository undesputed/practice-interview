// frontend/deepgram-client.js
// Live voice-agent client. Ported from ai-interview-v2 InCall.tsx audio pipeline.
export function startVoiceAgent({ url, token, config, micStream, onTranscript, onError, onClose }) {
  const ws = new WebSocket(url, ["token", token]);
  ws.binaryType = "arraybuffer";

  const inCtx = new AudioContext({ sampleRate: 48000 });
  const outCtx = new AudioContext({ sampleRate: 24000 });
  let nextStart = 0;
  let processor = null;
  let source = null;

  ws.onopen = () => {
    ws.send(JSON.stringify(config)); // Settings first

    source = inCtx.createMediaStreamSource(micStream);
    processor = inCtx.createScriptProcessor(4096, 1, 1);
    processor.onaudioprocess = (e) => {
      if (ws.readyState !== WebSocket.OPEN) return;
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
    } else {
      const msg = JSON.parse(event.data);
      if (msg.type === "ConversationText") {
        onTranscript({
          speaker: msg.role === "assistant" ? "interviewer" : "candidate",
          text: msg.content,
        });
      } else if (msg.type === "Error" || msg.type === "Warning") {
        if (onError) onError(msg.description || msg.message || msg.type);
      }
    }
  };

  ws.onclose = (e) => { if (onClose) onClose(e); };
  ws.onerror = () => { if (onError) onError("voice connection error"); };

  return {
    stop() {
      try { if (processor) processor.disconnect(); } catch (_) {}
      try { if (source) source.disconnect(); } catch (_) {}
      try { inCtx.close(); } catch (_) {}
      try { outCtx.close(); } catch (_) {}
      if (ws.readyState === WebSocket.OPEN) ws.close();
    },
  };
}
