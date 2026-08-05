import * as vision from '../vision.js';
import { dominantEmotion, EMOTION_CLASSES } from '../emotion.js';
import { esc } from '../util.js';
import { api } from '../api.js';
import { CONFIG } from '../config.js';
import { t } from '../i18n.js';
import { createFaceEffects } from '../face-effects.js';

// Curated blendshapes shown as secondary bars, with friendly labels.
const DISPLAY = [
  ['mouthSmileLeft', 'Smile L'], ['mouthSmileRight', 'Smile R'],
  ['eyeBlinkLeft', 'Blink L'], ['eyeBlinkRight', 'Blink R'],
  ['browInnerUp', 'Brow Inner Up'], ['jawOpen', 'Jaw Open'],
  ['browDownLeft', 'Brow Down L'], ['browDownRight', 'Brow Down R'],
  ['mouthFrownLeft', 'Frown L'], ['mouthFrownRight', 'Frown R'],
  ['eyeWideLeft', 'Eye Wide L'], ['eyeWideRight', 'Eye Wide R'],
];

let engine = 'mediapipe';   // 'mediapipe' (live blendshapes) | 'deepface' (server emotion)
let mode = 'face';          // 'face' | 'pose' | 'hands'
let effects = null;        // active reaction-effects overlay, or null
let effectsOn = true;      // reaction effects default ON
let panelKind = '';        // skeleton currently mounted in #fa-panel

// Live server emotion track (~every EMOTION_LIVE_MS). Runs only while engine==='deepface'.
let dfRunning = false, dfTimer = null;
let dfStatus = 'off';   // 'off' | 'warming' | 'measuring' | 'live' | 'unavailable'
let dfDom = null, dfScores = null;

function barRow(id, label, cls){
  return '<div class="bs-row ' + (cls || '') + '" data-bar="' + esc(id) + '">' +
    '<span class="nm">' + esc(label) + '</span>' +
    '<span class="track"><span class="fill" style="width:0%"></span></span>' +
    '<span class="pct">0%</span></div>';
}

function emotionRows(classes){
  return classes.map((c) => barRow(c, c, 'emo-' + c)).join('');
}

function blendshapeRows(){
  return DISPLAY.map((d) => barRow(d[0], d[1], 'bs-muscle')).join('');
}

// Patch existing bar rows in place so CSS width transitions can run.
function setBars(root, values, leadId){
  if (!root) return;
  root.querySelectorAll('[data-bar]').forEach((row) => {
    const id = row.getAttribute('data-bar');
    const raw = values[id];
    const v = Math.max(0, Math.min(100, Math.round(raw == null ? 0 : raw)));
    const fill = row.querySelector('.fill');
    const pct = row.querySelector('.pct');
    if (fill) fill.style.width = v + '%';
    if (pct) pct.textContent = v + '%';
    row.classList.toggle('lead', !!leadId && id === leadId);
  });
}

function ensurePanel(kind, html){
  const panel = document.getElementById('fa-panel');
  if (!panel) return null;
  if (panelKind !== kind){
    panel.innerHTML = html;
    panelKind = kind;
  }
  return panel;
}

function resetPanel(){
  panelKind = '';
  const panel = document.getElementById('fa-panel');
  if (panel) panel.innerHTML = '';
}

function mpSkeleton(){
  return '<div class="phead"><div><h3>' + esc(t('facial.exprTitle')) + '</h3>' +
    '<div class="desc">' + esc(t('facial.exprDescMp')) + '</div></div>' +
    '<div class="fa-dom"><div class="e" data-dom-e>—</div><div class="v" data-dom-v></div></div></div>' +
    '<div class="fa-sec-label">' + esc(t('facial.emotions')) + '</div>' +
    '<div class="bs-bars em-bars">' + emotionRows(EMOTION_CLASSES) + '</div>' +
    '<div class="fa-sec-label">' + esc(t('facial.muscles')) + '</div>' +
    '<div class="bs-bars bs-muscle-bars">' + blendshapeRows() + '</div>';
}

function dfSkeleton(){
  const every = Math.round(CONFIG.EMOTION_LIVE_MS / 1000);
  return '<div class="phead"><div><h3>' + esc(t('facial.exprTitle')) + '</h3>' +
    '<div class="desc">' + esc(t('facial.exprDescDf', { s: every })) + '</div></div>' +
    '<div class="fa-dom"><div class="e" data-dom-e>—</div><div class="v" data-dom-v></div></div></div>' +
    '<div class="fa-df-body"></div>';
}

