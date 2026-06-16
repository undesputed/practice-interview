// frontend/interview-engine.js
// DOM-free MediaPipe capture engine for the live interview. Runs face mesh +
// hands/gestures every (unique) frame and feeds the action detector; pose +
// objects run only when the overlay is shown. All models use the GPU delegate.
// No audio, no frame collection, no network — those attach in later steps.
// Modeled on the proven loop in app.js, decoupled from the DOM.
import { CONFIG } from './config.js';
import { createActionDetector } from './actions.js';
import { FaceLandmarker, PoseLandmarker, HandLandmarker, GestureRecognizer, ObjectDetector, FilesetResolver, DrawingUtils }
  from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35";

let tasks = null;     // { face, pose, gesture, objects } — created once, reused
let session = null;   // active camera/loop, or null

// Create the four MediaPipe tasks once (downloads WASM + models on first call).
async function ensureTasks(){
  if (tasks) return tasks;
  const fileset = await FilesetResolver.forVisionTasks(CONFIG.WASM_BASE);
  // delegate: 'GPU' runs inference on the GPU (WebGL) instead of the CPU. This is
  // the single biggest win for camera smoothness — CPU inference on four models
  // saturates the main thread, which lags the video and starves the audio stream.
  const face = await FaceLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: CONFIG.MODEL_URL, delegate: 'GPU' },
    runningMode: 'VIDEO', numFaces: 2,
    outputFaceBlendshapes: true, outputFacialTransformationMatrixes: true,
  });
  const pose = await PoseLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: CONFIG.POSE_MODEL_URL, delegate: 'GPU' },
    runningMode: 'VIDEO', numPoses: 1,
  });
  const gesture = await GestureRecognizer.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: CONFIG.GESTURE_MODEL_URL, delegate: 'GPU' },
    runningMode: 'VIDEO', numHands: 2,
  });
  const objects = await ObjectDetector.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: CONFIG.OBJECT_MODEL_URL, delegate: 'GPU' },
    runningMode: 'VIDEO', scoreThreshold: 0.4, maxResults: 5,
  });
  tasks = { face, pose, gesture, objects };
  return tasks;
}

function pickBlendshapes(categories){
  const out = {};
  for (const k of CONFIG.BLENDSHAPES) out[k] = 0;
  if (categories) for (const c of categories){
    if (CONFIG.BLENDSHAPES.includes(c.categoryName)) out[c.categoryName] = c.score;
  }
  return out;
}

export function isRunning(){ return !!(session && session.running); }

// The live camera+mic stream, so the screen can hand the mic to the voice agent. null when stopped.
export function getStream(){ return session ? session.stream : null; }

// Tag subsequent action events with the current interview question index. The screen
// advances this as the AI interviewer asks each question (was hard-pinned to -1).
export function setTurn(n){ if (session) session.turn = n; }

// Identifies the most recent start() in flight. A newer start() (or any stop())
// supersedes older in-flight attempts so they release their camera and bail —
// this prevents a double-Start from leaking a stream and running two loops.
let starting = null;

// Stop the camera + loop and release the webcam. Idempotent. Also invalidates
// any start() still in flight.
export function stop(){
  starting = null;
  if (!session) return;
  session.running = false;
  if (session.rafId) cancelAnimationFrame(session.rafId);
  if (session.stream) session.stream.getTracks().forEach((t) => t.stop());
  session = null;
}

// Start the camera (video only) and the detection loop. Callbacks:
//   onStats({ elapsedMs, face, faceCount, fps, detections }) — throttled to ~4/s.
//   onAction({ t, turn, kind, label, icon }) — once per detected action onset.
export async function start(canvas, { onStats, onAction, showOverlay = false, audio = true } = {}){
  stop();
  const myToken = {};
  starting = myToken;
  // Always release `stream` unless THIS call wins and hands it to `session`.
  const superseded = () => starting !== myToken;
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      // Cap the camera at 30fps: combined with the duplicate-frame skip in the
      // loop, this holds MediaPipe inference at ~30fps so it can't saturate the
      // main thread (which would lag the video and choke the audio stream).
      video: { width: 1280, height: 720, facingMode: 'user', frameRate: { ideal: 30, max: 30 } },
      // Audio is captured for the voice agent (same constraints app.js used). When the
      // caller asks for audio:false, run vision only — used as the mic-blocked fallback.
      audio: audio ? { sampleRate: 48000, channelCount: 1,
                       echoCancellation: true, noiseSuppression: true, autoGainControl: true } : false,
    });
    if (superseded()){ stream.getTracks().forEach((t) => t.stop()); return; }
    const video = document.createElement('video');
    video.srcObject = stream; video.muted = true; video.playsInline = true;
    await video.play();
    if (superseded()){ stream.getTracks().forEach((t) => t.stop()); return; }
    await ensureTasks();
    // superseded, or navigated away during the multi-second model load
    if (superseded() || !document.body.contains(canvas)){
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    launch(canvas, video, stream, { onStats, onAction, showOverlay });
  } catch (e){
    if (stream) stream.getTracks().forEach((t) => t.stop());  // release on any failure after the camera opened
    if (starting === myToken) starting = null;
    throw e;
  }
}

