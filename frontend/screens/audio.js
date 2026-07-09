// frontend/screens/audio.js
// Live audio analysis: Delivery metrics from microphone signal only.
// Scores long pauses, pitch variation, and vocal energy — no transcript needed.

const N_BARS         = 64;
const STATS_MS       = 200;
const RMS_FLOOR      = 0.012;
const MIN_PITCH      = 70;
const MAX_PITCH      = 500;
const PITCH_WIN_S    = 15;
const TIMELINE_S     = 60;
const PAUSE_THRESH_S = 1.5;

// Delivery scoring target bands (from project spec)
const T = {
  pauses:   { hi: 2,   failHi: 10  },
  pitchVar: { lo: 25,  failLo: 5   },
  energy:   { lo: 0.02, failLo: 0.002 },
};

// ── Audio / canvas state ──────────────────────────────────────────────────────
let mic = { ctx: null, analyser: null, source: null, stream: null };
let raf = 0;
let statsTimer = null;
let running = false;
let mode = "spectrum";

// Session accumulators
let sessionStart   = 0;
let speakingAccMs  = 0;
let speakingStart  = 0;
let wasSpeaking    = false;
let pitchSamples   = [];
let timelinePts    = [];
let pitchMin = null;
let pitchMax = null;

// Long pause tracking
let silenceStart   = null;
let inLongPause    = false;
let longPauseCount = 0;

function resetSession() {
  sessionStart = 0; speakingAccMs = 0; speakingStart = 0;
  wasSpeaking = false; pitchSamples = []; timelinePts = [];
  pitchMin = null; pitchMax = null;
  silenceStart = null; inLongPause = false; longPauseCount = 0;
  const panel = document.getElementById("au-panel");
  if (panel) delete panel.dataset.inited;
}

// ── Scoring helpers ───────────────────────────────────────────────────────────
function clamp01(v) { return Math.max(0, Math.min(1, v)); }


function scoreLower(val, good, fail) {
  if (val === null || val === undefined) return null;
  if (val <= good) return 100;
  return Math.round(clamp01((fail - val) / (fail - good)) * 100);
}

function scoreHigher(val, good, fail) {
  if (val === null || val === undefined) return null;
  if (val >= good) return 100;
  return Math.round(clamp01((val - fail) / (good - fail)) * 100);
}

function calcPitchStdDev() {
  if (pitchSamples.length < 5) return null;
  const vals = pitchSamples.map((p) => p.hz);
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  const variance = vals.reduce((a, b) => a + (b - mean) * (b - mean), 0) / vals.length;
  return Math.sqrt(variance);
}

function calcDeliveryScore(pauses, pitchSD, rms) {
  const scores = [], weights = [];
  scores.push(scoreLower(pauses, T.pauses.hi, T.pauses.failHi));                                  weights.push(0.15);
  if (pitchSD !== null)    { scores.push(scoreHigher(pitchSD, T.pitchVar.lo, T.pitchVar.failLo)); weights.push(0.20); }
  scores.push(scoreHigher(rms, T.energy.lo, T.energy.failLo));                                   weights.push(0.10);
  const totalW = weights.reduce((a, b) => a + b, 0);
  return Math.round(scores.reduce((a, s, i) => a + s * weights[i], 0) / totalW);
}

// ── Pitch estimation (autocorrelation) ────────────────────────────────────────
function estimatePitch(td, sampleRate) {
  const n = td.length;
  let energy = 0;
  for (let i = 0; i < n; i++) energy += td[i] * td[i];
  const rms = Math.sqrt(energy / n);
  if (rms < RMS_FLOOR) return { rms, pitch: null };
  const minLag = Math.floor(sampleRate / MAX_PITCH);
  const maxLag = Math.floor(sampleRate / MIN_PITCH);
  let bestLag = 0, bestCorr = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let corr = 0;
    for (let i = 0; i + lag < n; i++) corr += td[i] * td[i + lag];
    if (corr > bestCorr) { bestCorr = corr; bestLag = lag; }
  }
  const norm = energy > 0 ? bestCorr / energy : 0;
  const pitch = (bestLag > 0 && norm > 0.25) ? Math.round(sampleRate / bestLag) : null;
  return { rms, pitch };
}

