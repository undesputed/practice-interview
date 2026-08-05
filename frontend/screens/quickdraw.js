// frontend/screens/quickdraw.js
// Air-Draw Quick Draw Challenge: draw with your index finger, Claude Vision guesses.
// Uses interview-engine.js for simultaneous face + hand tracking.
import * as engine from '../interview-engine.js';
import { dominantEmotion, emotionScores, EMOTION_CLASSES } from '../emotion.js';
import { t } from '../i18n.js';

// ── constants ────────────────────────────────────────────────────────────────
const ROUND_COUNT  = 5;
const ROUND_SECS   = 30;
const DWELL_MS     = 1200;
const CLICK_COOL   = 2000;
const STROKE_COLOR = '#ffffff';
const STROKE_W     = 8;

// Curated subset of the Google QuickDraw dataset (345 categories).
const PROMPTS = [
  'cat','dog','fish','bird','elephant','rabbit','penguin','lion',
  'house','car','airplane','bicycle','boat','clock','umbrella',
  'apple','pizza','ice cream','sun','tree','flower','star','cloud',
  'guitar','hat','shoe','book','key','banana','cactus',
];

// ── module-level state (reset each quickdraw() call) ────────────────────────
let phase        = 'idle';     // idle|countdown|drawing|guessing|result|final
let rounds       = [];         // [{prompt,guess,score,comment,thumb}]
let currentRound = 0;
let timerVal     = ROUND_SECS;
let timerInterval = null;
let emotionLog   = [];         // [{ts,emotion,value}]
let drawCtx      = null;
let lastPos      = null;       // {x,y} smoothed canvas pixels — current point
let lastMid      = null;       // midpoint between prev and current, for bezier drawing
let smoothPos    = null;       // exponentially smoothed raw position
const SMOOTH     = 0.4;        // EMA weight on old value (0=raw, 1=frozen)
let sessionPrompts = [];

// cursor / dwell state
let cursorEl      = null;
let dwellTarget   = null;
let dwellStart    = 0;
let lastClickTs   = 0;

// pen hysteresis — require 4 consecutive "not-extended" frames before lifting pen
let penDownState = false;
let penUpCount   = 0;
const PEN_UP_FRAMES = 4;

// real-time AI guessing
let guessLoopId      = null;
let isGuessing       = false;
let liveGuessHist    = [];     // [{guess, hit}] most-recent first, shown in stage bar
let hasDrawnThisRound = false; // don't guess on an empty canvas
let guessFailCount   = 0;     // consecutive API failures; stops loop at 3

// voice (Deepgram TTS)
let currentAudio  = null;
let speakGen      = 0;         // cancel in-flight fetches when a newer speak() is issued
const audioCache  = new Map(); // text → Blob — pre-fetched phrases play with zero delay

const byId = (id) => document.getElementById(id);

// ── voice ─────────────────────────────────────────────────────────────────────
function stopAudio() {
  if (currentAudio) { currentAudio.pause(); currentAudio = null; }
  if (window.speechSynthesis) window.speechSynthesis.cancel();
}


function _playBlob(blob, gen, onplay, onended) {
  if (gen !== speakGen) return;
  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);
  currentAudio = audio;
  audio.onplay  = () => { if (onplay) onplay(); };
  audio.onended = () => {
    URL.revokeObjectURL(url);
    if (currentAudio === audio) currentAudio = null;
    if (onended) onended();
  };
  audio.onerror = () => { URL.revokeObjectURL(url); if (onended) onended(); };
  audio.play().catch(() => { URL.revokeObjectURL(url); if (onended) onended(); });
}

