import * as engine from '../interview-engine.js';
import { startVoiceAgent } from '../deepgram-client.js';
import { getInterviewConfig } from '../interview-config.js';
import { api } from '../api.js';
import { esc } from '../util.js';
import { startRecording } from '../audio-recorder.js';
import { computeAcousticFeatures } from '../acoustic-features.js';

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
let muted = false;         // mic muted?
let camOn = true;          // camera on?
let leaveHandler = null;   // active hashchange teardown listener, so re-entry can't stack them

const MIC_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="2" width="6" height="12" rx="3"></rect><path d="M5 10v2a7 7 0 0 0 14 0v-2"></path><line x1="12" y1="19" x2="12" y2="22"></line><line x1="8" y1="22" x2="16" y2="22"></line></svg>';
const CAM_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 7l-7 5 7 5V7z"></path><rect x="1" y="5" width="15" height="14" rx="2"></rect></svg>';

function fmtTime(ms){ const s = Math.max(0, Math.floor(ms / 1000)); return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0'); }
function byId(id){ return document.getElementById(id); }
function setText(id, v){ const el = byId(id); if (el) el.textContent = v; }
function setState(t){ setText('lv-state', t); }
function setVoice(t){ setText('lv-voice', t); }
function showControls(on){ const c = byId('lv-controls'); if (c) c.style.display = on ? 'flex' : 'none'; }
function overlay(text){ const ph = byId('lv-ph'); if (ph){ ph.style.display = text ? 'grid' : 'none'; if (text) ph.textContent = text; } }
function showStart(label){ const b = byId('lv-start'); if (b){ b.style.display = label ? '' : 'none'; if (label) b.textContent = label; } }

function onStats(s){ setText('lv-time', fmtTime(s.elapsedMs)); }

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
    const tok = await api.interviewToken({ role: cfg.role, focus: cfg.focus, difficulty: cfg.difficulty, question_count: cfg.questionCount });
    const stream = engine.getStream();
    if (!stream || !engine.isRunning()) return;   // stopped / navigated away during the token fetch
    agent = startVoiceAgent({
      url: tok.url, token: tok.token, scheme: tok.scheme, config: tok.config,
      micStream: stream,
      onTranscript,
      onSpeaking: onAiSpeaking,
      onError: (m) => setVoice('Voice error: ' + m),
      onClose: () => { if (engine.isRunning()) finishInterview(); },
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
  if (!window.confirm('Leave without scoring? Your interview won’t be saved.')) return;
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
  overlay('Scoring your interview…'); showControls(false); showStart(null);
  try {
    const resp = await api.createSession(payload);
    pendingScore = null;
    location.hash = '#/session/' + resp.session_id;   // open the existing report screen
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
  const frames = engine.getFrames().slice();   // copy before stop() releases it
  const rec = recorder; recorder = null;
  stopAgent();
  const audio = rec ? await rec.stop() : null;   // finalize the recording before we drop the stream
  engine.stop();
  showControls(false); overlay('Processing…'); setState('Processing…'); setVoice('—');

  if (!frames.length){
    overlay('Nothing to score.'); showStart('Start');
    return;
  }

  // Voice (Delivery) analysis — non-fatal; a failure just omits the Delivery signal.
  let voice = null;
  if (audio && audio.blob){
    overlay('Analyzing your voice…');
    const acoustic = await computeAcousticFeatures(audio.blob);
    voice = await api.analyzeVoice(audio.blob, acoustic || {});
  }

  const full_text = segments
    .map((s) => (s.speaker === 'interviewer' ? 'INTERVIEWER: ' : 'CANDIDATE: ') + s.text)
    .join('\n');
  await submitScore({ role, frames, transcript: { full_text, segments }, events, emotion: null, voice });
}

function resetConvo(){
  convoCount = 0;
  const cap = byId('lv-cap'); if (cap){ cap.className = 'li-cap'; cap.innerHTML = ''; }
  const convo = byId('lv-convo'); if (convo) convo.innerHTML = '<div class="fa-note">The interviewer will greet you when the connection is ready…</div>';
  const panel = byId('lv-transcript'); if (panel) panel.classList.remove('open');
  onAiSpeaking(false);
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
  pendingScore = null; role = getInterviewConfig().role; recorder = null;
  muted = false; camOn = true;
  const imm = byId('live-imm'); if (imm) imm.classList.remove('cam-off');
  const mb = byId('lv-mute'); if (mb){ mb.classList.remove('off'); mb.disabled = false; }
  const cb = byId('lv-cam'); if (cb) cb.classList.remove('off');
  resetConvo();
  overlay('Loading model…'); showControls(false); showStart(null);
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
    startEngine();   // auto-start: the user already pressed "Start interview" on /new
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
    '<div class="li-ph" id="lv-ph">Loading model…</div>' +
    '<button class="li-start" id="lv-start" type="button" style="display:none">Start</button>' +
    '<aside class="li-transcript" id="lv-transcript">' +
      '<div class="li-tx-head"><h3>Conversation</h3><button class="li-tx-close" id="lv-tx-close" type="button" aria-label="Close">✕</button></div>' +
      '<div class="convo" id="lv-convo"><div class="fa-note">The interviewer will greet you when the connection is ready…</div></div>' +
    '</aside>' +
  '</div>';
}
