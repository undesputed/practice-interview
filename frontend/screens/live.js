import * as engine from '../interview-engine.js';
import { startVoiceAgent } from '../deepgram-client.js';
import { getInterviewConfig } from '../interview-config.js';
import { api } from '../api.js';
import { esc } from '../util.js';
import { startRecording } from '../audio-recorder.js';
import { computeAcousticFeatures } from '../acoustic-features.js';
import { computeLiveMetrics } from '../live-metrics.js';
import { emotionScores, dominantEmotion } from '../emotion.js';

let agent = null;          // active Deepgram voice agent, or null
let convoCount = 0;        // conversation lines seen this run
let turn = -1;             // interview question index; advances on each interviewer line
let segments = [];         // { speaker, text, t } transcript lines
let events = [];           // action events captured for the report
let startTs = 0;           // performance.now() at start, for segment timestamps
let finishing = false;     // guard so End + agent-close don't double-submit; stays true
                           // through score retries (retry re-POSTs via submitScore, never
                           // restarts the engine), so we never reset it after finishInterview
let pendingScore = null;   // payload from a failed score POST, kept for retry
let recorder = null;       // active audio recorder handle, or null
let role = '';             // interview role captured at start
let scenario = 'job';     // interview scenario captured at start
let muted = false;         // mic muted?
let camOn = true;          // camera on?
let leaveHandler = null;   // active hashchange teardown listener, so re-entry can't stack them
let metricsInterval = null;

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
    const att = byId('lm-att'); if (att) att.textContent = m.attention;
    const comp = byId('lm-comp'); if (comp) comp.textContent = m.composure;
    const eye = byId('lm-eye'); if (eye) eye.textContent = m.eyeContact + '%';
  }

  const latest = allFrames[allFrames.length - 1];
  const bs = (latest && latest.bs) || {};

  const dom = dominantEmotion(bs);
  const domEl = byId('lm-emo-dom');
  if (domEl) domEl.textContent = (dom && dom.emotion) ? dom.emotion : '—';

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
    });
    const stream = engine.getStream();
    if (!stream || !engine.isRunning()) return;   // stopped / navigated away during the token fetch
    agent = startVoiceAgent({
      url: tok.url, token: tok.token, scheme: tok.scheme, config: tok.config,
      micStream: stream,
      onTranscript,
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

function clearImmersive(){ document.body.classList.remove('live-immersive'); }

// Leave WITHOUT scoring (confirm first). Tears down and returns to the dashboard.
function exitInterview(){
  if (!window.confirm(‘Leave without scoring? Your interview won’t be saved.’)) return;
  stopMetrics();
  stopAgent();
  if (recorder && recorder.stop){ try { recorder.stop(); } catch (_){} }
  recorder = null;
  engine.stop();
  clearImmersive();
  location.hash = '#/';
}

// POST a captured interview and open its report. On failure, keep the payload so
// the user can retry (the start button becomes "Retry scoring") without data loss.
async function submitScore(payload){
  setState('Processing…'); setVoice('Scoring…');
  loading('Scoring your interview…'); showControls(false); showStart(null);
  try {
    const resp = await api.createSession(payload);
    pendingScore = null;
    location.hash = '#/thanks/' + resp.session_id;   // thank-you page; results via its button or Progress
  } catch (e){
    pendingScore = payload;
    setState('Error'); setVoice('—');
    overlay('Couldn’t score the interview.');
    showStart('Retry scoring');
  }
}

// End the interview: stop, score, open the report. Grabs frames before teardown
// (engine.stop() releases the session). Idempotent via the `finishing` guard.
async function finishInterview(){
  if (finishing) return;
  finishing = true;
  stopMetrics();
  // Show the loading state immediately, before tearing down / awaiting the recorder.
  showControls(false); loading('Processing…'); setState('Processing…'); setVoice('—');
  const frames = engine.getFrames().slice();   // copy before stop() releases it
  const rec = recorder; recorder = null;
  stopAgent();
  const audio = rec ? await rec.stop() : null;   // finalize the recording before we drop the stream
  engine.stop();

  if (!frames.length){
    overlay('Nothing to score.'); showStart('Start');
    return;
  }

  // Voice (Delivery) analysis — non-fatal; a failure just omits the Delivery signal.
  let voice = null;
  if (audio && audio.blob){
    loading('Analyzing your voice…');
    const acoustic = await computeAcousticFeatures(audio.blob);
    voice = await api.analyzeVoice(audio.blob, acoustic || {});
  }

  const full_text = segments
    .map((s) => (s.speaker === 'interviewer' ? 'INTERVIEWER: ' : 'CANDIDATE: ') + s.text)
    .join('\n');
  await submitScore({ scenario, role, frames, transcript: { full_text, segments }, events, emotion: null, voice });
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
  pendingScore = null; role = getInterviewConfig().role;
  scenario = getInterviewConfig().scenario || 'job'; recorder = null;
  muted = false; camOn = true;
  const imm = byId('live-imm'); if (imm) imm.classList.remove('cam-off');
  const mb = byId('lv-mute'); if (mb){ mb.classList.remove('off'); mb.disabled = false; }
  const cb = byId('lv-cam'); if (cb) cb.classList.remove('off');
  resetConvo();
  loading('Loading model…'); showControls(false); showStart(null);
  setState('Starting…'); setVoice('—');

  // Try camera + mic; fall back to vision-only if the mic is blocked.
  let micOk = true;
  try {
    await engine.start(canvas, { onStats, onAction, showOverlay: false, audio: true });
  } catch (e){
    micOk = false;
    try { await engine.start(canvas, { onStats, onAction, showOverlay: false, audio: false }); }
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

// Start/Retry button: re-submit a failed score if pending, else start fresh.
function onStartClick(){ return pendingScore ? submitScore(pendingScore) : startEngine(); }

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
        '<button class="li-pill ghost" id="lv-stats-btn" type="button">Stats</button>' +
        '<button class="li-pill ghost" id="lv-tx-btn" type="button">Transcript</button>' +
      '</div>' +
    '</div>' +
    '<div class="li-ai" id="lv-ai">' +
      '<div class="ava">AI<span class="ring"></span></div>' +
      '<div class="ainame"><span class="dot"></span> Interviewer · <span id="lv-ai-state">listening</span></div>' +
    '</div>' +
    '<div class="li-cap" id="lv-cap"></div>' +
    '<div class="li-controls" id="lv-controls" style="display:none">' +
      '<button class="li-ctrl" id="lv-mute" type="button" title="Mute" aria-label="Mute">' + MIC_SVG + '</button>' +
      '<button class="li-ctrl" id="lv-cam" type="button" title="Turn camera off" aria-label="Camera">' + CAM_SVG + '</button>' +
      '<button class="li-ctrl end" id="lv-end" type="button">End interview</button>' +
    '</div>' +
    '<aside class="li-stats" id="lv-stats">' +
      '<div class="li-st-head">' +
        '<h3>Live stats</h3>' +
        '<button class="li-tx-close" id="lv-stats-close" type="button" aria-label="Close">✕</button>' +
      '</div>' +
      '<div class="lv-section">' +
        '<div class="lv-sec-lbl">Presence</div>' +
        '<div class="lv-score-grid">' +
          '<div class="lv-score-card"><div class="lv-score-num" id="lm-att">—</div><div class="lv-score-lbl">Attention</div></div>' +
          '<div class="lv-score-card"><div class="lv-score-num" id="lm-comp">—</div><div class="lv-score-lbl">Composure</div></div>' +
          '<div class="lv-score-card"><div class="lv-score-num" id="lm-eye">—</div><div class="lv-score-lbl">Eye contact</div></div>' +
        '</div>' +
      '</div>' +
      '<div class="lv-section">' +
        '<div class="lv-sec-lbl">Expression · <span id="lm-emo-dom">—</span></div>' +
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
    '<div class="li-ph" id="lv-ph"><span class="li-spin" id="lv-spin"></span><span id="lv-ph-txt">Loading model…</span></div>' +
    '<button class="li-start" id="lv-start" type="button" style="display:none">Start</button>' +
    '<aside class="li-transcript" id="lv-transcript">' +
      '<div class="li-tx-head"><h3>Conversation</h3><button class="li-tx-close" id="lv-tx-close" type="button" aria-label="Close">✕</button></div>' +
      '<div class="convo" id="lv-convo"><div class="fa-note">The interviewer will greet you when the connection is ready…</div></div>' +
    '</aside>' +
  '</div>';
}