function _ttsRequest(text) {
  return fetch('/api/quickdraw/speak', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
}

// Pre-fetch a phrase so it's in audioCache before it's needed (zero-delay playback).
function prefetch(text) {
  if (audioCache.has(text)) return;
  _ttsRequest(text)
    .then(r => r.ok ? r.blob() : null)
    .then(blob => { if (blob) audioCache.set(text, blob); })
    .catch(() => {});
}

// speak(text, { onplay, onended })
// onplay fires when audio actually starts (use to sync visual word with voice).
// onended fires when audio naturally finishes (use to chain the next phrase).
// Both fire immediately in the catch branch so the game still progresses when
// Deepgram is unavailable.
function speak(text, { onplay, onended } = {}) {
  stopAudio();
  const gen = ++speakGen;
  if (audioCache.has(text)) { _playBlob(audioCache.get(text), gen, onplay, onended); return; }
  _ttsRequest(text)
    .then(r => { if (gen !== speakGen) return null; if (!r.ok) throw new Error(); return r.blob(); })
    .then(blob => {
      if (!blob || gen !== speakGen) return;
      audioCache.set(text, blob);
      _playBlob(blob, gen, onplay, onended);
    })
    .catch(() => { if (onplay) onplay(); if (onended) onended(); });
}

// ── Escape untrusted strings before placing them inside innerHTML.
function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ── drawing helpers ──────────────────────────────────────────────────────────
function initDrawCanvas() {
  const c = byId('qd-draw');
  if (!c) return;
  c.width = 1280; c.height = 720;
  drawCtx = c.getContext('2d');
  drawCtx.strokeStyle  = STROKE_COLOR;
  drawCtx.lineWidth    = STROKE_W;
  drawCtx.lineCap      = 'round';
  drawCtx.lineJoin     = 'round';
  drawCtx.shadowColor  = 'rgba(0,0,0,0.85)';
  drawCtx.shadowBlur   = 6;
}

function clearDrawCanvas() {
  if (drawCtx) drawCtx.clearRect(0, 0, 1280, 720);
  lastPos = null; lastMid = null; smoothPos = null;
  hasDrawnThisRound = false;
  guessFailCount = 0;
}

function captureThumb() {
  // Return data URL of the current drawing (black bg + strokes) for the results card.
  const tmp = document.createElement('canvas');
  tmp.width = 320; tmp.height = 180;
  const ctx = tmp.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, 320, 180);
  const src = byId('qd-draw');
  if (src) ctx.drawImage(src, 0, 0, 320, 180);
  return tmp.toDataURL('image/png');
}

function captureBlob() {
  // Return Promise<Blob> of the full-res drawing for Claude Vision.
  return new Promise((resolve) => {
    const tmp = document.createElement('canvas');
    tmp.width = 1280; tmp.height = 720;
    const ctx = tmp.getContext('2d');
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, 1280, 720);
    const src = byId('qd-draw');
    if (src) ctx.drawImage(src, 0, 0, 1280, 720);
    tmp.toBlob(resolve, 'image/png');
  });
}

// ── cursor / dwell ───────────────────────────────────────────────────────────
function resetDwell() {
  dwellTarget = null; dwellStart = 0;
  if (cursorEl) cursorEl.style.setProperty('--dwell', 0);
}

// ── real-time AI guessing ────────────────────────────────────────────────────
function updateLiveGuessUI() {
  const bar = byId('qd-live-guess');
  if (!bar) return;
  if (!liveGuessHist.length) { bar.style.display = 'none'; return; }
  bar.style.display = 'flex';
  const inner = byId('qd-guess-words');
  if (!inner) return;
  // Most recent first; hit = green, older = dimmed
  inner.innerHTML = liveGuessHist.map((g, i) => {
    const cls = g.hit ? 'qd-guess-word hit' : (i === 0 ? 'qd-guess-word cur' : 'qd-guess-word old');
    return '<span class="' + cls + '">' + esc(g.guess) + (g.hit ? ' ✓' : '?') + '</span>';
  }).join('<span class="qd-guess-sep">·</span>');
}

function hideLiveGuess() {
  const bar = byId('qd-live-guess');
  if (bar) bar.style.display = 'none';
  liveGuessHist = [];
}