// ── Canvas init ───────────────────────────────────────────────────────────────
function initCanvas(canvas) {
  const dpr = devicePixelRatio || 1;
  canvas.width  = (canvas.offsetWidth  || 640) * dpr;
  canvas.height = (canvas.offsetHeight || 200) * dpr;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#0a0f0c";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
}

// ── Visualizers ───────────────────────────────────────────────────────────────
function drawSpectrum(canvas, analyser) {
  const ctx = canvas.getContext("2d");
  const W = canvas.width, H = canvas.height;
  ctx.fillStyle = "#0a0f0c";
  ctx.fillRect(0, 0, W, H);
  const data = new Uint8Array(analyser.frequencyBinCount);
  analyser.getByteFrequencyData(data);
  const useBins = Math.floor(data.length * 0.67);
  const bpb = Math.max(1, Math.floor(useBins / N_BARS));
  const barW = W / N_BARS;
  for (let i = 0; i < N_BARS; i++) {
    let sum = 0;
    for (let j = 0; j < bpb; j++) sum += data[i * bpb + j];
    const v = (sum / bpb) / 255;
    const h = v * H;
    if (h < 1) continue;
    const grad = ctx.createLinearGradient(0, H, 0, H - h);
    grad.addColorStop(0,   "rgba(45,212,191,.9)");
    grad.addColorStop(0.6, "rgba(74,222,128,.8)");
    grad.addColorStop(1,   v > 0.7 ? "rgba(251,191,36,1)" : "rgba(74,222,128,.5)");
    ctx.fillStyle = grad;
    ctx.fillRect(i * barW + 1, H - h, barW - 2, h);
    if (v > 0.5) {
      ctx.fillStyle = "rgba(255,255,255,.18)";
      ctx.fillRect(i * barW + 1, H - h - 2, barW - 2, 2);
    }
  }
}

function drawWaveform(canvas, analyser) {
  const ctx = canvas.getContext("2d");
  const W = canvas.width, H = canvas.height;
  const dpr = devicePixelRatio || 1;
  ctx.fillStyle = "#0a0f0c";
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = "rgba(255,255,255,.05)";
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(0, H / 2); ctx.lineTo(W, H / 2); ctx.stroke();
  const data = new Uint8Array(analyser.fftSize);
  analyser.getByteTimeDomainData(data);
  ctx.shadowBlur = 12;
  ctx.shadowColor = "#2dd4bf";
  ctx.strokeStyle = "#2dd4bf";
  ctx.lineWidth = 2 * dpr;
  ctx.beginPath();
  const step = W / data.length;
  for (let i = 0; i < data.length; i++) {
    const y = ((data[i] / 128) - 1) * (H / 2.2) + H / 2;
    if (i === 0) ctx.moveTo(0, y); else ctx.lineTo(i * step, y);
  }
  ctx.stroke();
  ctx.shadowBlur = 0;
}

function drawPitchTrack(canvas) {
  const ctx = canvas.getContext("2d");
  const W = canvas.width, H = canvas.height;
  const dpr = devicePixelRatio || 1;
  ctx.fillStyle = "#0a0f0c";
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = "rgba(255,255,255,.06)";
  ctx.lineWidth = 1;
  ctx.font = Math.round(9 * dpr) + "px ui-monospace,monospace";
  ctx.fillStyle = "rgba(255,255,255,.25)";
  [150, 200, 250, 300, 350, 400].forEach((hz) => {
    const y = H - ((hz - MIN_PITCH) / (MAX_PITCH - MIN_PITCH)) * H;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
    ctx.fillText(hz + "Hz", 4 * dpr, y - 3 * dpr);
  });
  const now = Date.now();
  const cutoff = now - PITCH_WIN_S * 1000;
  const recent = pitchSamples.filter((p) => p.t >= cutoff);
  if (recent.length < 2) {
    ctx.fillStyle = "rgba(255,255,255,.22)";
    ctx.font = Math.round(12 * dpr) + "px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("Start speaking to see your pitch track", W / 2, H / 2);
    ctx.textAlign = "left";
    return;
  }
  ctx.shadowBlur = 8;
  ctx.shadowColor = "#4ade80";
  ctx.strokeStyle = "#4ade80";
  ctx.lineWidth = 2 * dpr;
  ctx.beginPath();
  let first = true;
  for (const p of recent) {
    const x = ((p.t - cutoff) / (PITCH_WIN_S * 1000)) * W;
    const y = H - ((p.hz - MIN_PITCH) / (MAX_PITCH - MIN_PITCH)) * H;
    if (first) { ctx.moveTo(x, y); first = false; } else ctx.lineTo(x, y);
  }
  ctx.stroke();
  ctx.shadowBlur = 0;
  const last = recent[recent.length - 1];
  const cx = ((last.t - cutoff) / (PITCH_WIN_S * 1000)) * W;
  const cy = H - ((last.hz - MIN_PITCH) / (MAX_PITCH - MIN_PITCH)) * H;
  ctx.shadowBlur = 14; ctx.shadowColor = "#4ade80";
  ctx.fillStyle = "#fff";
  ctx.beginPath();
  ctx.arc(cx, Math.max(6, Math.min(H - 6, cy)), 5 * dpr, 0, Math.PI * 2);
  ctx.fill();
  ctx.shadowBlur = 0;
}

