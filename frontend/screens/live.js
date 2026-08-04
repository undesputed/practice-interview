import * as engine from '../interview-engine.js';
import { startVoiceAgent } from '../deepgram-client.js';
import { getInterviewConfig } from '../interview-config.js';
import { api } from '../api.js';
import { esc } from '../util.js';
import { startRecording } from '../audio-recorder.js';
import { computeLiveMetrics } from '../live-metrics.js';
import { emotionScores, dominantEmotion } from '../emotion.js';
import { setPendingSession } from '../pending-session.js';
import { setNotesCache } from './notes.js';
import { currentLang } from '../i18n.js';

let agent = null;          // active Deepgram voice agent, or null
let cursorEl    = null;    // air-touch cursor dot
let dwellTarget = null;    // button currently being dwelled on
let dwellStart  = 0;       // when dwell on current target began
let lastClickTs = 0;       // cooldown after a dwell click
const DWELL_MS      = 1200;
const CLICK_COOL_MS = 2000;

// One Euro filter: low-lag smoothing for the noisy fingertip cursor. When the hand
// holds still it cuts jitter hard; when it moves fast it lets the motion through with
// little lag. Tuned for normalized (0..1) coords at ~30fps. See gery.casiez.net/1euro
function makeOneEuro(minCutoff, beta) {
  let xPrev = null, dxPrev = 0, tPrev = 0;
  const alpha = (cutoff, dt) => { const tau = 1 / (2 * Math.PI * cutoff); return 1 / (1 + tau / dt); };
  return {
    reset() { xPrev = null; dxPrev = 0; tPrev = 0; },
    filter(x, t) {
      if (xPrev === null) { xPrev = x; tPrev = t; return x; }
      const dt = Math.max(1e-3, (t - tPrev) / 1000);
      tPrev = t;
      const dx = (x - xPrev) / dt;
      const aD = alpha(1.0, dt);           // derivative low-pass (dcutoff = 1.0)
      dxPrev = aD * dx + (1 - aD) * dxPrev;
      const cutoff = minCutoff + beta * Math.abs(dxPrev);
      const a = alpha(cutoff, dt);
      xPrev = a * x + (1 - a) * xPrev;
      return xPrev;
    },
  };
}
// minCutoff = smoothing when the hand is still (higher = less lag, more jitter).
// beta = how much fast motion cuts the smoothing (higher = pointer keeps up on quick
// moves instead of trailing behind). Tune these two if it feels laggy or jittery.
const euroX = makeOneEuro(1.7, 2.0);
const euroY = makeOneEuro(1.7, 2.0);
function resetCursorSmoothing(){ euroX.reset(); euroY.reset(); }
let convoCount = 0;        // conversation lines seen this run
let turn = -1;             // interview question index; advances on each interviewer line
let segments = [];         // { speaker, text, t } transcript lines
let events = [];           // action events captured for the report
let startTs = 0;           // performance.now() at start, for segment timestamps
let finishing = false;     // guard so End + agent-close don't double-submit
let recorder = null;       // active audio recorder handle, or null
let role = '';             // interview role captured at start
let scenario = 'job';     // interview scenario captured at start
let muted = false;         // mic muted?
let camOn = true;          // camera on?
let leaveHandler = null;   // active hashchange teardown listener, so re-entry can't stack them
let metricsInterval = null;

// ── Interactive Book (in-session notes) ──────────────────────────────────────
let bookOpen        = false;
let bookTitle       = 'Interview Notes';
const BOOK_PAGES    = 10;
let bookNotes       = Array.from({ length: BOOK_PAGES }, () => []);  // pages; each page = [{ts, text}]
let bookCurrentPage = 0;
// Swipe: compare the last two DISTINCT hand positions (throttled by engine).
// Avoids the cached-position problem where many frames have identical x values.
let lastSwipePos    = null;  // {x, t} of last unique cursor position
let swipeCooldown   = false;
let palmHeldStart   = 0;     // ms timestamp when Open_Palm gesture started
let palmCooldown    = false;
let bookDragging    = false;
let bookDragOrigin  = { mx: 0, my: 0, bx: 0, by: 0 };

const MIC_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="2" width="6" height="12" rx="3"></rect><path d="M5 10v2a7 7 0 0 0 14 0v-2"></path><line x1="12" y1="19" x2="12" y2="22"></line><line x1="8" y1="22" x2="16" y2="22"></line></svg>';
const CAM_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 7l-7 5 7 5V7z"></path><rect x="1" y="5" width="15" height="14" rx="2"></rect></svg>';