async function doLiveGuess() {
  if (isGuessing || phase !== 'drawing' || !hasDrawnThisRound) return;
  isGuessing = true;
  try {
    const blob = await captureBlob();
    if (!blob) { isGuessing = false; return; }
    const prompt = sessionPrompts[currentRound] || '?';
    const fd = new FormData();
    fd.append('prompt', prompt);
    fd.append('image', blob, 'drawing.png');
    const res = await fetch('/api/quickdraw/guess', { method: 'POST', body: fd });
    if (!res.ok || phase !== 'drawing') { isGuessing = false; return; }
    const result = await res.json();
    if (phase !== 'drawing') { isGuessing = false; return; }

    // No guesses array = Claude call failed on the server. Log it for debugging (visible
    // in browser devtools console) and retry silently instead of saying "mystery drawing".
    if (!result.guesses || !result.guesses.length) {
      if (result.debug) console.warn('[quickdraw] guess API error:', result.debug);
      guessFailCount++;
      if (guessFailCount >= 3) {
        stopGuessLoop();
        const bar = byId('qd-live-guess');
        if (bar) {
          bar.style.display = 'flex';
          bar.innerHTML = '<span style="opacity:.55;font-size:.78rem">' + esc(t('qd.aiUnavail')) + '</span>';
        }
      }
      isGuessing = false;
      return;
    }
    guessFailCount = 0;

    const guesses = result.guesses;
    const promptLower = prompt.toLowerCase().trim();
    let hitGuess = null;

    for (let i = guesses.length - 1; i >= 0; i--) {
      const g = guesses[i];
      const word = (g.word || '').toLowerCase().trim();
      const score = g.score || 0;
      const isHit = score >= 60 || (score >= 45 && word === promptLower);
      liveGuessHist.unshift({ guess: g.word || '?', hit: isHit });
      if (isHit && !hitGuess) hitGuess = g;
    }
    if (liveGuessHist.length > 9) liveGuessHist.length = 9;
    // updateLiveGuessUI() fires from onplay so words appear in sync with voice.

    // Combine all guesses into one sentence (language follows UI).
    const pfx = [t('qd.guessPfx0'), t('qd.guessPfx1'), t('qd.guessPfx2')];
    const sfx = t('qd.guessSfx');
    const phrase = guesses.slice(0, 3)
      .map((g, i) => pfx[i] + (g.word || '?') + sfx)
      .join(' ');

    if (hitGuess) {
      stopGuessLoop();
      // Lock phase to 'guessing' immediately so endRound() (timer callback) bails
      // even if it somehow fires before clearInterval takes effect.
      setPhase('guessing');
      if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
      hidePromptOverlay(); // remove timer display right away — no frozen "5s" visible
      speak(phrase, {
        onplay: () => updateLiveGuessUI(),
        onended: () => {
          isGuessing = false;
          hideLiveGuess();
          speak(t('qd.yesSpeak', { p: prompt }));
          const ov = byId('qd-state-overlay');
          if (ov) {
            ov.style.display = 'flex';
            ov.innerHTML =
              '<div class="qd-state-card">' +
                '<div style="font-size:3.5rem;margin-bottom:.4rem">🎉</div>' +
                '<div style="font-size:1.4rem;font-weight:900;color:#4ade80;margin-bottom:.2rem">' + esc(t('qd.gotIt')) + '</div>' +
                '<div><strong>' + esc(prompt.toUpperCase()) + '</strong></div>' +
              '</div>';
          }
          const thumb = captureThumb();
          setTimeout(() => showResult(result, thumb, prompt), 2000);
        },
      });
    } else {
      speak(phrase, {
        onplay: () => updateLiveGuessUI(),
        onended: () => { isGuessing = false; },
      });
    }
    // isGuessing stays true until onended fires — prevents the next interval tick
    // from starting a new Claude call while TTS is still playing, which would cause
    // stopAudio() to cut the current phrase mid-sentence.
    return;
  } catch (_) { /* degrade silently */ }
  isGuessing = false; // only reached when the Claude fetch itself threw
}

function startGuessLoop() {
  stopGuessLoop();
  // Guess immediately, then poll every 800ms. isGuessing prevents overlap so
  // Claude guesses as fast as it can respond. hasDrawnThisRound guards against
  // firing on an empty canvas, so no delay is needed before the first call.
  doLiveGuess();
  guessLoopId = setInterval(doLiveGuess, 800);
}

function stopGuessLoop() {
  if (guessLoopId) { clearTimeout(guessLoopId); clearInterval(guessLoopId); guessLoopId = null; }
  isGuessing = false;
}

// ── game state machine ───────────────────────────────────────────────────────
function pickPrompts() {
  const pool = [...PROMPTS];
  const picks = [];
  for (let i = 0; i < ROUND_COUNT; i++) {
    const idx = Math.floor(Math.random() * pool.length);
    picks.push(pool.splice(idx, 1)[0]);
  }
  return picks;
}