// ── Speaking timeline ─────────────────────────────────────────────────────────
function redrawTimeline() {
  const canvas = document.getElementById("au-timeline");
  if (!canvas) return;
  const dpr = devicePixelRatio || 1;
  if (!canvas._init) {
    canvas.width  = (canvas.offsetWidth  || 600) * dpr;
    canvas.height = (canvas.offsetHeight || 22)  * dpr;
    canvas._init = true;
  }
  const ctx = canvas.getContext("2d");
  const W = canvas.width, H = canvas.height;
  ctx.fillStyle = "rgba(255,255,255,.04)";
  ctx.fillRect(0, 0, W, H);
  const now = Date.now();
  const cutoff = now - TIMELINE_S * 1000;
  for (let i = 1; i < timelinePts.length; i++) {
    const a = timelinePts[i - 1], b = timelinePts[i];
    if (!a.speaking) continue;
    const x1 = Math.max(0, ((a.t - cutoff) / (TIMELINE_S * 1000)) * W);
    const x2 = Math.max(0, ((b.t - cutoff) / (TIMELINE_S * 1000)) * W);
    ctx.fillStyle = "rgba(45,212,191,.75)";
    ctx.fillRect(x1, 0, x2 - x1, H);
  }
  ctx.fillStyle = "rgba(255,255,255,.35)";
  ctx.fillRect(W - 2 * dpr, 0, 2 * dpr, H);
}

// ── Delivery panel ────────────────────────────────────────────────────────────
// ── Panel rendering helpers ───────────────────────────────────────────────────
// Build a row shell once (structure only); patchRow() updates values each tick.
function dgRowShell(prefix, label, staticTarget) {
  return (
    '<div class="dg-row">' +
    '<span class="dg-name">' + label + '</span>' +
    '<span class="dg-val" id="' + prefix + '-v">—</span>' +
    '<span class="dg-track"><span class="dg-fill" id="' + prefix + '-f" style="width:0%;background:rgba(255,255,255,.1)"></span></span>' +
    '<span class="dg-badge dg-na" id="' + prefix + '-b">—</span>' +
    '<span class="dg-target" id="' + prefix + '-t">' + staticTarget + '</span>' +
    '</div>'
  );
}

function patchRow(prefix, valHtml, score) {
  const v = document.getElementById(prefix + "-v");
  const f = document.getElementById(prefix + "-f");
  const b = document.getElementById(prefix + "-b");
  if (v) v.innerHTML = valHtml;
  if (f) {
    const w   = score !== null ? Math.max(2, Math.min(100, score)) : 0;
    const col = score === null ? "rgba(255,255,255,.1)"
      : score >= 70 ? "#4ade80" : score >= 40 ? "#fbbf24" : "#fb7185";
    f.style.width      = w + "%";
    f.style.background = col;
  }
  if (b) {
    if (score === null)   { b.innerHTML = "—"; b.className = "dg-badge dg-na"; }
    else if (score >= 70) { b.textContent = "Good"; b.className = "dg-badge dg-good"; }
    else if (score >= 40) { b.textContent = "OK";   b.className = "dg-badge dg-ok"; }
    else                  { b.textContent = "Low";  b.className = "dg-badge dg-low"; }
  }
}

