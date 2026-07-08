// frontend/screens/audio.js
// Live audio analysis tool — microphone spectrum visualiser + acoustic stats.
// Mirrors the /facial screen structure; reuses all fa-* CSS classes.

const N_BARS    = 64;
const STATS_MS  = 200;
const RMS_FLOOR = 0.012;  // below this RMS = silence
const MIN_PITCH = 70;
const MAX_PITCH = 500;

let mic = { ctx: null, analyser: null, source: null, stream: null };
let raf = 0;
let statsTimer = null;
let running    = false;

// Session accumulators (reset each Start)
let sessionStart  = 0;
let speakingAccMs = 0;
let speakingStart = 0;
let wasSpeaking   = false;
let pitchHistory  = [];

function resetSession(){
  sessionStart = 0; speakingAccMs = 0; speakingStart = 0;
  wasSpeaking = false; pitchHistory = [];
}

// ── pitch via autocorrelation (mirrors acoustic-features.js) ─────────────────
function estimatePitch(timeDomain, sampleRate){
  const n = timeDomain.length;
  let energy = 0;
  for (let i = 0; i < n; i++) energy += timeDomain[i] * timeDomain[i];
  const rms = Math.sqrt(energy / n);
  if (rms < RMS_FLOOR) return { rms, pitch: null };

  const minLag = Math.floor(sampleRate / MAX_PITCH);
  const maxLag = Math.floor(sampleRate / MIN_PITCH);
  let bestLag = 0, bestCorr = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag++){
    let corr = 0;
    for (let i = 0; i + lag < n; i++) corr += timeDomain[i] * timeDomain[i + lag];
    if (corr > bestCorr){ bestCorr = corr; bestLag = lag; }
  }
  const norm = energy > 0 ? bestCorr / energy : 0;
  const pitch = (bestLag > 0 && norm > 0.25) ? Math.round(sampleRate / bestLag) : null;
  return { rms, pitch };
}

// ── canvas helpers ────────────────────────────────────────────────────────────
function clearCanvas(canvas){
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#0e0e0e';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
}

function initCanvas(canvas){
  canvas.width  = (canvas.offsetWidth  || 640) * (devicePixelRatio || 1);
  canvas.height = (canvas.offsetHeight || 160) * (devicePixelRatio || 1);
  clearCanvas(canvas);
}

function drawBars(canvas, analyser){
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  ctx.fillStyle = '#0e0e0e';
  ctx.fillRect(0, 0, W, H);
  const data = new Uint8Array(analyser.frequencyBinCount);
  analyser.getByteFrequencyData(data);
  // Lower two-thirds of bins covers voice + speech range
  const useBins = Math.floor(data.length * 0.67);
  const bpb  = Math.max(1, Math.floor(useBins / N_BARS));
  const barW = W / N_BARS;
  for (let i = 0; i < N_BARS; i++){
    let sum = 0;
    for (let j = 0; j < bpb; j++) sum += data[i * bpb + j];
    const v = (sum / bpb) / 255;
    const h = v * H;
    ctx.fillStyle = v > 0.65 ? '#22c55e' : v > 0.3 ? 'rgba(34,197,94,.75)' : 'rgba(34,197,94,.35)';
    ctx.fillRect(i * barW + 1, H - h, barW - 2, Math.max(1, h));
  }
}