function updateRailStatus() {
  const rEl = byId('qd-round');
  const tEl = byId('qd-timer-stat');
  if (rEl) rEl.textContent = phase === 'idle' || phase === 'final'
    ? '—' : `${currentRound + 1} / ${ROUND_COUNT}`;
  if (tEl) tEl.textContent = phase === 'drawing' ? timerVal + 's' : '—';
}

function setPhase(p) {
  phase = p;
  updateRailStatus();
}

function startGame() {
  rounds = [];
  emotionLog = [];
  currentRound = 0;
  sessionPrompts = pickPrompts();
  // Pre-fetch all Deepgram phrases used this session so they play instantly
  prefetch(t('qd.sorrySpeak'));
  for (const p of sessionPrompts) prefetch(t('qd.yesSpeak', { p: p }));
  startRound(0);
}

function startRound(i) {
  currentRound = i;
  clearDrawCanvas();
  setPhase('countdown');
  hideStateOverlay();
  hidePromptOverlay();
  showCountdown(3);
}

function showCountdown(n) {
  const ov = byId('qd-state-overlay');
  if (!ov) return;
  ov.style.display = 'flex';
  ov.innerHTML =
    '<div class="qd-state-card">' +
      '<div class="qd-countdown-num">' + n + '</div>' +
      '<div style="color:var(--ink-2);font-size:.9rem;margin-top:.5rem">' + esc(t('qd.getReady')) + '</div>' +
    '</div>';
  if (n > 1) {
    setTimeout(() => showCountdown(n - 1), 900);
  } else {
    setTimeout(() => startDrawing(), 900);
  }
}

function startDrawing() {
  setPhase('drawing');
  timerVal = ROUND_SECS;
  liveGuessHist = [];
  updateRailStatus();
  hideStateOverlay();
  showPromptOverlay();

  startGuessLoop();

  timerInterval = setInterval(() => {
    timerVal--;
    const tEl = byId('qd-timer-display');
    if (tEl) {
      tEl.textContent = timerVal + 's';
      tEl.classList.toggle('urgent', timerVal <= 5);
    }
    updateRailStatus();
    if (timerVal <= 0)   endRound();
  }, 1000);
}

function showPromptOverlay() {
  const ov = byId('qd-prompt-overlay');
  if (!ov) return;
  const prompt = sessionPrompts[currentRound] || '?';
  ov.style.display = 'flex';
  ov.innerHTML =
    '<div class="qd-prompt">' + esc(t('qd.draw')) + '<strong>' + esc(prompt.toUpperCase()) + '</strong></div>' +
    '<div class="qd-timer" id="qd-timer-display">' + timerVal + 's</div>';
}

function hidePromptOverlay() {
  const ov = byId('qd-prompt-overlay');
  if (ov) ov.style.display = 'none';
}

function hideStateOverlay() {
  const ov = byId('qd-state-overlay');
  if (ov) ov.style.display = 'none';
}

function endRound() {
  // Called only when the timer expires. Win path sets phase to 'guessing' first,
  // so this guard prevents endRound from clobbering an in-progress win sequence.
  if (phase !== 'drawing') return;
  stopGuessLoop();
  hideLiveGuess();
  if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
  setPhase('result');
  hidePromptOverlay();
  rounds.push({
    prompt: sessionPrompts[currentRound] || '?',
    guess: '—', score: 0, comment: t('qd.sorrySpeak'),
    thumb: captureThumb(),
  });
  speak(t('qd.sorrySpeak'));
  const ov = byId('qd-state-overlay');
  if (ov) {
    ov.style.display = 'flex';
    ov.innerHTML =
      '<div class="qd-state-card">' +
        '<div style="font-size:2.5rem">⏰</div>' +
        '<div style="font-weight:600;margin-top:.5rem">' + esc(t('qd.timesUp')) + '</div>' +
        '<div style="color:var(--ink-2);font-size:.85rem;margin-top:.25rem">' + esc(t('qd.timesUpSub')) + '</div>' +
      '</div>';
  }
  setTimeout(nextRound, 3000);
}

