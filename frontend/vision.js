import { FaceLandmarker, PoseLandmarker, HandLandmarker, GestureRecognizer, FilesetResolver, DrawingUtils }
  from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35";
import { CONFIG } from './config.js';

let tasks = null;     // { face, pose, hands } — created once, reused
let session = null;   // active camera/loop, or null
let effectsOn = false;   // when true, run face + gesture together for the reaction overlay
const EFFECTS_INTERVAL_MS = 100;   // throttle effects-only detectors to ~10 fps

// Create the three MediaPipe tasks once (downloads WASM + models on first call).
async function ensureTasks(){
  if (tasks) return tasks;
  const fileset = await FilesetResolver.forVisionTasks(CONFIG.WASM_BASE);
  const face = await FaceLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: CONFIG.MODEL_URL },
    runningMode: 'VIDEO', numFaces: 1, outputFaceBlendshapes: true,
  });
  const pose = await PoseLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: CONFIG.POSE_MODEL_URL },
    runningMode: 'VIDEO', numPoses: 1,
  });
  const hands = await GestureRecognizer.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: CONFIG.GESTURE_MODEL_URL },
    runningMode: 'VIDEO', numHands: 2,
  });
  tasks = { face, pose, hands };
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

export function setMode(mode){ if (session) session.mode = mode; }

// Enable/disable combined face+gesture detection for the reaction-effects overlay.
// OFF keeps the classic single-detector-per-mode behavior.
export function setEffects(on){ effectsOn = !!on; }

// Capture a square JPEG crop of the current face from the live video for server-side
// emotion scoring. Returns a Promise<Blob|null>; null when not running, not in face
// mode, no face is detected, or the box is too small. Crops from the raw (un-mirrored)
// video, padded ~20% around the face landmark bounds.
export function captureFaceCrop(sizePx){
  if (!session || !session.running || session.mode !== 'face') return Promise.resolve(null);
  const lm = session._face, video = session.video;
  if (!lm || !video || !video.videoWidth) return Promise.resolve(null);
  let minX = 1, minY = 1, maxX = 0, maxY = 0;
  for (const p of lm){
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  const vw = video.videoWidth, vh = video.videoHeight;
  // SQUARE crop centered on the face (side = larger face dimension + ~25% margin each
  // side), so resizing into a square canvas does NOT stretch the face. A distorted
  // (non-square) crop skews the emotion model — this is the key accuracy fix.
  const bw = (maxX - minX) * vw, bh = (maxY - minY) * vh;
  const cx = ((minX + maxX) / 2) * vw, cy = ((minY + maxY) / 2) * vh;
  const side = Math.min(Math.max(bw, bh) * 1.5, vw, vh);
  if (side < 8) return Promise.resolve(null);
  const sx = Math.max(0, Math.min(cx - side / 2, vw - side));
  const sy = Math.max(0, Math.min(cy - side / 2, vh - side));
  const c = document.createElement('canvas');
  c.width = sizePx; c.height = sizePx;
  c.getContext('2d').drawImage(video, sx, sy, side, side, 0, 0, sizePx, sizePx);
  return new Promise((resolve) => c.toBlob((b) => resolve(b), 'image/jpeg', 0.8));
}

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

// Start the camera and detection loop. `onFrame({mode, detections, fps, blendshapes, gestures})`
// is called once per frame. `blendshapes` is non-null whenever the face detector ran this
// frame (face mode, or any mode while effects are on via setEffects). `gestures` is a
// `string[]` of gesture names when the gesture recognizer ran this frame, else `undefined`.
export async function start(canvas, mode, onFrame){
  stop();
  const myToken = {};
  starting = myToken;
  // From here on, always release `stream` unless THIS call is the one that wins
  // and hands it to `session`. `superseded()` is true if a newer start()/stop()
  // ran while we were awaiting.
  const superseded = () => starting !== myToken;
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { width: 1280, height: 720, facingMode: 'user' }, audio: false,
    });
    if (superseded()){ stream.getTracks().forEach((t) => t.stop()); return; }
    const video = document.createElement('video');
    video.srcObject = stream; video.muted = true; video.playsInline = true;
    await video.play();
    if (superseded()){ stream.getTracks().forEach((t) => t.stop()); return; }
    await ensureTasks();
    // superseded, or navigated away during model load
    if (superseded() || !document.body.contains(canvas)){
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    return launch(canvas, video, stream, mode, onFrame);
  } catch (e){
    if (stream) stream.getTracks().forEach((t) => t.stop());  // release on any failure after the camera opened
    if (starting === myToken) starting = null;
    throw e;
  }
}