// ── stats panel ───────────────────────────────────────────────────────────────
function paintPanel(s){
  const panel = document.getElementById('au-panel');
  if (!panel) return;

  const vol        = Math.round(Math.min(100, s.rms * 500));
  const pitchPct   = s.pitch    ? Math.round(((s.pitch    - MIN_PITCH) / (MAX_PITCH - MIN_PITCH)) * 100) : 0;
  const avgPitchPct = s.avgPitch ? Math.round(((s.avgPitch - MIN_PITCH) / (MAX_PITCH - MIN_PITCH)) * 100) : 0;

  // All values are Math.round integers — no user or external input.
  const safeVol   = Number(vol);
  const safePitch = s.pitch    ? Number(s.pitch)    : null;
  const safeAvg   = s.avgPitch ? Number(s.avgPitch) : null;
  const safePct   = Number(s.speakingPct);

  function row(label, pct, value){
    const w = Math.max(0, Math.min(100, pct));
    return '<div class="bs-row"><span class="nm">' + label + '</span>' +
      '<span class="track"><span class="fill" style="width:' + w + '%"></span></span>' +
      '<span class="pct">' + value + '</span></div>';
  }

  panel.innerHTML =
    '<div class="phead"><div><h3>Acoustic Analysis</h3>' +
      '<div class="desc">Computed live in your browser via Web Audio API — nothing is sent to the server.</div></div>' +
      '<div class="fa-dom">' +
        '<div class="e">' + (s.speaking ? 'Speaking' : 'Silent') + '</div>' +
        '<div class="v">' + (safePitch ? safePitch + ' Hz' : '') + '</div>' +
      '</div></div>' +
    '<div class="bs-bars">' +
      row('Volume',        safeVol,      safeVol + '%') +
      row('Pitch (live)',  pitchPct,     safePitch ? safePitch + ' Hz' : '—') +
      row('Avg pitch',     avgPitchPct,  safeAvg   ? safeAvg   + ' Hz' : '—') +
      row('Speaking time', safePct,      safePct   + '%') +
    '</div>';
}

// ── stats tick ────────────────────────────────────────────────────────────────
function updateStats(){
  if (!running || !mic.analyser) return;
  const td = new Float32Array(mic.analyser.fftSize);
  mic.analyser.getFloatTimeDomainData(td);
  const sr = mic.ctx.sampleRate;
  const { rms, pitch } = estimatePitch(td, sr);
  const speaking = rms > RMS_FLOOR;

  const now = Date.now();
  if (speaking  && !wasSpeaking) speakingStart = now;
  if (!speaking && wasSpeaking)  speakingAccMs += (now - speakingStart);
  wasSpeaking = speaking;

  // Rolling 20s pitch history for the average
  if (pitch){ pitchHistory.push(pitch); if (pitchHistory.length > 100) pitchHistory.shift(); }

  const totalMs    = sessionStart ? (now - sessionStart) : 1;
  const spMs       = speakingAccMs + (speaking && speakingStart ? (now - speakingStart) : 0);
  const speakingPct = Math.round((spMs / totalMs) * 100);
  const avgPitch    = pitchHistory.length
    ? Math.round(pitchHistory.reduce((a, b) => a + b, 0) / pitchHistory.length)
    : null;

  paintPanel({ rms, pitch, speaking, speakingPct, avgPitch });

  const vad  = document.getElementById('au-vad');  if (vad)  vad.textContent  = speaking ? 'Speaking' : 'Silence';
  const live = document.getElementById('au-live'); if (live) live.classList.toggle('on', speaking);

  const elapsed = document.getElementById('au-elapsed');
  if (elapsed){
    const sec = Math.floor(totalMs / 1000);
    elapsed.textContent = sec < 60 ? sec + 's' : Math.floor(sec / 60) + 'm ' + (sec % 60) + 's';
  }
}

// ── button state ──────────────────────────────────────────────────────────────
function setButtonState(started){
  const s = document.getElementById('au-start');
  const t = document.getElementById('au-stop');
  if (s) s.disabled = started;
  if (t) t.disabled = !started;
}

// ── mic start / stop ──────────────────────────────────────────────────────────
async function startMic(){
  if (running) return;
  const btnStart = document.getElementById('au-start');
  if (btnStart) btnStart.disabled = true;   // block double-click while requesting
  const ph = document.getElementById('au-ph');
  if (ph) ph.textContent = 'Requesting microphone…';
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    mic.stream   = stream;
    mic.ctx      = new (window.AudioContext || window.webkitAudioContext)();
    mic.analyser = mic.ctx.createAnalyser();
    mic.analyser.fftSize = 2048;
    mic.analyser.smoothingTimeConstant = 0.8;
    mic.source = mic.ctx.createMediaStreamSource(stream);
    mic.source.connect(mic.analyser);
    running = true;
    resetSession();
    sessionStart = Date.now();

    if (ph) ph.style.display = 'none';
    const st = document.getElementById('au-state'); if (st) st.textContent = 'Running';
    const rt = document.getElementById('au-rate');  if (rt) rt.textContent = mic.ctx.sampleRate + ' Hz';

    const canvas = document.getElementById('au-canvas');
    if (canvas){
      initCanvas(canvas);
      const loop = () => { drawBars(canvas, mic.analyser); if (running) raf = requestAnimationFrame(loop); };
      raf = requestAnimationFrame(loop);
    }
    statsTimer = setInterval(updateStats, STATS_MS);
    setButtonState(true);
  } catch (e){
    if (ph){ ph.style.display = ''; ph.textContent = 'Microphone unavailable: ' + (e && e.message || e); }
    if (btnStart) btnStart.disabled = false;
  }
}