async function guessDrawing(blob, thumb) {
  const prompt = sessionPrompts[currentRound] || '?';
  let result = { guess: 'mystery drawing', score: 50, comment: 'AI unavailable!' };
  try {
    const fd = new FormData();
    fd.append('prompt', prompt);
    fd.append('image', blob, 'drawing.png');
    const res = await fetch('/api/quickdraw/guess', { method: 'POST', body: fd });
    if (res.ok) result = await res.json();
  } catch (_) { /* degrade silently */ }
  showResult(result, thumb, prompt);
}

function scoreClass(s) {
  if (s >= 70) return 'good';
  if (s >= 40) return 'ok';
  return 'miss';
}

function showResult(result, thumb, prompt) {
  rounds.push({ prompt, guess: result.guess, score: result.score,
                comment: result.comment, thumb });
  setPhase('result');

  const correct = result.score >= 70;
  const ov = byId('qd-state-overlay');
  if (ov) {
    ov.style.display = 'flex';
    ov.innerHTML =
      '<div class="qd-state-card">' +
        '<div style="font-size:2rem;margin-bottom:.5rem">' + (correct ? '🎉' : '🤔') + '</div>' +
        '<div style="font-size:.8rem;color:var(--ink-2);margin-bottom:.25rem">' + esc(t('qd.youDrew')) + '<strong>' + esc(prompt.toUpperCase()) + '</strong></div>' +
        '<div style="font-size:.85rem;margin-bottom:.5rem">' + esc(t('qd.aiGuessed')) + '<strong>' + esc(result.guess) + '</strong></div>' +
        '<span class="qd-score-chip ' + scoreClass(result.score) + '">' + result.score + ' / 100</span>' +
        '<div style="margin-top:.75rem;font-size:.8rem;color:var(--ink-2);font-style:italic">' + esc(result.comment) + '</div>' +
        (currentRound < ROUND_COUNT - 1
          ? '<button class="fa-btn" id="qd-next" style="margin-top:1rem;width:100%" data-gesture-btn>' + esc(t('qd.nextRound')) + '</button>'
          : '<button class="fa-btn" id="qd-next" style="margin-top:1rem;width:100%;background:var(--brand)" data-gesture-btn>' + esc(t('qd.seeResults')) + '</button>'
        ) +
      '</div>';
    const nb = byId('qd-next');
    if (nb) nb.addEventListener('click', nextRound);
  }
  // auto-advance after 4s if user doesn't tap
  setTimeout(() => { if (phase === 'result') nextRound(); }, 4000);
}

function nextRound() {
  if (phase !== 'result') return; // guard against double-fire
  if (currentRound < ROUND_COUNT - 1) {
    startRound(currentRound + 1);
  } else {
    showFinal();
  }
}

function emotionSummary() {
  // Tally the most common dominant emotion across the session.
  const counts = {};
  for (const e of emotionLog) {
    counts[e.emotion] = (counts[e.emotion] || 0) + 1;
  }
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  return sorted.slice(0, 3);
}

function totalScore() {
  if (!rounds.length) return 0;
  return Math.round(rounds.reduce((s, r) => s + r.score, 0) / rounds.length);
}

