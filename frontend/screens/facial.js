import * as vision from '../vision.js';
import { dominantEmotion, EMOTION_CLASSES } from '../emotion.js';
import { esc } from '../util.js';
import { api } from '../api.js';
import { CONFIG } from '../config.js';

// Curated blendshapes shown as bars, with friendly labels.
const DISPLAY = [
  ['mouthSmileLeft', 'Smile L'], ['mouthSmileRight', 'Smile R'],
  ['eyeBlinkLeft', 'Blink L'], ['eyeBlinkRight', 'Blink R'],
  ['browInnerUp', 'Brow Inner Up'], ['jawOpen', 'Jaw Open'],
  ['browDownLeft', 'Brow Down L'], ['browDownRight', 'Brow Down R'],
  ['mouthFrownLeft', 'Frown L'], ['mouthFrownRight', 'Frown R'],
  ['eyeWideLeft', 'Eye Wide L'], ['eyeWideRight', 'Eye Wide R'],
];

let engine = 'mediapipe';   // 'mediapipe' | 'deepface' (deepface stubbed)
let mode = 'face';          // 'face' | 'pose' | 'hands'

// DeepFace live track (server, ~every DEEPFACE_LIVE_MS). Runs only while engine==='deepface'.
let dfRunning = false, dfTimer = null;
let dfStatus = 'off';   // 'off' | 'warming' | 'measuring' | 'live' | 'unavailable'
let dfDom = null, dfScores = null;

function bsBars(bs){
  return DISPLAY.map((d) => {
    const v = Math.max(0, Math.min(1, bs[d[0]] || 0));
    return '<div class="bs-row"><span class="nm">' + d[1] + '</span>' +
      '<span class="track"><span class="fill" style="width:' + Math.round(v * 100) + '%"></span></span>' +
      '<span class="pct">' + Math.round(v * 100) + '%</span></div>';
  }).join('');
}

function dfSection(){
  if (engine !== 'deepface') return '';
  let body;
  if (dfStatus === 'warming'){
    body = '<div class="fa-note">Warming up DeepFace… the first read takes a few seconds.</div>';
  } else if (dfStatus === 'unavailable'){
    body = '<div class="fa-note">DeepFace is off on the server. Start it with <b>EMOTION_ANALYSIS=1</b>.</div>';
  } else if (dfStatus === 'live' && dfScores){
    body = '<div class="bs-bars">' + EMOTION_CLASSES.map((c) => {
      const v = Math.round(dfScores[c] || 0);
      return '<div class="bs-row"><span class="nm">' + c + '</span>' +
        '<span class="track"><span class="fill" style="width:' + v + '%"></span></span>' +
        '<span class="pct">' + v + '%</span></div>';
    }).join('') + '</div>';
  } else {
    body = '<div class="fa-note">Measuring…</div>';
  }
  const dom = (dfStatus === 'live' && dfDom) ? dfDom : '—';
  const every = Math.round(CONFIG.DEEPFACE_LIVE_MS / 1000);
  return '<div class="fa-df"><div class="phead"><div><h3>DeepFace (server)</h3>' +
      '<div class="desc">Trained model — refreshed every ' + every + 's.</div></div>' +
      '<div class="fa-dom"><div class="e">' + esc(dom) + '</div></div></div>' + body + '</div>';
}

let lastFrame = null;

async function deepfaceTick(){
  if (!dfRunning){ return; }
  if (vision.isRunning()){
    const blob = await vision.captureFaceCrop(CONFIG.EMOTION_CROP_PX);
    if (blob){
      if (dfStatus === 'warming' || dfStatus === 'off') dfStatus = 'measuring';
      const res = await api.scoreEmotionFrame(blob);
      if (!dfRunning) return;   // toggled off mid-request
      if (res && res.available){ dfStatus = 'live'; dfDom = res.dominant; dfScores = res.scores; }
      else { dfStatus = 'unavailable'; }
      paintPanel(lastFrame);    // reflect the new DeepFace reading immediately
    }
  }
  // Back off when there's nothing to score (camera not running) or the server has
  // emotion off, so we don't upload a face crop every 2s for nothing. Still polls,
  // so it auto-resumes once the camera starts or the server is enabled.
  const idle = !vision.isRunning() || dfStatus === 'unavailable';
  if (dfRunning) dfTimer = setTimeout(deepfaceTick, idle ? 15000 : CONFIG.DEEPFACE_LIVE_MS);
}

function startDeepface(){
  if (dfRunning) return;
  dfRunning = true; dfStatus = 'warming'; dfDom = null; dfScores = null;
  deepfaceTick();
}

function stopDeepface(){
  dfRunning = false;
  if (dfTimer){ clearTimeout(dfTimer); dfTimer = null; }
  dfStatus = 'off'; dfDom = null; dfScores = null;
}

function paintPanel(out){
  const panel = document.getElementById('fa-panel');
  if (!panel) return;
  if (out && out.mode !== 'face'){
    panel.innerHTML = '<div class="phead"><div><h3>Expression Analysis</h3>' +
      '<div class="desc">Switch to <b>Face</b> mode to see blendshapes and emotion.</div></div></div>' +
      '<div class="fa-note">' + (out.mode === 'pose' ? 'Pose' : 'Hand') + ' landmarks: ' + (out ? out.detections : 0) + ' detected.</div>';
    return;
  }
  const bs = (out && out.blendshapes) || {};
  const dom = dominantEmotion(bs);
  const engineLabel = engine === 'deepface' ? 'MediaPipe + DeepFace' : 'MediaPipe · blendshapes';
  panel.innerHTML =
    '<div class="phead"><div><h3>Expression Analysis</h3>' +
      '<div class="desc">' + esc(engineLabel) + ' — 52 face-muscle coefficients, computed live in your browser.</div></div>' +
      '<div class="fa-dom"><div class="e">' + esc(dom.emotion) + '</div><div class="v">' + Math.round(dom.value) + '%</div></div></div>' +
    '<div class="bs-bars">' + bsBars(bs) + '</div>' + dfSection();
}