function fmtTime(ms){ const s = Math.max(0, Math.floor(ms / 1000)); return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0'); }
function byId(id){ return document.getElementById(id); }
function setText(id, v){ const el = byId(id); if (el) el.textContent = v; }
function setState(t){ setText('lv-state', t); }
function setVoice(t){ setText('lv-voice', t); }
function showControls(on){ const c = byId('lv-controls'); if (c) c.style.display = on ? 'flex' : 'none'; }
function setOverlay(text, spin){
  const ph = byId('lv-ph'); if (!ph) return;
  ph.style.display = text ? 'flex' : 'none';
  const t = byId('lv-ph-txt'); if (t) t.textContent = text || '';
  const sp = byId('lv-spin'); if (sp) sp.style.display = (text && spin) ? '' : 'none';
}
function loading(text){ setOverlay(text, true); }    // spinner + text (busy states)
function overlay(text){ setOverlay(text, false); }   // text only (errors), or null to hide
function showStart(label){ const b = byId('lv-start'); if (b){ b.style.display = label ? '' : 'none'; if (label) b.textContent = label; } }

function onStats(s){ setText('lv-time', fmtTime(s.elapsedMs)); }

// Air-touch: move cursor dot, dwell over [data-gesture-btn] to click.
// Also handles book swipe (when book is open) and Open_Palm to toggle book.
function onCursor(cur) {
  if (!cursorEl) cursorEl = byId('lv-cursor');
  if (!cursorEl) return;
  if (!cur) {
    cursorEl.classList.remove('show');
    resetDwell();
    resetCursorSmoothing();   // clear filter state so the next hand-raise starts clean
    lastSwipePos = null;
    if (!palmCooldown) palmHeldStart = 0;
    return;
  }
  const canvas = byId('lv-canvas');
  if (!canvas) return;
  const r = canvas.getBoundingClientRect();
  // Smooth the dot's screen position + dwell hit-test (below). Swipe/pinch logic keeps
  // using the raw cur.x/pinchDist so their tuned thresholds are unaffected.
  const now = performance.now();
  const cx = r.left + euroX.filter(cur.x, now) * r.width;
  const cy = r.top  + euroY.filter(cur.y, now) * r.height - r.height * 0.04;
  cursorEl.style.left = cx + 'px';
  cursorEl.style.top  = cy + 'px';
  cursorEl.classList.add('show');

  const isOpenPalm = cur.gestures && cur.gestures.some(g => g === 'Open_Palm');
  const bkEl = byId('lv-book');

  // ── Open_Palm hold 0.8s → OPEN book (disabled while book is open) ────────
  // When the book is open the same gesture is used for swiping, so the hold
  // timer must stay off — otherwise a slow swipe triggers an accidental close.
  if (!bookOpen) {
    if (isOpenPalm) {
      if (!palmHeldStart) palmHeldStart = Date.now();
      if (!palmCooldown && Date.now() - palmHeldStart > 800) {
        palmCooldown = true;
        palmHeldStart = 0;
        toggleBook();
        setTimeout(() => { palmCooldown = false; }, 2000);
      }
    } else {
      if (!palmCooldown) palmHeldStart = 0;
    }
  } else {
    palmHeldStart = 0; // always clear while book is open
  }

  // ── Swipe detection for book page turns (Open_Palm only) ─────────────────
  // During swipeCooldown we do NOT track at all — this prevents the return
  // motion of the hand from accumulating dx and triggering the reverse page turn
  // once the cooldown expires.
  if (bookOpen) {
    if (!isOpenPalm) {
      lastSwipePos = null;
      if (bkEl) bkEl.classList.remove('bk-swipe-ready');
    } else if (swipeCooldown) {
      // Cooldown active: freeze tracking so the return motion isn't counted
      lastSwipePos = null;
    } else {
      if (bkEl) bkEl.classList.add('bk-swipe-ready');
      const now = Date.now();
      if (lastSwipePos === null) {
        lastSwipePos = { x: cur.x, t: now, startX: cur.x, startT: now, dir: 0 };
      } else if (cur.x !== lastSwipePos.x) {
        if (now - lastSwipePos.t > 700) {
          // Hand paused — restart from new anchor position
          lastSwipePos = { x: cur.x, t: now, startX: cur.x, startT: now, dir: 0 };
        } else {
          const stepDx  = cur.x - lastSwipePos.x;
          // Only count a decisive step (>0.035 of frame width) as a direction. Small
          // hand wobble stays dir=0 so it can't false-trigger the reversal reset below
          // and cancel a legitimate swipe — that was the main "swipe not accurate" cause.
          const thisDir = Math.abs(stepDx) > 0.035 ? Math.sign(stepDx) : 0;
          if (thisDir !== 0 && lastSwipePos.dir !== 0 && thisDir !== lastSwipePos.dir) {
            // Direction reversed mid-gesture — reset anchor so return motion can't
            // accumulate against the old startX and fire the opposite page turn.
            lastSwipePos = { x: cur.x, t: now, startX: cur.x, startT: now, dir: thisDir };
          } else {
            const totalDx = cur.x - lastSwipePos.startX;
            const elapsed  = now - lastSwipePos.startT;
            if (Math.abs(totalDx) > 0.09 && elapsed > 60 && elapsed < 1500) {
              lastSwipePos = null;
              if (bkEl) bkEl.classList.remove('bk-swipe-ready');
              if (totalDx > 0) bookNextPage(); else bookPrevPage();
            } else {
              lastSwipePos = { ...lastSwipePos, x: cur.x, t: now,
                dir: thisDir || lastSwipePos.dir };
            }
          }
        }
      }
    }
  } else {
    lastSwipePos = null;
    if (bkEl) bkEl.classList.remove('bk-swipe-ready');
  }

  // ── Pinch-to-drag the book overlay ────────────────────────────────────────
  // Pinch (thumb + index tip close) over the drag handle grabs the book; releasing
  // drops it. Hysteresis: grab needs a firm pinch (<0.07), but once grabbed we hold
  // until the fingers clearly separate (>0.11) so small wobble can't drop it mid-drag.
  // Shares bookDragging with the mouse drag path.
  if (bookOpen) {
    const isPinching = cur.pinchDist < (bookDragging ? 0.11 : 0.07);
    if (isPinching && !bookDragging) {
      const dragHit = document.elementFromPoint(cx, cy);
      if (dragHit && dragHit.closest && dragHit.closest('#lv-book-drag')) {
        const bk = byId('lv-book');
        if (bk) {
          const rect = bk.getBoundingClientRect();
          bookDragging = true;
          bookDragOrigin = { mx: cx, my: cy, bx: rect.left, by: rect.top };
        }
      }
    } else if (!isPinching && bookDragging) {
      bookDragging = false;
      if (bkEl) bkEl.classList.remove('bk-finger-dragging');
    }
    if (bookDragging && isPinching) {
      const bk = byId('lv-book');
      if (bk) {
        bk.classList.add('bk-finger-dragging');
        bk.style.left   = (bookDragOrigin.bx + cx - bookDragOrigin.mx) + 'px';
        bk.style.top    = (bookDragOrigin.by + cy - bookDragOrigin.my) + 'px';
        bk.style.right  = 'auto';
        bk.style.bottom = 'auto';
      }
    }
  }

  // ── Dwell hit-test for gesture buttons ───────────────────────────────────
  // Skip while dragging the book so the close/stats buttons don't fire mid-drag.
  if (!bookDragging) {
    const hit = document.elementFromPoint(cx, cy);
    const btn = hit && hit.closest('[data-gesture-btn]');
    if (btn) {
      if (btn !== dwellTarget) { dwellTarget = btn; dwellStart = performance.now(); }
      const holdMs   = Number(btn.dataset.gestureDwell) || DWELL_MS;
      const progress = Math.min(1, (performance.now() - dwellStart) / holdMs);
      cursorEl.style.setProperty('--dwell', progress);
      if (progress >= 1 && performance.now() - lastClickTs >= CLICK_COOL_MS) {
        lastClickTs = performance.now();
        resetDwell();
        btn.click();
      }
    } else {
      resetDwell();
    }
  } else {
    resetDwell();
  }
}

function resetDwell() {
  dwellTarget = null;
  dwellStart  = 0;
  if (cursorEl) cursorEl.style.setProperty('--dwell', 0);
}

// ── Interactive Book ──────────────────────────────────────────────────────────
// bookCurrentPage = spread index (0 – BOOK_PAGES/2-1).
// Each spread shows two physical pages: left = spread*2, right = spread*2+1.
const BOOK_SPREADS = BOOK_PAGES / 2;  // 5 spreads × 2 pages = 10 pages total

function bookRender() {
  const left = byId('bk-left');
  const right = byId('bk-right');
  const pn   = byId('bk-pagenum');
  if (!left || !right) return;
  const lPageNum = bookCurrentPage * 2 + 1;
  if (pn) pn.textContent = 'Pages ' + lPageNum + '–' + (lPageNum + 1) + ' of ' + BOOK_PAGES;

  const renderPanel = (el, notes, pageNum, isLeft) => {
    const numStr = '<div class="bk-page-num">' + pageNum + '</div>';
    if (!notes || !notes.length) {
      el.innerHTML = numStr + '<div class="bk-empty">' +
        (isLeft ? 'Say "please note…" to the interviewer.' : '') + '</div>';
    } else {
      el.innerHTML = numStr + notes.map(n =>
        '<div class="bk-note"><span class="bk-note-time">' + n.ts + '</span>' + esc(n.text) + '</div>'
      ).join('');
      el.scrollTop = el.scrollHeight;
    }
  };

  const lIdx = bookCurrentPage * 2;
  renderPanel(left,  bookNotes[lIdx],     lIdx + 1, true);
  renderPanel(right, bookNotes[lIdx + 1], lIdx + 2, false);
}

function toggleBook() {
  bookOpen = !bookOpen;
  const el = byId('lv-book');
  if (el) {
    el.style.display = bookOpen ? 'flex' : 'none';
    if (!bookOpen) el.classList.remove('bk-finger-dragging', 'bk-swipe-ready');
  }
  bookRender();
}

function bookNextPage() {
  if (swipeCooldown) return;
  swipeCooldown = true;
  setTimeout(() => { swipeCooldown = false; }, 1000);
  if (bookCurrentPage < BOOK_SPREADS - 1) bookCurrentPage++;
  bookRender();
}

function bookPrevPage() {
  if (swipeCooldown) return;
  swipeCooldown = true;
  setTimeout(() => { swipeCooldown = false; }, 1000);
  if (bookCurrentPage > 0) bookCurrentPage--;
  bookRender();
}

// Called by the voice agent (via onNote callback) when it takes a note.
// pageNum (1-10): if provided, note goes to that specific physical page and the
// book navigates to the spread containing it. Without pageNum, notes fill the
// left page of the current spread, overflowing to the right, then next spread.
function addNote(text, pageNum) {
  if (!text || !text.trim()) return;
  const now = new Date();
  const ts  = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
  let target;
  if (pageNum && pageNum >= 1 && pageNum <= BOOK_PAGES) {
    target = pageNum - 1;
    bookCurrentPage = Math.floor(target / 2);
  } else {
    const lIdx = bookCurrentPage * 2;
    target = lIdx;
    if (bookNotes[lIdx].length >= 4 && lIdx + 1 < bookNotes.length) {
      target = lIdx + 1;
      if (bookNotes[lIdx + 1].length >= 4 && bookCurrentPage < BOOK_SPREADS - 1) {
        bookCurrentPage++;
        target = bookCurrentPage * 2;
      }
    }
  }
  bookNotes[target].push({ ts, text: text.trim() });
  if (!bookOpen) {
    bookOpen = true;
    const el = byId('lv-book');
    if (el) el.style.display = 'flex';
  }
  bookRender();
}

async function loadMasterNotebook() {
  try {
    const res = await fetch('/api/notes/master');
    if (!res.ok) return;
    const nb = await res.json();
    const pages = nb.pages || [];
    for (let i = 0; i < BOOK_PAGES; i++) bookNotes[i] = pages[i] || [];
    if (nb.title) { bookTitle = nb.title; const bt = byId('bk-title'); if (bt) bt.textContent = bookTitle; }
    // Open to the first empty spread so new notes land on a fresh page
    const spreads = Math.ceil(BOOK_PAGES / 2);
    for (let s = 0; s < spreads; s++) {
      if (!bookNotes[s * 2].length && !(bookNotes[s * 2 + 1] || []).length) {
        bookCurrentPage = s; break;
      }
    }
    bookRender();
  } catch (_) {}
}

function resetBook() {
  bookOpen = false; bookNotes = Array.from({ length: BOOK_PAGES }, () => []); bookCurrentPage = 0;
  bookTitle = 'My Notebook';
  lastSwipePos = null; swipeCooldown = false;
  palmHeldStart = 0; palmCooldown = false;
  bookDragging = false;
  const el = byId('lv-book');
  if (el) el.style.display = 'none';
}

const SCORE_STEPS = ['Analyzing camera & presence', 'Analyzing your voice', 'Generating your report'];
function showScoreSteps(activeIdx){
  const el = byId('lv-steps'); if (!el) return;
  el.innerHTML = SCORE_STEPS.map((s, i) =>
    '<div class="lv-step ' + (i < activeIdx ? 'done' : i === activeIdx ? 'active' : '') + '">' + s + '</div>'
  ).join('');
  el.style.display = 'flex';
}
function hideScoreSteps(){ const el = byId('lv-steps'); if (el) el.style.display = 'none'; }

const LIVE_FACS = [
  ['mouthSmileLeft',  'Smile'],
  ['browInnerUp',     'Brow up'],
  ['browDownLeft',    'Brow down'],
  ['jawOpen',         'Jaw open'],
  ['eyeSquintLeft',   'Squint'],
  ['eyeWideLeft',     'Eye wide'],
];

function liveBar(label, pct){
  const p = Math.round(Math.max(0, Math.min(100, pct)));
  return '<div class="lv-bar-row"><span class="lv-bar-nm">' + label + '</span>' +
    '<span class="lv-bar-tk"><span class="lv-bar-fi" style="width:' + p + '%"></span></span>' +
    '<span class="lv-bar-pct">' + p + '</span></div>';
}

function updateLiveStats(){
  const panel = byId('lv-stats');
  if (!panel || !panel.classList.contains('open')) return;

  const allFrames = engine.getFrames();
  const frames = allFrames.length > 90 ? allFrames.slice(-90) : allFrames;

  const m = computeLiveMetrics(frames, segments);
  if (m){
    const setCard = (numId, barId, val, suffix) => {
      const el = byId(numId);
      if (el){
        el.textContent = val + (suffix || '');
        el.className = 'lv-score-num ' + (val >= 70 ? 'lv-good' : val >= 50 ? 'lv-mid' : 'lv-low');
      }
      const bar = byId(barId); if (bar) bar.style.width = Math.max(0, Math.min(100, val)) + '%';
    };
    setCard('lm-att',  'lm-att-bar',  m.attention, '');
    setCard('lm-comp', 'lm-comp-bar', m.composure, '');
    setCard('lm-eye',  'lm-eye-bar',  m.eyeContact, '%');
  }

  const latest = allFrames[allFrames.length - 1];
  const bs = (latest && latest.bs) || {};

  const dom = dominantEmotion(bs);
  const domEl = byId('lm-emo-dom');
  const domPct = byId('lm-emo-pct');
  if (domEl) domEl.textContent = (dom && dom.emotion) ? dom.emotion : '—';
  if (domPct) domPct.textContent = (dom && dom.value != null) ? Math.round(dom.value) + '%' : '';

  const scores = emotionScores(bs);
  const emoBarsEl = byId('lm-emo-bars');
  if (emoBarsEl && scores){
    const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1]);
    emoBarsEl.innerHTML = sorted.slice(0, 6).map(([emo, val]) => liveBar(emo, val)).join('');
  }

  const facsBarsEl = byId('lm-facs-bars');
  if (facsBarsEl){
    facsBarsEl.innerHTML = LIVE_FACS.map(([key, lbl]) => liveBar(lbl, (bs[key] || 0) * 100)).join('');
  }

  const wpmEl = byId('lm-wpm');
  if (wpmEl){
    if (segments.length >= 2){
      const cand = segments.filter(s => s.speaker === 'candidate');
      const words = cand.reduce((n, s) => n + (s.text || '').trim().split(/\s+/).filter(Boolean).length, 0);
      const elMin = (segments[segments.length - 1].t - segments[0].t) / 60000;
      wpmEl.textContent = (elMin > 0.1 && words > 0) ? Math.round(words / elMin) + '~' : '—';
    } else {
      wpmEl.textContent = '—';
    }
  }
}