function showFinal() {
  setPhase('final');
  hideStateOverlay();
  hidePromptOverlay();

  const avg = totalScore();
  const topEmotions = emotionSummary();

  let cardsHtml = rounds.map((r, i) =>
    '<div class="qd-round-card">' +
      '<img class="qd-thumb" src="' + r.thumb + '" alt="' + esc(t('qd.roundN', { n: i + 1 })) + '">' +
      '<div class="qd-card-body">' +
        '<div style="font-size:.75rem;color:var(--ink-2)">' + esc(t('qd.roundN', { n: i + 1 })) + ' · ' + esc(r.prompt.toUpperCase()) + '</div>' +
        '<div style="font-size:.9rem;margin:.1rem 0">' + esc(t('qd.ai')) + '<strong>' + esc(r.guess) + '</strong></div>' +
        '<div style="font-size:.75rem;color:var(--ink-2);font-style:italic">' + esc(r.comment) + '</div>' +
      '</div>' +
      '<span class="qd-score-chip ' + scoreClass(r.score) + '" style="flex-shrink:0">' + r.score + '</span>' +
    '</div>'
  ).join('');

  let emotionHtml = '';
  if (topEmotions.length) {
    const total = emotionLog.length || 1;
    emotionHtml =
      '<div style="margin-top:1rem;font-size:.8rem;font-weight:600;color:var(--ink-2);text-transform:uppercase;letter-spacing:.07em;margin-bottom:.5rem">' + esc(t('qd.emotions')) + '</div>' +
      topEmotions.map(([em, cnt]) => {
        const pct = Math.round(cnt / total * 100);
        return '<div style="margin-bottom:.4rem">' +
          '<div style="display:flex;justify-content:space-between;font-size:.8rem;margin-bottom:.15rem">' +
            '<span>' + esc(em) + '</span><span>' + pct + '%</span>' +
          '</div>' +
          '<div style="height:6px;border-radius:3px;background:var(--line);overflow:hidden">' +
            '<div style="height:100%;width:' + pct + '%;background:var(--brand);border-radius:3px"></div>' +
          '</div>' +
        '</div>';
      }).join('');
  }

  const band = avg >= 70 ? t('qd.band.artist') : avg >= 40 ? t('qd.band.sketcher') : t('qd.band.doodler');

  const panel = byId('qd-panel');
  if (panel) {
    panel.innerHTML =
      '<div style="text-align:center;padding:1rem 0 .75rem">' +
        '<div style="font-size:2.5rem;font-weight:900;color:var(--brand)">' + avg + '</div>' +
        '<div style="font-size:.85rem;color:var(--ink-2)">' + esc(t('qd.avgScore', { band: band })) + '</div>' +
      '</div>' +
      cardsHtml +
      emotionHtml +
      '<button class="fa-btn" id="qd-again" style="width:100%;margin-top:1rem" data-gesture-btn>' + esc(t('qd.playAgain')) + '</button>';
    const ab = byId('qd-again');
    if (ab) ab.addEventListener('click', () => { if (engine.isRunning()) startGame(); });
  }
}

// ── onCursor (drawing + air-touch buttons) ───────────────────────────────────
function onCursor(cur) {
  if (!cursorEl) cursorEl = byId('qd-cursor');
  if (!cursorEl) return;

  if (!cur) {
    cursorEl.classList.remove('show');
    penDownState = false; penUpCount = 0;
    lastPos = null; lastMid = null; smoothPos = null;
    resetDwell();
    return;
  }

  const canvas = byId('qd-canvas');
  if (!canvas) return;
  const r = canvas.getBoundingClientRect();
  // Same cursor placement as live.js — shift up 3% to compensate landmark lag.
  const cx = r.left + cur.x * r.width;
  const cy = r.top  + cur.y * r.height - r.height * 0.03;

  cursorEl.style.left = cx + 'px';
  cursorEl.style.top  = cy + 'px';
  cursorEl.classList.add('show');

  // ── pen detection via pinch (thumb tip ↔ index tip distance) ────────────
  // Thumb touching index = pen DOWN; apart = pen UP (with hysteresis).
  if (cur.pinchDist !== undefined) {
    if (cur.pinchDist < 0.07) {
      penDownState = true; penUpCount = 0;
    } else if (penDownState) {
      if (cur.pinchDist > 0.10) penUpCount++;
      else penUpCount = 0;
      if (penUpCount >= PEN_UP_FRAMES) { penDownState = false; penUpCount = 0; }
    }
  } else {
    penDownState = cur.penDown;      // fallback
  }

  // ── drawing ──────────────────────────────────────────────────────────────
  if (phase === 'drawing' && drawCtx) {
    if (penDownState) {
      hasDrawnThisRound = true;
      cursorEl.classList.add('pen-down');
      const drawCanvas = byId('qd-draw');
      if (drawCanvas) {
        const dr = drawCanvas.getBoundingClientRect();
        // Raw position derived from cursor screen coords
        let rx = (cx - dr.left) / dr.width  * 1280;
        let ry = (cy - dr.top)  / dr.height * 720;
        // Exponential moving average to kill per-frame jitter
        if (smoothPos) {
          rx = smoothPos.x * SMOOTH + rx * (1 - SMOOTH);
          ry = smoothPos.y * SMOOTH + ry * (1 - SMOOTH);
        }
        smoothPos = { x: rx, y: ry };
        const px = rx, py = ry;

        if (lastPos) {
          // Quadratic Bézier: draw from lastMid → new mid, control = lastPos.
          // This produces curves that pass through the smoothed points instead of
          // sharp corners at every sample, even when input jitters.
          const mid = { x: (lastPos.x + px) / 2, y: (lastPos.y + py) / 2 };
          drawCtx.beginPath();
          if (lastMid) {
            drawCtx.moveTo(lastMid.x, lastMid.y);
            drawCtx.quadraticCurveTo(lastPos.x, lastPos.y, mid.x, mid.y);
          } else {
            drawCtx.moveTo(lastPos.x, lastPos.y);
            drawCtx.lineTo(mid.x, mid.y);
          }
          drawCtx.stroke();
          lastMid = mid;
        }
        lastPos = { x: px, y: py };
      }
    } else {
      cursorEl.classList.remove('pen-down');
      lastPos = null; lastMid = null; smoothPos = null;
    }
    if (penDownState) { resetDwell(); return; }
  } else {
    cursorEl.classList.remove('pen-down');
  }

  // ── dwell hit-test for buttons ───────────────────────────────────────────
  const hit = document.elementFromPoint(cx, cy);
  const btn = hit && hit.closest('[data-gesture-btn]');
  if (btn) {
    if (btn !== dwellTarget) { dwellTarget = btn; dwellStart = performance.now(); }
    const holdMs   = Number(btn.dataset.gestureDwell) || DWELL_MS;
    const progress = Math.min(1, (performance.now() - dwellStart) / holdMs);
    cursorEl.style.setProperty('--dwell', progress);
    if (progress >= 1 && performance.now() - lastClickTs >= CLICK_COOL) {
      lastClickTs = performance.now();
      resetDwell();
      btn.click();
    }
  } else {
    resetDwell();
  }
}