// Build the session and run the loop. Split out so start()'s try/catch only guards
// the async setup, not the per-frame loop.
function launch(canvas, video, stream, { onStats, onAction, showOverlay }){
  starting = null;
  canvas.width = 1280; canvas.height = 720;
  const ctx = canvas.getContext('2d');
  const draw = new DrawingUtils(ctx);
  const detector = createActionDetector();
  session = {
    stream, video, running: true, rafId: 0, showOverlay: !!showOverlay, turn: -1,
    startTs: performance.now(), fps: 0, _t: performance.now(), _n: 0,
    lastBodyTs: 0, lastStatsTs: 0, lastVideoTime: -1,
    lastPose: null, lastHand: null, lastObjects: null,
  };

  const loop = () => {
    if (!session || !session.running) return;
    if (!document.body.contains(canvas)){ stop(); return; }   // left the screen
    const now = performance.now();

    // The webcam delivers ~30fps but rAF fires ~60fps. Skip frames that haven't
    // advanced so MediaPipe never runs twice on the same image — this caps all
    // inference at the camera's true rate and frees the main thread for smooth
    // video and steady audio streaming to the voice agent (Deepgram).
    if (video.currentTime === session.lastVideoTime){
      session.rafId = requestAnimationFrame(loop);
      return;
    }
    session.lastVideoTime = video.currentTime;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    // Face runs once per unique frame (~30fps after the dedup above): drives the
    // mesh overlay, blendshapes, and the head-pose matrix the action detector needs.
    let bs = null, m = null, hasFace = false, faceCount = 0;
    try {
      const r = tasks.face.detectForVideo(video, now);
      const faces = r.faceLandmarks || [];
      faceCount = faces.length;
      hasFace = faceCount > 0;
      if (session.showOverlay){
        for (const fl of faces){
          draw.drawConnectors(fl, FaceLandmarker.FACE_LANDMARKS_TESSELATION, { color: '#15794c66', lineWidth: 0.5 });
        }
      }
      bs = pickBlendshapes(hasFace ? r.faceBlendshapes?.[0]?.categories : null);
      m = hasFace && r.facialTransformationMatrixes?.[0]
        ? Array.from(r.facialTransformationMatrixes[0].data)
        : [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];
    } catch (e){ /* a single bad frame must not kill the loop */ }

    // Hands/gestures feed the action detector, so they run in every mode (throttled).
    // Pose + objects are only ever drawn on the overlay and aren't used by the
    // detector, so skip them entirely when the overlay is hidden — that's the live
    // interview, where every spare millisecond keeps the video and audio smooth.
    if (now - session.lastBodyTs >= CONFIG.POSE_THROTTLE_MS){
      session.lastBodyTs = now;
      try {
        const hr = tasks.gesture.recognizeForVideo(video, now);
        session.lastHand = (hr && hr.landmarks && hr.landmarks.length) ? hr : null;
        if (session.showOverlay){
          const pr = tasks.pose.detectForVideo(video, now);
          session.lastPose = pr.landmarks || null;
          const orr = tasks.objects.detectForVideo(video, now);
          session.lastObjects = (orr && orr.detections && orr.detections.length) ? orr.detections : null;
        }
      } catch (e){ /* skip body detect on a bad frame */ }
    }

    // Overlays are drawn only when asked. The live interview runs clean (showOverlay:false)
    // so the candidate sees a plain video — detection above still ran, it just isn't drawn.
    if (session.showOverlay){
      if (session.lastPose){
        for (const lm of session.lastPose){
          draw.drawConnectors(lm, PoseLandmarker.POSE_CONNECTIONS, { color: '#157a4c', lineWidth: 2 });
          draw.drawLandmarks(lm, { color: '#0f5c39', radius: 2 });
        }
      }
      if (session.lastHand && session.lastHand.landmarks){
        for (const lm of session.lastHand.landmarks){
          draw.drawConnectors(lm, HandLandmarker.HAND_CONNECTIONS, { color: '#ffffffcc', lineWidth: 2 });
          draw.drawLandmarks(lm, { color: '#157a4c', radius: 2 });
        }
      }
      if (session.lastObjects){
        // Boxes only (no text label — the canvas is CSS-mirrored, so text would read backwards).
        ctx.strokeStyle = '#e0a100'; ctx.lineWidth = 2;
        for (const d of session.lastObjects){
          const b = d.boundingBox;
          if (b) ctx.strokeRect(b.originX, b.originY, b.width, b.height);
        }
      }
    }

    // Action detection. `turn` starts at -1 and advances as the AI asks each question (setTurn).
    const tRel = now - session.startTs;
    const gestureNames = (session.lastHand && session.lastHand.gestures)
      ? session.lastHand.gestures.map((g) => g && g[0] && g[0].categoryName) : [];
    for (const ev of detector.feed({ t: tRel, turn: session.turn, bs, gestures: gestureNames, m, face: hasFace })){
      if (onAction) onAction(ev);
    }

    session._n++;
    if (now - session._t > 500){
      session.fps = Math.round(session._n * 1000 / (now - session._t));
      session._n = 0; session._t = now;
    }

    // Status is throttled to ~4/s so we don't rewrite the rail every frame.
    if (onStats && now - session.lastStatsTs >= 250){
      session.lastStatsTs = now;
      const detections = faceCount
        + (session.lastHand && session.lastHand.landmarks ? session.lastHand.landmarks.length : 0)
        + (session.lastObjects ? session.lastObjects.length : 0);
      onStats({ elapsedMs: tRel, face: hasFace, faceCount, fps: session.fps, detections });
    }

    session.rafId = requestAnimationFrame(loop);
  };
  session.rafId = requestAnimationFrame(loop);
}