function paintPanel(s) {
  const panel = document.getElementById("au-panel");
  if (!panel) return;

  const pitchSD    = calcPitchStdDev();
  const pauseS  = scoreLower(s.longPauseCount, T.pauses.hi, T.pauses.failHi);
  const pitchS  = scoreHigher(pitchSD, T.pitchVar.lo, T.pitchVar.failLo);
  const energyS = scoreHigher(s.rms, T.energy.lo, T.energy.failLo);
  const ds      = calcDeliveryScore(s.longPauseCount, pitchSD, s.rms);

  const bandCls   = ds >= 70 ? "dg-good" : ds >= 50 ? "dg-ok" : "dg-low";
  const bandLabel = ds >= 70 ? "Strong"  : ds >= 50 ? "Fair"  : "Low";

  const pitchDisp  = pitchSD !== null ? Math.round(pitchSD) + " Hz" : "—";
  const energyDisp = s.rms.toFixed(3);
  const pauseDisp  = s.longPauseCount + (s.longPauseCount === 1 ? " pause" : " pauses");

  // Build HTML structure once per session; subsequent calls only patch values.
  if (!panel.dataset.inited) {
    panel.dataset.inited = "1";
    panel.innerHTML =
      '<div class="dg-header">' +
        '<div>' +
          '<b>Delivery score</b>' +
          '<span class="dg-note">voice delivery \xb7 acoustic analysis</span>' +
          '<span class="dg-scope">Pace &amp; fillers scored in full camera session</span>' +
        '</div>' +
        '<div class="dg-score">' +
          '<span class="dg-score-n" id="au-p-sn"></span>' +
          '<span class="dg-score-l" id="au-p-sl"></span>' +
        '</div>' +
      '</div>' +
      '<div class="dg-rows">' +
        dgRowShell("au-pr-pause",  "Long pauses", "≤2 pauses") +
        dgRowShell("au-pr-pitch",  "Pitch range", "≥25 Hz std dev") +
        dgRowShell("au-pr-energy", "Energy",      "≥0.02 RMS") +
      '</div>' +
      '<div class="au-panel-stats">' +
        '<div class="au-ps"><span>Speaking</span><b id="au-p-spk">—</b></div>' +
        '<div class="au-ps"><span>Avg pitch</span><b id="au-p-avg">—</b></div>' +
        '<div class="au-ps"><span>Elapsed</span><b id="au-elapsed-p">—</b></div>' +
      '</div>';
  }

  const snEl = document.getElementById("au-p-sn");
  if (snEl) { snEl.textContent = ds; snEl.className = "dg-score-n " + bandCls; }
  const slEl = document.getElementById("au-p-sl");
  if (slEl) { slEl.textContent = bandLabel; slEl.className = "dg-score-l " + bandCls; }

  patchRow("au-pr-pause",  pauseDisp,  pauseS);
  patchRow("au-pr-pitch",  pitchDisp,  pitchS);
  patchRow("au-pr-energy", energyDisp, energyS);

  const spkEl = document.getElementById("au-p-spk");
  if (spkEl) spkEl.textContent = s.speakingPct + "%";
  const avgEl = document.getElementById("au-p-avg");
  if (avgEl) avgEl.textContent = s.avgPitch ? s.avgPitch + " Hz" : "—";
}