// ── onStats (face emotion tracking) ─────────────────────────────────────────
function onStats(out) {
  const fEl = byId('qd-fps');
  const dEl = byId('qd-det');
  if (fEl) fEl.textContent = out.fps ?? '—';
  if (dEl) dEl.textContent = out.detections ?? '—';

  if (out.bs && phase === 'drawing') {
    const dom = dominantEmotion(out.bs);
    if (dom && dom.emotion !== 'neutral') {
      emotionLog.push({ ts: Date.now(), emotion: dom.emotion, value: dom.value });
    }
  }
}

// ── camera ───────────────────────────────────────────────────────────────────
async function startCamera() {
  const startBtn = byId('qd-start');
  if (startBtn) { startBtn.disabled = true; startBtn.textContent = t('qd.loading'); }
  const ph = byId('qd-ph');
  if (ph) ph.textContent = t('qd.loadingModels');

  try {
    const canvas = byId('qd-canvas');
    await engine.start(canvas, { onStats, onCursor, showOverlay: false, audio: false });
    engine.setHandThrottle(33);  // 30fps hand tracking for smooth strokes
    initDrawCanvas();
    if (ph) ph.style.display = 'none';
    if (startBtn) { startBtn.disabled = false; startBtn.textContent = t('qd.start'); }
    // Wire start button now that camera is live
    if (startBtn) startBtn.addEventListener('click', startGame, { once: true });
  } catch (e) {
    if (ph) ph.textContent = t('qd.camError', { m: e.message });
    if (startBtn) { startBtn.disabled = false; startBtn.textContent = t('qd.retry'); }
  }
}

function stopCamera() {
  stopGuessLoop();
  stopAudio();
  if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
  engine.setHandThrottle(null);
  engine.stop();
  drawCtx = null;
  lastPos = null; lastMid = null; smoothPos = null;
  penDownState = false;
  penUpCount   = 0;
  cursorEl = null;
  dwellTarget = null;
  dwellStart = 0;
  lastClickTs = 0;
}