function stopMetrics(){ if (metricsInterval){ clearInterval(metricsInterval); metricsInterval = null; } }

function toggleStats(){
  const p = byId('lv-stats');
  if (!p) return;
  p.classList.toggle('open');
  if (p.classList.contains('open')) updateLiveStats();
}

// Actions are still captured for the post-interview report (no live panel now).
function onAction(ev){ events.push(ev); }

function onTranscript({ speaker, text }){
  if (speaker === 'interviewer'){ turn += 1; engine.setTurn(turn); }   // matches questions_from_transcript
  segments.push({ speaker, text, t: performance.now() - startTs });
  const who = speaker === 'interviewer' ? 'Interviewer' : 'You';
  const cls = speaker === 'interviewer' ? 'interviewer' : 'candidate';
  const cap = byId('lv-cap');
  if (cap){
    cap.className = 'li-cap show ' + cls;
    cap.innerHTML = '<span class="who">' + who + '</span>' + esc(text);
  }
  const box = byId('lv-convo');
  if (box){
    if (!convoCount) box.innerHTML = '';
    convoCount++;
    const line = document.createElement('div');
    line.className = 'line ' + cls;
    line.innerHTML = '<span class="who">' + who + '</span>' + esc(text);
    box.appendChild(line);
    box.scrollTop = box.scrollHeight;
  }
}