// ── Stats tick ────────────────────────────────────────────────────────────────
function updateStats() {
  if (!running || !mic.analyser) return;
  const td = new Float32Array(mic.analyser.fftSize);
  mic.analyser.getFloatTimeDomainData(td);
  const { rms, pitch } = estimatePitch(td, mic.ctx.sampleRate);
  const speaking = rms > RMS_FLOOR;
  const now = Date.now();

  // Speaking time + long pause tracking
  const wasS = wasSpeaking;
  wasSpeaking = speaking;
  if (speaking && !wasS) {
    speakingStart = now;
    silenceStart  = null;
    inLongPause   = false;
  } else if (!speaking && wasS) {
    speakingAccMs += (now - speakingStart);
    speakingStart  = 0;
    silenceStart   = now;
    inLongPause    = false;
  }
  if (!speaking && silenceStart) {
    if ((now - silenceStart) / 1000 >= PAUSE_THRESH_S && !inLongPause) {
      longPauseCount++;
      inLongPause = true;
    }
  }

  // Pitch samples
  if (pitch) {
    pitchSamples.push({ t: now, hz: pitch });
    const cut = now - PITCH_WIN_S * 1000;
    pitchSamples = pitchSamples.filter((p) => p.t >= cut);
    if (pitchMin === null || pitch < pitchMin) pitchMin = pitch;
    if (pitchMax === null || pitch > pitchMax) pitchMax = pitch;
  }

  // Timeline
  timelinePts.push({ t: now, speaking });
  timelinePts = timelinePts.filter((p) => p.t >= now - TIMELINE_S * 1000);

  const totalMs     = sessionStart ? (now - sessionStart) : 1;
  const spMs        = speakingAccMs + (speaking && speakingStart ? (now - speakingStart) : 0);
  const speakingPct = Math.round((spMs / totalMs) * 100);
  const avgPitch    = pitchSamples.length
    ? Math.round(pitchSamples.reduce((a, b) => a + b.hz, 0) / pitchSamples.length)
    : null;

  paintPanel({ rms, speaking, speakingPct, avgPitch, longPauseCount });

  const sec     = Math.floor(totalMs / 1000);
  const timeStr = sec < 60 ? sec + "s" : Math.floor(sec / 60) + "m " + (sec % 60) + "s";
  const el  = document.getElementById("au-elapsed");   if (el)  el.textContent  = timeStr;
  const ep  = document.getElementById("au-elapsed-p"); if (ep)  ep.textContent  = timeStr;
  const vad = document.getElementById("au-vad");       if (vad) vad.textContent = speaking ? "Speaking" : "Silence";
  const lv  = document.getElementById("au-live");      if (lv)  lv.classList.toggle("on", speaking);

  redrawTimeline();
}

// ── Render loop ───────────────────────────────────────────────────────────────
function startLoop() {
  const canvas = document.getElementById("au-canvas");
  if (!canvas || !mic.analyser) return;
  const tick = () => {
    if (!running) return;
    if (mode === "spectrum")      drawSpectrum(canvas, mic.analyser);
    else if (mode === "waveform") drawWaveform(canvas, mic.analyser);
    else                          drawPitchTrack(canvas);
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
}

// ── Mode switcher ─────────────────────────────────────────────────────────────
function setMode(m) {
  mode = m;
  document.querySelectorAll("[data-au-mode]").forEach((b) => {
    b.classList.toggle("on", b.dataset.auMode === m);
  });
  const canvas = document.getElementById("au-canvas");
  if (canvas) initCanvas(canvas);
}

// ── Button state ──────────────────────────────────────────────────────────────
function setButtonState(started) {
  const s = document.getElementById("au-start");
  const t = document.getElementById("au-stop");
  if (s) s.disabled =  started;
  if (t) t.disabled = !started;
}

// ── Mic start / stop ──────────────────────────────────────────────────────────
async function startMic() {
  if (running) return;
  const btnStart = document.getElementById("au-start");
  if (btnStart) btnStart.disabled = true;
  const ph = document.getElementById("au-ph");
  if (ph) ph.textContent = "Requesting microphone…";
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    mic.stream   = stream;
    mic.ctx      = new (window.AudioContext || window.webkitAudioContext)();
    mic.analyser = mic.ctx.createAnalyser();
    mic.analyser.fftSize = 2048;
    mic.analyser.smoothingTimeConstant = 0.8;
    mic.source   = mic.ctx.createMediaStreamSource(stream);
    mic.source.connect(mic.analyser);
    running = true;
    resetSession();
    sessionStart = Date.now();

    if (ph) ph.style.display = "none";
    const st = document.getElementById("au-state"); if (st) st.textContent = "Running";
    const rt = document.getElementById("au-rate");  if (rt) rt.textContent = mic.ctx.sampleRate + " Hz";

    const canvas = document.getElementById("au-canvas");
    if (canvas) initCanvas(canvas);
    const tl = document.getElementById("au-timeline");
    if (tl) tl._init = false;
    startLoop();
    statsTimer = setInterval(updateStats, STATS_MS);
    setButtonState(true);
  } catch (e) {
    if (ph) { ph.style.display = ""; ph.textContent = "Microphone unavailable: " + (e && e.message || e); }
    if (btnStart) btnStart.disabled = false;
  }
}