function stopMic(){
  running = false;
  cancelAnimationFrame(raf); raf = 0;
  clearInterval(statsTimer); statsTimer = null;
  if (mic.source) try { mic.source.disconnect(); } catch (_){}
  if (mic.ctx)    mic.ctx.close().catch(() => {});
  if (mic.stream) mic.stream.getTracks().forEach((t) => t.stop());
  mic = { ctx: null, analyser: null, source: null, stream: null };

  const ph = document.getElementById('au-ph');
  if (ph){ ph.style.display = ''; ph.textContent = 'Microphone stopped. Press Start to resume.'; }
  const st = document.getElementById('au-state');   if (st) st.textContent = 'Stopped';
  const rt = document.getElementById('au-rate');    if (rt) rt.textContent = '—';
  const el = document.getElementById('au-elapsed'); if (el) el.textContent = '—';
  const vd = document.getElementById('au-vad');     if (vd) vd.textContent = '—';
  const lv = document.getElementById('au-live');    if (lv) lv.classList.remove('on');

  const canvas = document.getElementById('au-canvas');
  if (canvas) clearCanvas(canvas);
  const panel = document.getElementById('au-panel');
  if (panel) panel.innerHTML = '<div class="fa-note">Start the microphone to see live acoustic analysis.</div>';

  setButtonState(false);
}

// ── screen export ─────────────────────────────────────────────────────────────
export function audio(){
  stopMic();   // clean up any leftover session from a previous visit
  window.addEventListener('hashchange', function leave(){
    if (location.hash.replace(/^#/, '') !== '/audio'){
      stopMic();
      window.removeEventListener('hashchange', leave);
    }
  });

  queueMicrotask(() => {
    document.getElementById('au-start').addEventListener('click', startMic);
    document.getElementById('au-stop').addEventListener('click', stopMic);
    // Initialise canvas with dark background so it doesn't appear blank
    const canvas = document.getElementById('au-canvas');
    if (canvas) initCanvas(canvas);
  });

  return '<div class="screen"><div class="screen-head"><h1>Audio Analysis</h1>' +
    '<span class="muted" style="font-size:12px">live · nothing is sent to the server</span></div>' +
    '<div id="audio-body"><div class="fa-grid">' +

    '<div class="fa-rail">' +
      '<div class="lab">Microphone</div>' +
      '<div class="seg-note">Web Audio API · computed entirely in your browser</div>' +
      '<button class="fa-btn start" id="au-start">Start microphone</button>' +
      '<button class="fa-btn stop"  id="au-stop" disabled>Stop</button>' +
      '<div class="lab" style="margin-top:16px">Status</div>' +
      '<div class="fa-stat"><span>State</span><b id="au-state">Stopped</b></div>' +
      '<div class="fa-stat"><span>Sample rate</span><b id="au-rate">—</b></div>' +
      '<div class="fa-stat"><span>Elapsed</span><b id="au-elapsed">—</b></div>' +
      '<div class="fa-stat"><span>Voice activity</span><b id="au-vad">—</b></div>' +
    '</div>' +

    '<div>' +
      '<div class="fa-stage" style="aspect-ratio:3/1">' +
        '<div class="fa-live" id="au-live"><span class="dot"></span> SPEAKING</div>' +
        '<canvas id="au-canvas" style="transform:none"></canvas>' +
        '<div class="ph" id="au-ph">Press “Start microphone” to begin. Audio stays in your browser.</div>' +
      '</div>' +
      '<div class="fa-panel" id="au-panel">' +
        '<div class="fa-note">Start the microphone to see live acoustic analysis.</div>' +
      '</div>' +
    '</div>' +

    '</div></div></div>';
}