function onAiSpeaking(on){
  const tile = byId('lv-ai'); if (tile) tile.classList.toggle('speaking', !!on);
  setText('lv-ai-state', on ? 'speaking' : 'listening');
}

async function startAgent(){
  const cfg = getInterviewConfig();
  setVoice('Connecting…');
  try {
    const tok = await api.interviewToken({
      scenario: cfg.scenario, role: cfg.role, focus: cfg.focus, difficulty: cfg.difficulty,
      question_count: cfg.questionCount, questions: cfg.questions || [], tone: cfg.tone,
      language: cfg.language || 'en',
    });
    const stream = engine.getStream();
    if (!stream || !engine.isRunning()) return;   // stopped / navigated away during the token fetch
    agent = startVoiceAgent({
      url: tok.url, token: tok.token, scheme: tok.scheme, config: tok.config,
      micStream: stream,
      onTranscript,
      onNote: addNote,
      onSpeaking: onAiSpeaking,
      onError: (m) => setVoice('Voice error: ' + m),
      onClose: (e, info) => {
        if (info && info.fatal){ voiceAgentFailed(info.message); return; }   // dead interview — don't score
        if (engine.isRunning()) finishInterview();
      },
    });
    setVoice(muted ? 'Muted' : 'Live');
  } catch (e){ setVoice('Voice unavailable: ' + (e && e.message ? e.message : e)); }
}

