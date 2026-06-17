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
  // Record an AUDIO-ONLY stream. The engine's MediaStream also carries a video track,
  // and an audio-only mimeType (webm/opus) cannot encode video — MediaRecorder.start()
  // then throws NotSupportedError. Isolating the audio tracks avoids that.
  const audioStream = new MediaStream(audioTracks);
  const mime = pickMimeType();
  const chunks = [];
  let recorder;
  try {
    recorder = mime ? new MediaRecorder(audioStream, { mimeType: mime }) : new MediaRecorder(audioStream);
    recorder.ondataavailable = (ev) => { if (ev.data && ev.data.size) chunks.push(ev.data); };
    recorder.start();   // single blob on stop (no timeslice needed); guarded so a start
                        // failure degrades to "no Delivery analysis" instead of crashing.
  } catch (e){
    console.warn('[voice] MediaRecorder failed to start:', e && e.message);
    return null;
  }

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
    // Pause/resume capture for the live "mute" control, so muted silence isn't
    // recorded and doesn't drag down the Delivery score.
    pause(){ try { if (recorder.state === 'recording') recorder.pause(); } catch (_){} },
    resume(){ try { if (recorder.state === 'paused') recorder.resume(); } catch (_){} },
  };
}