// Build the session and run the loop. Split out so start()'s try/catch only
// guards the async setup, not the per-frame loop.
function launch(canvas, video, stream, mode, onFrame){
  starting = null;
  canvas.width = 1280; canvas.height = 720;
  const ctx = canvas.getContext('2d');
  const draw = new DrawingUtils(ctx);
  session = { stream, video, mode, running: true, rafId: 0, fps: 0, _t: performance.now(), _n: 0, _face: null, _fxFaceTs: 0, _fxGestTs: 0 };

  const loop = () => {
    if (!session || !session.running) return;
    if (!document.body.contains(canvas)){ stop(); return; }   // left the screen
    const now = performance.now();
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const out = { mode: session.mode, detections: 0, fps: session.fps, blendshapes: null, gestures: undefined, faceLandmarks: undefined, handLandmarks: undefined };
    const m = session.mode;
    const faceMode = m === 'face', poseMode = m === 'pose', handsMode = m === 'hands';
    // The current mode's detector runs every frame (as before). Effects-only
    // detectors run throttled so combined detection stays cheap.
    const faceDue = faceMode || (effectsOn && now - session._fxFaceTs >= EFFECTS_INTERVAL_MS);
    const gestDue = handsMode || (effectsOn && now - session._fxGestTs >= EFFECTS_INTERVAL_MS);

    try {
      if (faceDue){
        const r = tasks.face.detectForVideo(video, now);
        const faces = r.faceLandmarks || [];
        session._face = faces[0] || null;
        out.faceLandmarks = faces[0] || undefined;
        if (faceMode){
          out.detections = faces.length;
          for (const fl of faces){
            draw.drawConnectors(fl, FaceLandmarker.FACE_LANDMARKS_TESSELATION, { color: '#15794c66', lineWidth: 0.5 });
          }
        } else {
          session._fxFaceTs = now;
        }
        if (r.faceBlendshapes && r.faceBlendshapes[0]){
          out.blendshapes = pickBlendshapes(r.faceBlendshapes[0].categories);
        }
      }

      if (gestDue){
        const r = tasks.hands.recognizeForVideo(video, now);
        const hands = r.landmarks || [];
        out.handLandmarks = hands.length ? hands : undefined;
        if (handsMode){
          out.detections = hands.length;
          for (const lm of hands){
            draw.drawConnectors(lm, HandLandmarker.HAND_CONNECTIONS, { color: '#ffffffcc', lineWidth: 2 });
            draw.drawLandmarks(lm, { color: '#157a4c', radius: 2 });
          }
        } else {
          session._fxGestTs = now;
        }
        // One entry per detected hand ('None' placeholder if unclassified) so the index
        // stays aligned with out.handLandmarks — the effects anchor callouts by hand index.
        out.gestures = (r.gestures || []).map((g) => (g && g[0] && g[0].categoryName) || 'None');
      }

      if (poseMode){
        const r = tasks.pose.detectForVideo(video, now);
        const poses = r.landmarks || [];
        out.detections = poses.length;
        for (const lm of poses){
          draw.drawConnectors(lm, PoseLandmarker.POSE_CONNECTIONS, { color: '#157a4c', lineWidth: 2 });
          draw.drawLandmarks(lm, { color: '#0f5c39', radius: 2 });
        }
      }
    } catch (e){ /* a single bad frame must not kill the loop */ }

    session._n++;
    if (now - session._t > 500){
      session.fps = Math.round(session._n * 1000 / (now - session._t));
      session._n = 0; session._t = now;
    }
    out.fps = session.fps;
    onFrame(out);
    session.rafId = requestAnimationFrame(loop);
  };
  session.rafId = requestAnimationFrame(loop);
}