function stopAgent(){ if (agent){ try { agent.stop(); } catch (_){} agent = null; } }

function toggleMute(){
  muted = !muted;
  if (agent && agent.setMuted) agent.setMuted(muted);
  if (recorder){ if (muted){ if (recorder.pause) recorder.pause(); } else if (recorder.resume){ recorder.resume(); } }
  const btn = byId('lv-mute'); if (btn) btn.classList.toggle('off', muted);
  setVoice(muted ? 'Muted' : 'Live');
}

function toggleCamera(){
  camOn = !camOn;
  engine.setCameraOn(camOn);
  const imm = byId('live-imm'); if (imm) imm.classList.toggle('cam-off', !camOn);
  const btn = byId('lv-cam'); if (btn) btn.classList.toggle('off', !camOn);
}

function toggleTranscript(){ const p = byId('lv-transcript'); if (p) p.classList.toggle('open'); }

function clearImmersive(){
  document.body.classList.remove('live-immersive');
  cursorEl = null; dwellTarget = null; dwellStart = 0; lastClickTs = 0;
  resetCursorSmoothing();
  resetBook();
}

// Leave WITHOUT scoring (confirm first). Tears down and returns to the dashboard.
function exitInterview(){
  if (!window.confirm("Leave without scoring? Your interview won’t be saved.")) return;
  stopMetrics();
  stopAgent();
  if (recorder && recorder.stop){ try { recorder.stop(); } catch (_){} }
  recorder = null;
  engine.stop();
  clearImmersive();
  location.hash = '#/';
}