// ── screen factory ───────────────────────────────────────────────────────────
export function quickdraw() {
  // Reset all state
  phase = 'idle';
  rounds = [];
  currentRound = 0;
  timerVal = ROUND_SECS;
  timerInterval = null;
  emotionLog = [];
  drawCtx = null;
  lastPos = null; lastMid = null; smoothPos = null;
  sessionPrompts = [];
  cursorEl = null;
  dwellTarget = null;
  dwellStart = 0;
  lastClickTs = 0;
  penDownState = false;
  penUpCount   = 0;
  guessLoopId       = null;
  isGuessing        = false;
  liveGuessHist     = [];
  hasDrawnThisRound = false;
  currentAudio      = null;
  speakGen          = 0;

  engine.stop();

  // Teardown on navigation
  const onNav = () => { stopCamera(); window.removeEventListener('hashchange', onNav); };
  window.addEventListener('hashchange', onNav, { once: true });

  queueMicrotask(() => {
    startCamera();
  });

  return (
    '<div class="screen">' +
      '<div class="screen-head"><h1 class="screen-title">' + esc(t('qd.heading')) + '</h1></div>' +
      '<div class="fa-grid">' +

        // ── Rail ──────────────────────────────────────────────────────────
        '<div class="fa-rail">' +
          '<div style="font-size:.75rem;font-weight:600;color:var(--ink-2);text-transform:uppercase;letter-spacing:.07em;margin-bottom:.5rem">' + esc(t('qd.subtitle')) + '</div>' +
          '<div style="font-size:.8rem;color:var(--ink-2);margin-bottom:1rem;line-height:1.5">' +
            t('qd.howto') +
          '</div>' +

          '<div class="fa-stat"><span class="fa-stat-l">' + esc(t('qd.round')) + '</span><span class="fa-stat-r" id="qd-round">—</span></div>' +
          '<div class="fa-stat"><span class="fa-stat-l">' + esc(t('qd.timer')) + '</span><span class="fa-stat-r" id="qd-timer-stat">—</span></div>' +
          '<div class="fa-stat"><span class="fa-stat-l">' + esc(t('qd.fps')) + '</span><span class="fa-stat-r" id="qd-fps">—</span></div>' +
          '<div class="fa-stat"><span class="fa-stat-l">' + esc(t('qd.hands')) + '</span><span class="fa-stat-r" id="qd-det">—</span></div>' +

          '<button class="fa-btn" id="qd-start" disabled style="margin-top:auto" data-gesture-btn data-gesture-dwell="1500">' + esc(t('qd.start')) + '</button>' +
        '</div>' +

        // ── Stage + Panel ─────────────────────────────────────────────────
        '<div style="display:flex;flex-direction:column;flex:1;min-width:0;gap:1rem">' +
          '<div class="fa-stage" id="qd-stage">' +
            // Indicator dot
            '<div class="fa-live" id="qd-live"></div>' +
            // Main video canvas (CSS-mirrored)
            '<canvas id="qd-canvas" style="position:absolute;inset:0;width:100%;height:100%;transform:scaleX(-1)"></canvas>' +
            // Drawing strokes canvas (no CSS transform)
            '<canvas id="qd-draw" style="position:absolute;inset:0;width:100%;height:100%;background:transparent;transform:none"></canvas>' +
            // Prompt + timer overlay
            '<div id="qd-prompt-overlay" style="display:none;position:absolute;inset:0;flex-direction:column;align-items:center;justify-content:flex-start;padding-top:1rem;pointer-events:none"></div>' +
            // State overlay (countdown / guessing / result)
            '<div id="qd-state-overlay" style="display:none;position:absolute;inset:0;align-items:center;justify-content:center;background:rgba(0,0,0,.55);backdrop-filter:blur(4px)"></div>' +
            // Live AI guess bar — shown during drawing
            '<div id="qd-live-guess" style="display:none">' +
              '<span class="qd-guess-label">🤖</span>' +
              '<span id="qd-guess-words"></span>' +
            '</div>' +
            // Placeholder
            '<div class="ph" id="qd-ph" style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:var(--surface-2);color:var(--ink-2);font-size:.9rem">' + esc(t('qd.startingCam')) + '</div>' +
          '</div>' +

          '<div class="fa-panel" id="qd-panel">' +
            '<div style="color:var(--ink-2);font-size:.85rem;padding:.5rem 0">' + esc(t('qd.panelHint')) + '</div>' +
          '</div>' +
        '</div>' +

      '</div>' +
      // Cursor ring (same style as live.js)
      '<div id="qd-cursor" class="lv-cursor"></div>' +
    '</div>'
  );
}
