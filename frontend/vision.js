import { FaceLandmarker, PoseLandmarker, HandLandmarker, GestureRecognizer, FilesetResolver, DrawingUtils }
  from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35";
import { CONFIG } from './config.js';

let tasks = null;     // { face, pose, hands } — created once, reused
let session = null;   // active camera/loop, or null

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

// Stop the camera + loop and release the webcam. Idempotent.
export function stop(){
  if (!session) return;
  session.running = false;
  if (session.rafId) cancelAnimationFrame(session.rafId);
  if (session.stream) session.stream.getTracks().forEach((t) => t.stop());
  session = null;
}

// Start the camera and detection loop. `onFrame({mode, detections, fps, blendshapes})`
// is called once per frame; `blendshapes` is non-null only in face mode.
export async function start(canvas, mode, onFrame){
  stop();
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { width: 1280, height: 720, facingMode: 'user' }, audio: false,
  });
  const video = document.createElement('video');
  video.srcObject = stream; video.muted = true; video.playsInline = true;
  await video.play();
  await ensureTasks();
  if (!document.body.contains(canvas)){   // navigated away during model load
    stream.getTracks().forEach((t) => t.stop());
    return;
  }
  canvas.width = 1280; canvas.height = 720;
  const ctx = canvas.getContext('2d');
  const draw = new DrawingUtils(ctx);
  session = { stream, video, mode, running: true, rafId: 0, fps: 0, _t: performance.now(), _n: 0 };

  const loop = () => {
    if (!session || !session.running) return;
    if (!document.body.contains(canvas)){ stop(); return; }   // left the screen
    const now = performance.now();
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const out = { mode: session.mode, detections: 0, fps: session.fps, blendshapes: null };

    try {
      if (session.mode === 'face'){
        const r = tasks.face.detectForVideo(video, now);
        const faces = r.faceLandmarks || [];
        out.detections = faces.length;
        for (const fl of faces){
          draw.drawConnectors(fl, FaceLandmarker.FACE_LANDMARKS_TESSELATION, { color: '#15794c66', lineWidth: 0.5 });
        }
        if (r.faceBlendshapes && r.faceBlendshapes[0]){
          out.blendshapes = pickBlendshapes(r.faceBlendshapes[0].categories);
        }
      } else if (session.mode === 'pose'){
        const r = tasks.pose.detectForVideo(video, now);
        const poses = r.landmarks || [];
        out.detections = poses.length;
        for (const lm of poses){
          draw.drawConnectors(lm, PoseLandmarker.POSE_CONNECTIONS, { color: '#157a4c', lineWidth: 2 });
          draw.drawLandmarks(lm, { color: '#0f5c39', radius: 2 });
        }
      } else { // hands
        const r = tasks.hands.recognizeForVideo(video, now);
        const hands = r.landmarks || [];
        out.detections = hands.length;
        for (const lm of hands){
          draw.drawConnectors(lm, HandLandmarker.HAND_CONNECTIONS, { color: '#ffffffcc', lineWidth: 2 });
          draw.drawLandmarks(lm, { color: '#157a4c', radius: 2 });
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