// End the interview: tear down immediately, hand everything to thanks.js for scoring.
// The user should leave the camera screen as fast as possible — all async work
// (voice analysis, Claude) happens on the thanks/pending page instead.
async function finishInterview(){
  if (finishing) return;
  finishing = true;
  stopMetrics();
  showControls(false);

  const frames = engine.getFrames().slice();
  const rec = recorder; recorder = null;
  stopAgent();
  const audio = rec ? await rec.stop() : null;  // assemble blob (~0ms), no network
  engine.stop();

  if (!frames.length){
    overlay('Nothing to score.'); showStart('Start');
    return;
  }

  const full_text = segments
    .map((s) => (s.speaker === 'interviewer' ? 'INTERVIEWER: ' : 'CANDIDATE: ') + s.text)
    .join('\n');
  // Persist master notebook and warm the notes page cache so /notes is instant.
  const _nbSnapshot = {
    title: bookTitle, pages: bookNotes.map(p => [...p]),
    updated_at: new Date().toISOString(),
    note_count: bookNotes.reduce((n, p) => n + p.length, 0),
  };
  setNotesCache(_nbSnapshot);
  fetch('/api/notes/master', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: bookTitle, role, scenario, pages: bookNotes }),
  }).catch(() => {});

  setPendingSession({
    scenario, role, frames,
    transcript: { full_text, segments },
    events, emotion: null,
    audioBlob: audio ? audio.blob : null,
    language: (getInterviewConfig().language === 'ja' || currentLang() === 'ja') ? 'ja' : 'en',
  });
  location.hash = '#/thanks/pending';
}

function resetConvo(){
  convoCount = 0;
  const cap = byId('lv-cap'); if (cap){ cap.className = 'li-cap'; cap.innerHTML = ''; }
  const convo = byId('lv-convo'); if (convo) convo.innerHTML = '<div class="fa-note">The interviewer will greet you when the connection is ready…</div>';
  const panel = byId('lv-transcript'); if (panel) panel.classList.remove('open');
  const sp = byId('lv-stats'); if (sp) sp.classList.remove('open');
  onAiSpeaking(false);
}

// The voice agent died with a fatal error (e.g. Deepgram couldn't reach the think/LLM
// provider — FAILED_TO_THINK). Don't run the scoring pipeline on a dead interview (that's
// the slow, confusing "hang"); tear down and show a clear, retryable message instead.
function voiceAgentFailed(message){
  if (finishing) return;          // a normal finish already ran
  finishing = true;
  stopMetrics();
  if (recorder && recorder.stop){ try { recorder.stop(); } catch (_){} }
  recorder = null;
  stopAgent();
  engine.stop();
  console.warn("[live] voiceAgentFailed:", message);
  overlay('The interviewer’s AI couldn’t respond, so the interview stopped. This is usually a ' +
          'Deepgram Voice Agent LLM access/billing issue, not your answers. Please try again.');
  setState('Error'); setVoice('—');
  showControls(false); showStart('Retry');
}

function cameraError(e){
  overlay('Camera unavailable: ' + (e && e.message ? e.message : e));
  showControls(false);
  setState('Error'); setVoice('—');
  showStart('Retry');
}

async function startEngine(){
  const canvas = byId('lv-canvas');
  if (!canvas) return;

  convoCount = 0; turn = -1;
  segments = []; events = []; startTs = performance.now(); finishing = false;
  role = getInterviewConfig().role;
  scenario = getInterviewConfig().scenario || 'job'; recorder = null;
  muted = false; camOn = true;
  resetBook();
  loadMasterNotebook();
  const imm = byId('live-imm'); if (imm) imm.classList.remove('cam-off');
  const mb = byId('lv-mute'); if (mb){ mb.classList.remove('off'); mb.disabled = false; }
  const cb = byId('lv-cam'); if (cb) cb.classList.remove('off');
  resetConvo();
  loading('Loading model…'); showControls(false); showStart(null);
  setState('Starting…'); setVoice('—');

  // Try camera + mic; fall back to vision-only if the mic is blocked.
  let micOk = true;
  try {
    await engine.start(canvas, { onStats, onAction, onCursor, showOverlay: false, audio: true });
  } catch (e){
    micOk = false;
    try { await engine.start(canvas, { onStats, onAction, onCursor, showOverlay: false, audio: false }); }
    catch (e2){ cameraError(e2); return; }
  }
  if (!engine.isRunning()) return;   // superseded (navigated away or restarted mid-load)
  overlay(null); showControls(true);
  setState('Detecting');
  stopMetrics();
  metricsInterval = setInterval(updateLiveStats, 2000);
  if (micOk){
    startAgent();
    recorder = startRecording(engine.getStream());   // capture audio for Delivery analysis
  } else {
    setVoice('Mic unavailable — analysis only');
    if (mb) mb.disabled = true;   // nothing to mute
  }
}