function stopMic() {
  running = false;
  cancelAnimationFrame(raf); raf = 0;
  clearInterval(statsTimer); statsTimer = null;
  if (mic.source) try { mic.source.disconnect(); } catch (_) {}
  if (mic.ctx)    mic.ctx.close().catch(() => {});
  if (mic.stream) mic.stream.getTracks().forEach((t) => t.stop());
  mic = { ctx: null, analyser: null, source: null, stream: null };

  const ph = document.getElementById("au-ph");
  if (ph) { ph.style.display = ""; ph.textContent = "Microphone stopped. Press Start to resume."; }
  ["au-state", "au-rate", "au-elapsed", "au-vad"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.textContent = id === "au-state" ? "Stopped" : "—";
  });
  const lv = document.getElementById("au-live");
  if (lv) lv.classList.remove("on");
  const canvas = document.getElementById("au-canvas");
  if (canvas) {
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#0a0f0c";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  const panel = document.getElementById("au-panel");
  if (panel) panel.innerHTML = "<div class=\"fa-note\">Start the microphone to see live delivery analysis.</div>";
  setButtonState(false);
}

// ── Screen export ─────────────────────────────────────────────────────────────
export function audio() {
  stopMic();
  mode = "spectrum";
  window.addEventListener("hashchange", function leave() {
    if (location.hash.replace(/^#/, "") !== "/audio") {
      stopMic();
      window.removeEventListener("hashchange", leave);
    }
  });

  queueMicrotask(() => {
    document.getElementById("au-start").addEventListener("click", startMic);
    document.getElementById("au-stop").addEventListener("click",  stopMic);
    document.querySelectorAll("[data-au-mode]").forEach((btn) => {
      btn.addEventListener("click", () => setMode(btn.dataset.auMode));
    });
    const canvas = document.getElementById("au-canvas");
    if (canvas) initCanvas(canvas);
  });

  return (
    "<div class=\"screen\">" +
    "<div class=\"screen-head\"><h1>Audio Analysis</h1>" +
    "<span class=\"muted\" style=\"font-size:12px\">live &middot; computed in your browser &middot; nothing sent to our server</span></div>" +

    "<div class=\"fa-grid\">" +

    "<div class=\"fa-rail\">" +
      "<div class=\"lab\">Visualizer</div>" +
      "<div class=\"ni-seg au-mode-seg\">" +
        "<button class=\"on\" data-au-mode=\"spectrum\">Spectrum</button>" +
        "<button data-au-mode=\"waveform\">Waveform</button>" +
        "<button data-au-mode=\"pitch\">Pitch</button>" +
      "</div>" +
      "<button class=\"fa-btn start\" id=\"au-start\">Start microphone</button>" +
      "<button class=\"fa-btn stop\"  id=\"au-stop\" disabled>Stop</button>" +
      "<div class=\"lab\" style=\"margin-top:16px\">Status</div>" +
      "<div class=\"fa-stat\"><span>State</span><b id=\"au-state\">Stopped</b></div>" +
      "<div class=\"fa-stat\"><span>Sample rate</span><b id=\"au-rate\">—</b></div>" +
      "<div class=\"fa-stat\"><span>Elapsed</span><b id=\"au-elapsed\">—</b></div>" +
      "<div class=\"fa-stat\"><span>Voice activity</span><b id=\"au-vad\">—</b></div>" +
    "</div>" +

    "<div>" +
      "<div class=\"fa-stage\" style=\"aspect-ratio:3/1\">" +
        "<div class=\"fa-live\" id=\"au-live\"><span class=\"dot\"></span> SPEAKING</div>" +
        "<canvas id=\"au-canvas\" style=\"transform:none;width:100%;height:100%\"></canvas>" +
        "<div class=\"ph\" id=\"au-ph\">Press &ldquo;Start microphone&rdquo; to begin. Audio stays in your browser.</div>" +
      "</div>" +

      "<div class=\"au-tl-wrap\">" +
        "<span class=\"au-tl-label\">Speaking timeline &mdash; last 60s</span>" +
        "<canvas id=\"au-timeline\"></canvas>" +
      "</div>" +

      "<div class=\"fa-panel\" id=\"au-panel\">" +
        "<div class=\"fa-note\">Start the microphone to see live delivery analysis.</div>" +
      "</div>" +

    "</div>" +
    "</div>" +
    "</div>"
  );
}