function setStatus(out){
  const st = document.getElementById('fa-state'); if (st) st.textContent = vision.isRunning() ? 'Detecting' : 'Stopped';
  const fp = document.getElementById('fa-fps'); if (fp) fp.textContent = out ? out.fps : 0;
  const dt = document.getElementById('fa-det'); if (dt) dt.textContent = out ? out.detections : 0;
  const live = document.getElementById('fa-live'); if (live) live.classList.toggle('on', vision.isRunning());
}

function onFrame(out){ lastFrame = out; setStatus(out); paintPanel(out); }

async function startCamera(){
  const btn = document.getElementById('fa-start');
  const canvas = document.getElementById('fa-canvas');
  const ph = document.getElementById('fa-ph');
  if (btn) btn.disabled = true;   // block a double-Start during the multi-second model load
  if (ph) ph.textContent = 'Loading model…';
  try {
    await vision.start(canvas, mode, onFrame);
    if (ph) ph.style.display = 'none';
    setStatus(null);
    if (engine === 'deepface') startDeepface();
  } catch (e){
    if (ph){ ph.style.display = ''; ph.textContent = 'Camera unavailable: ' + (e && e.message ? e.message : e); }
  } finally {
    if (btn) btn.disabled = false;
  }
}

function stopCamera(){
  stopDeepface();
  vision.stop();
  const ph = document.getElementById('fa-ph');
  if (ph){ ph.style.display = ''; ph.textContent = 'Camera stopped. Press Start to resume.'; }
  setStatus(null);
  paintPanel({ mode: mode, detections: 0, blendshapes: null });
}

export function facial(){
  // Stop any camera left running, then re-arm a one-shot teardown for when the
  // user navigates away from this screen.
  vision.stop(); stopDeepface();
  engine = 'mediapipe'; mode = 'face';
  window.addEventListener('hashchange', function leave(){
    if (location.hash.replace(/^#/, '') !== '/facial'){
      vision.stop(); stopDeepface();
      window.removeEventListener('hashchange', leave);
    }
  });

  queueMicrotask(() => {
    const root = document.getElementById('facial-body');
    if (!root) return;
    // wire engine toggle
    root.querySelectorAll('[data-engine]').forEach((b) => b.addEventListener('click', () => {
      engine = b.getAttribute('data-engine');
      root.querySelectorAll('[data-engine]').forEach((x) => x.classList.toggle('on', x === b));
      const note = document.getElementById('fa-engine-note');
      if (note) note.textContent = engine === 'deepface'
        ? 'DeepFace scores a face snapshot on the server every ~2s, shown beside the live MediaPipe reading.'
        : 'MediaPipe runs live in your browser, every frame.';
      if (engine === 'deepface') startDeepface(); else stopDeepface();
      paintPanel({ mode: mode, blendshapes: null });
    }));
    // wire mode radios
    root.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => {
      mode = b.getAttribute('data-mode');
      root.querySelectorAll('[data-mode]').forEach((x) => x.classList.toggle('on', x === b));
      vision.setMode(mode);
      if (!vision.isRunning()) paintPanel({ mode: mode, blendshapes: null });
    }));
    document.getElementById('fa-start').addEventListener('click', startCamera);
    document.getElementById('fa-stop').addEventListener('click', stopCamera);
  });

  return '<div class="screen"><div class="screen-head"><h1>Facial Analysis</h1>' +
    '<span class="muted" style="font-size:12px">live · nothing is saved</span></div>' +
    '<div id="facial-body"><div class="fa-grid">' +
      '<div class="fa-rail">' +
        '<div class="lab">Emotion engine</div>' +
        '<div class="seg"><button data-engine="mediapipe" class="on">MediaPipe</button>' +
          '<button data-engine="deepface">DeepFace</button></div>' +
        '<div class="seg-note" id="fa-engine-note">MediaPipe runs live in your browser, every frame.</div>' +
        '<div class="lab" style="margin-top:16px">Detection mode</div>' +
        '<button class="mode on" data-mode="face"><span class="r"></span> Face landmarks</button>' +
        '<button class="mode" data-mode="pose"><span class="r"></span> Pose landmarks</button>' +
        '<button class="mode" data-mode="hands"><span class="r"></span> Hand landmarks</button>' +
        '<button class="fa-btn start" id="fa-start">Start camera</button>' +
        '<button class="fa-btn stop" id="fa-stop">Stop</button>' +
        '<div class="lab" style="margin-top:16px">Status</div>' +
        '<div class="fa-stat"><span>State</span><b id="fa-state">Stopped</b></div>' +
        '<div class="fa-stat"><span>FPS</span><b id="fa-fps">0</b></div>' +
        '<div class="fa-stat"><span>Detections</span><b id="fa-det">0</b></div>' +
      '</div>' +
      '<div><div class="fa-stage"><div class="fa-live" id="fa-live"><span class="dot"></span> LIVE</div>' +
        '<canvas id="fa-canvas"></canvas>' +
        '<div class="ph" id="fa-ph">Press "Start camera" to begin. Video stays on your device.</div></div>' +
        '<div class="fa-panel" id="fa-panel"></div></div>' +
    '</div></div></div>';
}