function onStartClick(){ return startEngine(); }

export function live(){
  // Tear down anything left running; go immersive; arm a one-shot teardown for navigate-away.
  stopAgent(); engine.stop();
  document.body.classList.add('live-immersive');
  // Replace any prior leave handler so re-entering /live can't stack listeners.
  if (leaveHandler) window.removeEventListener('hashchange', leaveHandler);
  leaveHandler = function leave(){
    if (location.hash.replace(/^#/, '') !== '/live'){
      stopAgent(); engine.stop();
      document.body.classList.remove('live-immersive');
      window.removeEventListener('hashchange', leave);
      leaveHandler = null;
    }
  };
  window.addEventListener('hashchange', leaveHandler);

  queueMicrotask(() => {
    const wire = (id, fn) => { const el = byId(id); if (el) el.addEventListener('click', fn); };
    wire('lv-end', finishInterview);
    wire('lv-start', onStartClick);
    wire('lv-mute', toggleMute);
    wire('lv-cam', toggleCamera);
    wire('lv-exit', exitInterview);
    wire('lv-tx-btn', toggleTranscript);
    wire('lv-tx-close', toggleTranscript);
    wire('lv-stats-btn', toggleStats);
    wire('lv-stats-close', toggleStats);
    wire('lv-book-close', toggleBook);

    // Editable book title — click to rename
    const titleSpan = byId('bk-title');
    if (titleSpan) {
      titleSpan.addEventListener('click', (e) => {
        e.stopPropagation();
        const inp = document.createElement('input');
        inp.className = 'bk-title-input';
        inp.value = bookTitle;
        inp.maxLength = 60;
        titleSpan.replaceWith(inp);
        inp.focus(); inp.select();
        const commit = () => {
          bookTitle = inp.value.trim() || bookTitle;
          const sp = document.createElement('span');
          sp.id = 'bk-title'; sp.className = 'bk-title'; sp.title = 'Click to rename';
          sp.textContent = bookTitle;
          inp.replaceWith(sp);
        };
        inp.addEventListener('blur', commit);
        inp.addEventListener('keydown', (ev) => {
          if (ev.key === 'Enter') { ev.preventDefault(); commit(); }
          if (ev.key === 'Escape') { inp.value = bookTitle; commit(); }
        });
      });
    }

    // Drag-to-move for the book overlay
    const drag = byId('lv-book-drag');
    if (drag) {
      drag.addEventListener('mousedown', e => {
        const bk = byId('lv-book');
        if (!bk) return;
        bookDragging = true;
        const rect = bk.getBoundingClientRect();
        bookDragOrigin = { mx: e.clientX, my: e.clientY, bx: rect.left, by: rect.top };
        e.preventDefault();
      });
    }
    document.addEventListener('mousemove', e => {
      if (!bookDragging) return;
      const bk = byId('lv-book');
      if (!bk) return;
      bk.style.left   = (bookDragOrigin.bx + e.clientX - bookDragOrigin.mx) + 'px';
      bk.style.top    = (bookDragOrigin.by + e.clientY - bookDragOrigin.my) + 'px';
      bk.style.right  = 'auto';
      bk.style.bottom = 'auto';
    });
    document.addEventListener('mouseup', () => { bookDragging = false; });

    startEngine();   // auto-start: the user already pressed "Start session" on /practice-interview
  });

  return '' +
  '<div class="live-imm" id="live-imm">' +
    '<canvas id="lv-canvas"></canvas>' +
    '<div class="li-camoff"><span>Camera off</span></div>' +
    '<div class="li-top">' +
      '<div class="li-left">' +
        '<button class="li-pill ghost" id="lv-exit" type="button">← Exit</button>' +
        '<span class="li-pill live"><span class="dot"></span> <span id="lv-time">00:00</span></span>' +
        '<span class="li-pill" id="lv-voice">—</span>' +
        '<span id="lv-state" style="display:none"></span>' +
      '</div>' +
      '<div class="li-right">' +
        '<button class="li-pill ghost" id="lv-stats-btn" type="button" data-gesture-btn>Stats</button>' +
        '<button class="li-pill ghost" id="lv-tx-btn" type="button" data-gesture-btn>Transcript</button>' +
        '<span class="li-book-hint" title="Hold Open Palm (✋) to open/close notebook">📒 ✋ hold</span>' +
      '</div>' +
    '</div>' +
    '<div class="li-ai" id="lv-ai">' +
      '<div class="ava">AI<span class="ring"></span></div>' +
      '<div class="ainame"><span class="dot"></span> Interviewer · <span id="lv-ai-state">listening</span></div>' +
    '</div>' +
    '<div class="li-cap" id="lv-cap"></div>' +
    '<div class="li-controls" id="lv-controls" style="display:none">' +
      '<button class="li-ctrl" id="lv-mute" type="button" title="Mute" aria-label="Mute" data-gesture-btn>' + MIC_SVG + '</button>' +
      '<button class="li-ctrl" id="lv-cam" type="button" title="Turn camera off" aria-label="Camera" data-gesture-btn>' + CAM_SVG + '</button>' +
      '<button class="li-ctrl end" id="lv-end" type="button" data-gesture-btn data-gesture-dwell="2500">End interview</button>' +
    '</div>' +
    '<aside class="li-stats" id="lv-stats">' +
      '<div class="li-st-head">' +
        '<h3>Live stats</h3>' +
        '<button class="li-tx-close" id="lv-stats-close" type="button" aria-label="Close" data-gesture-btn>✕</button>' +
      '</div>' +
      '<div class="lv-section">' +
        '<div class="lv-sec-lbl">Presence</div>' +
        '<div class="lv-score-grid">' +
          '<div class="lv-score-card"><div class="lv-score-num" id="lm-att">—</div><div class="lv-score-lbl">Attention</div><div class="lv-score-bar"><i id="lm-att-bar"></i></div></div>' +
          '<div class="lv-score-card"><div class="lv-score-num" id="lm-comp">—</div><div class="lv-score-lbl">Composure</div><div class="lv-score-bar"><i id="lm-comp-bar"></i></div></div>' +
          '<div class="lv-score-card"><div class="lv-score-num" id="lm-eye">—</div><div class="lv-score-lbl">Eye contact</div><div class="lv-score-bar"><i id="lm-eye-bar"></i></div></div>' +
        '</div>' +
      '</div>' +
      '<div class="lv-section">' +
        '<div class="lv-expr-head">' +
          '<span class="lv-sec-lbl">Expression</span>' +
          '<div class="lv-dom-chip"><span class="lv-dom-name" id="lm-emo-dom">—</span><span class="lv-dom-pct" id="lm-emo-pct"></span></div>' +
        '</div>' +
        '<div id="lm-emo-bars"></div>' +
      '</div>' +
      '<div class="lv-section">' +
        '<div class="lv-sec-lbl">FACS signals</div>' +
        '<div id="lm-facs-bars"></div>' +
      '</div>' +
      '<div class="lv-section">' +
        '<div class="lv-sec-lbl">Speaking pace</div>' +
        '<div class="lv-wpm-row"><span class="lv-wpm-num" id="lm-wpm">—</span><span class="lv-wpm-unit">wpm</span></div>' +
      '</div>' +
    '</aside>' +
    '<div class="li-ph" id="lv-ph"><span class="li-spin" id="lv-spin"></span><span id="lv-ph-txt">Loading model…</span><div class="lv-steps" id="lv-steps" style="display:none"></div></div>' +
    '<button class="li-start" id="lv-start" type="button" style="display:none">Start</button>' +
    '<aside class="li-transcript" id="lv-transcript">' +
      '<div class="li-tx-head"><h3>Conversation</h3><button class="li-tx-close" id="lv-tx-close" type="button" aria-label="Close" data-gesture-btn>✕</button></div>' +
      '<div class="convo" id="lv-convo"><div class="fa-note">The interviewer will greet you when the connection is ready…</div></div>' +
    '</aside>' +
  '</div>' +
  // ── Interactive Book overlay ────────────────────────────────────────────
  '<div id="lv-book" class="lv-book" style="display:none">' +
    '<div id="lv-book-drag" class="bk-drag">' +
      '<span class="bk-drag-grip" aria-hidden="true">⠿</span>' +
      '<span id="bk-title" class="bk-title" title="Click to rename">Interview Notes</span>' +
    '</div>' +
    '<div class="bk-head">' +
      '<span id="bk-pagenum" class="bk-page-info">Pages 1–2 of 10</span>' +
      '<button id="lv-book-close" class="bk-close-btn" type="button" data-gesture-btn>Close</button>' +
    '</div>' +
    '<div class="bk-spread">' +
      '<div id="bk-left" class="bk-page"></div>' +
      '<div class="bk-spine-divider"></div>' +
      '<div id="bk-right" class="bk-page"></div>' +
    '</div>' +
    '<div class="bk-footer">' +
      '<span>← prev</span>' +
      '<span>next →</span>' +
    '</div>' +
  '</div>' +
  '<div id="lv-cursor" class="lv-cursor"></div>';
}