function paintDfBody(panel){
  const body = panel.querySelector('.fa-df-body');
  if (!body) return;
  if (dfStatus === 'warming'){
    body.innerHTML = '<div class="fa-note">' + esc(t('facial.dfWarming')) + '</div>';
    return;
  }
  if (dfStatus === 'unavailable'){
    body.innerHTML = '<div class="fa-note">' + esc(t('facial.dfOff')) + '</div>';
    return;
  }
  if (dfStatus === 'live' && dfScores){
    if (!body.querySelector('.em-bars')){
      body.innerHTML = '<div class="fa-sec-label">' + esc(t('facial.emotions')) + '</div>' +
        '<div class="bs-bars em-bars">' + emotionRows(EMOTION_CLASSES) + '</div>';
    }
    setBars(body, dfScores, dfDom);
    return;
  }
  body.innerHTML = '<div class="fa-note">' + esc(t('facial.dfMeasuring')) + '</div>';
}

let lastFrame = null;

async function deepfaceTick(){
  if (!dfRunning){ return; }
  if (vision.isRunning()){
    const blob = await vision.captureFaceCrop(CONFIG.EMOTION_LIVE_CROP_PX);
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
  if (dfRunning) dfTimer = setTimeout(deepfaceTick, idle ? 15000 : CONFIG.EMOTION_LIVE_MS);
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
  const panelEl = document.getElementById('fa-panel');
  if (!panelEl) return;

  if (out && out.mode !== 'face'){
    const kind = 'mode-' + out.mode;
    const panel = ensurePanel(kind,
      '<div class="phead"><div><h3>' + esc(t('facial.exprTitle')) + '</h3>' +
        '<div class="desc">' + esc(t('facial.exprSwitchFace')) + '</div></div></div>' +
        '<div class="fa-note" data-mode-note></div>');
    const note = panel && panel.querySelector('[data-mode-note]');
    if (note){
      const label = out.mode === 'pose' ? t('facial.mode.pose') : t('facial.mode.hands');
      note.textContent = t('facial.modeDetections', { mode: label, n: out.detections || 0 });
    }
    return;
  }

  if (engine === 'deepface'){
    const panel = ensurePanel('deepface', dfSkeleton());
    if (!panel) return;
    const e = panel.querySelector('[data-dom-e]');
    const v = panel.querySelector('[data-dom-v]');
    if (e) e.textContent = (dfStatus === 'live' && dfDom) ? dfDom : '—';
    if (v) v.textContent = '';
    paintDfBody(panel);
    return;
  }

  const panel = ensurePanel('mediapipe', mpSkeleton());
  if (!panel) return;
  const bs = (out && out.blendshapes) || {};
  const dom = dominantEmotion(bs);
  const e = panel.querySelector('[data-dom-e]');
  const v = panel.querySelector('[data-dom-v]');
  if (e) e.textContent = dom.emotion;
  if (v) v.textContent = Math.round(dom.value) + '%';

  setBars(panel.querySelector('.em-bars'), dom.scores, dom.emotion);
  const muscle = {};
  for (const d of DISPLAY) muscle[d[0]] = Math.round(Math.max(0, Math.min(1, bs[d[0]] || 0)) * 100);
  setBars(panel.querySelector('.bs-muscle-bars'), muscle, null);
}

function setStatus(out){
  const st = document.getElementById('fa-state'); if (st) st.textContent = vision.isRunning() ? t('facial.detecting') : t('facial.stopped');
  const fp = document.getElementById('fa-fps'); if (fp) fp.textContent = out ? out.fps : 0;
  const dt = document.getElementById('fa-det'); if (dt) dt.textContent = out ? out.detections : 0;
  const live = document.getElementById('fa-live'); if (live) live.classList.toggle('on', vision.isRunning());
}

function onFrame(out){
  lastFrame = out;
  setStatus(out);
  paintPanel(out);
  if (effects && effectsOn){
    effects.feed({ bs: out.blendshapes, gestures: out.gestures, faceLandmarks: out.faceLandmarks, handLandmarks: out.handLandmarks, t: performance.now() });
  }
}

async function startCamera(){
  const btn = document.getElementById('fa-start');
  const canvas = document.getElementById('fa-canvas');
  const ph = document.getElementById('fa-ph');
  if (btn) btn.disabled = true;   // block a double-Start during the multi-second model load
  if (ph) ph.textContent = t('live.loading');
  try {
    await vision.start(canvas, mode, onFrame);
    if (ph) ph.style.display = 'none';
    setStatus(null);
    if (engine === 'deepface') startDeepface();
  } catch (e){
    if (ph){ ph.style.display = ''; ph.textContent = t('live.camUnavail', { m: (e && e.message ? e.message : e) }); }
  } finally {
    if (btn) btn.disabled = false;
  }
}

function stopCamera(){
  stopDeepface();
  vision.stop();
  const ph = document.getElementById('fa-ph');
  if (ph){ ph.style.display = ''; ph.textContent = t('facial.phStopped'); }
  setStatus(null);
  paintPanel({ mode: mode, detections: 0, blendshapes: null });
}

export function facial(){
  // Stop any camera left running, then re-arm a one-shot teardown for when the
  // user navigates away from this screen.
  vision.stop(); stopDeepface(); resetPanel();
  engine = 'mediapipe'; mode = 'face'; effectsOn = true;
  window.addEventListener('hashchange', function leave(){
    if (location.hash.replace(/^#/, '') !== '/facial'){
      vision.stop(); stopDeepface(); vision.setEffects(false);
      if (effects){ effects.destroy(); effects = null; }
      resetPanel();
      window.removeEventListener('hashchange', leave);
    }
  });

  queueMicrotask(() => {
    const root = document.getElementById('facial-body');
    if (!root) return;
    // Reaction effects overlay (default ON).
    const fxLayer = document.getElementById('fa-fx');
    if (fxLayer){
      effects = createFaceEffects(fxLayer);
      effects.setEnabled(effectsOn);
      vision.setEffects(effectsOn);
    }
    root.querySelectorAll('[data-fx]').forEach((b) => b.addEventListener('click', () => {
      effectsOn = b.getAttribute('data-fx') === 'on';
      root.querySelectorAll('[data-fx]').forEach((x) => x.classList.toggle('on', x === b));
      vision.setEffects(effectsOn);
      if (effects) effects.setEnabled(effectsOn);
    }));
    // wire engine toggle
    root.querySelectorAll('[data-engine]').forEach((b) => b.addEventListener('click', () => {
      engine = b.getAttribute('data-engine');
      root.querySelectorAll('[data-engine]').forEach((x) => x.classList.toggle('on', x === b));
      const note = document.getElementById('fa-engine-note');
      if (note) note.textContent = engine === 'deepface'
        ? t('facial.engineNoteDf')
        : t('facial.engineNoteMp');
      if (engine === 'deepface') startDeepface(); else stopDeepface();
      resetPanel();
      paintPanel({ mode: mode, blendshapes: null });
    }));
    // wire mode radios
    root.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => {
      mode = b.getAttribute('data-mode');
      root.querySelectorAll('[data-mode]').forEach((x) => x.classList.toggle('on', x === b));
      vision.setMode(mode);
      if (!vision.isRunning()){ resetPanel(); paintPanel({ mode: mode, blendshapes: null }); }
    }));
    document.getElementById('fa-start').addEventListener('click', startCamera);
    document.getElementById('fa-stop').addEventListener('click', stopCamera);
    paintPanel({ mode: mode, blendshapes: null });
  });

  return '<div class="screen"><div class="screen-head"><h1>' + esc(t('facial.title')) + '</h1>' +
    '<span class="muted" style="font-size:12px">' + esc(t('facial.liveNote')) + '</span></div>' +
    '<div id="facial-body"><div class="fa-grid">' +
      '<div class="fa-rail">' +
        '<div class="lab">' + esc(t('facial.engine')) + '</div>' +
        '<div class="seg"><button data-engine="mediapipe" class="on">MediaPipe</button>' +
          '<button data-engine="deepface">HSEmotion</button></div>' +
        '<div class="seg-note" id="fa-engine-note">' + esc(t('facial.engineNoteMp')) + '</div>' +
        '<div class="lab" style="margin-top:16px">' + esc(t('facial.mode')) + '</div>' +
        '<button class="mode on" data-mode="face"><span class="r"></span> ' + esc(t('facial.mode.face')) + '</button>' +
        '<button class="mode" data-mode="pose"><span class="r"></span> ' + esc(t('facial.mode.pose')) + '</button>' +
        '<button class="mode" data-mode="hands"><span class="r"></span> ' + esc(t('facial.mode.hands')) + '</button>' +
        '<div class="lab" style="margin-top:16px">' + esc(t('facial.fx')) + '</div>' +
        '<div class="seg"><button data-fx="on" class="on">' + esc(t('facial.fxOn')) + '</button><button data-fx="off">' + esc(t('facial.fxOff')) + '</button></div>' +
        '<button class="fa-btn start" id="fa-start">' + esc(t('facial.start')) + '</button>' +
        '<button class="fa-btn stop" id="fa-stop">' + esc(t('facial.stop')) + '</button>' +
        '<div class="lab" style="margin-top:16px">' + esc(t('facial.status')) + '</div>' +
        '<div class="fa-stat"><span>' + esc(t('facial.state')) + '</span><b id="fa-state">' + esc(t('facial.stopped')) + '</b></div>' +
        '<div class="fa-stat"><span>' + esc(t('facial.fps')) + '</span><b id="fa-fps">0</b></div>' +
        '<div class="fa-stat"><span>' + esc(t('facial.detections')) + '</span><b id="fa-det">0</b></div>' +
      '</div>' +
      '<div><div class="fa-stage"><div class="fa-live" id="fa-live"><span class="dot"></span> ' + esc(t('facial.live')) + '</div>' +
        '<canvas id="fa-canvas"></canvas>' +
        '<canvas class="fa-fx" id="fa-fx"></canvas>' +
        '<div class="ph" id="fa-ph">' + esc(t('facial.ph')) + '</div></div>' +
        '<div class="fa-panel" id="fa-panel"></div></div>' +
    '</div></div></div>';
}
