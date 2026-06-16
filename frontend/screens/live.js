import * as engine from '../interview-engine.js';
import { startVoiceAgent } from '../deepgram-client.js';
import { getInterviewConfig } from '../interview-config.js';
import { api } from '../api.js';
import { esc } from '../util.js';

let agent = null;     // active Deepgram voice agent, or null
let feedCount = 0;    // actions seen this run (0 until the first one, to clear the note)
let convoCount = 0;   // conversation lines seen this run
let turn = -1;        // interview question index; advances on each interviewer line
let segments = [];    // { speaker, text, t } transcript lines, in order
let events = [];      // action events (nods, smiles, gestures) from the engine
let startTs = 0;      // performance.now() at interview start, for segment timestamps
let finishing = false; // guard so Stop + agent-close don't double-submit

// mm:ss from milliseconds since the interview started.
function fmtTime(ms){
  const s = Math.max(0, Math.floor(ms / 1000));
  return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
}

function setText(id, v){ const el = document.getElementById(id); if (el) el.textContent = v; }
function setState(text){ setText('lv-state', text); }
function setVoice(text){ setText('lv-voice', text); }

function onStats(s){
  setText('lv-time', fmtTime(s.elapsedMs));
  setText('lv-face', s.face ? 'visible ✓' : 'not found ✗');
  setText('lv-fps', s.fps);
  setText('lv-det', s.detections);
}

function onAction(ev){
  const feed = document.getElementById('lv-feed');
  if (!feed) return;
  if (!feedCount) feed.innerHTML = '';   // drop the "waiting…" note on the first real action
  feedCount++;
  events.push(ev);
  const row = document.createElement('div');
  row.className = 'live-act';
  row.innerHTML = '<span class="t">' + fmtTime(ev.t) + '</span>' +
    '<span class="ic">' + esc(ev.icon || '•') + '</span>' +
    '<span class="lb">' + esc(ev.label || ev.kind || 'Action') + '</span>';
  feed.appendChild(row);
  feed.scrollTop = feed.scrollHeight;
  while (feed.children.length > 200) feed.removeChild(feed.firstChild);
}

// One line of the AI ↔ candidate conversation (from the Deepgram voice agent).
function onTranscript({ speaker, text }){
  if (speaker === 'interviewer'){ turn += 1; engine.setTurn(turn); }   // matches questions_from_transcript
  segments.push({ speaker, text, t: performance.now() - startTs });
  const box = document.getElementById('lv-convo');
  if (!box) return;
  if (!convoCount) box.innerHTML = '';
  convoCount++;
  const line = document.createElement('div');
  line.className = 'line ' + (speaker === 'interviewer' ? 'interviewer' : 'candidate');
  line.innerHTML = '<span class="who">' + (speaker === 'interviewer' ? 'Interviewer' : 'You') + '</span>' + esc(text);
  box.appendChild(line);
  box.scrollTop = box.scrollHeight;
}

// Start the Claude-powered voice agent using the New-interview settings + the engine's mic.
// A failure here is non-fatal: the camera + MediaPipe analysis keep running.
async function startAgent(){
  const cfg = getInterviewConfig();
  setVoice('Connecting…');
  try {
    const tok = await api.interviewToken({
      role: cfg.role, focus: cfg.focus, difficulty: cfg.difficulty, question_count: cfg.questionCount,
    });
    const stream = engine.getStream();
    if (!stream || !engine.isRunning()) return;   // stopped / navigated away during the token fetch
    agent = startVoiceAgent({
      url: tok.url, token: tok.token, scheme: tok.scheme, config: tok.config,
      micStream: stream,
      onTranscript,
      onError: (m) => setVoice('Voice error: ' + m),
      onClose: () => { if (engine.isRunning()) finishInterview(); },
    });
    setVoice('Live');
  } catch (e){
    setVoice('Voice unavailable: ' + (e && e.message ? e.message : e));
  }
}

function stopAgent(){
  if (agent){ try { agent.stop(); } catch (_){} agent = null; }
}

// End the interview, score it, and open its report. Grabs frames before teardown
// because engine.stop() releases the session. Idempotent via the `finishing` guard.
async function finishInterview(){
  if (finishing) return;
  finishing = true;
  const frames = engine.getFrames().slice();   // copy before stop() releases it
  stopAgent();
  engine.stop();
  setState('Processing…'); setVoice('Scoring your interview…');
  const live = document.getElementById('lv-live'); if (live) live.classList.remove('on');
  const stopBtn = document.getElementById('lv-stop'); if (stopBtn) stopBtn.style.display = 'none';

  if (!frames.length){
    // Nothing was captured (e.g. camera never started) — go back to a startable state.
    setState('Stopped'); setVoice('Nothing to score');
    const startBtn = document.getElementById('lv-start');
    if (startBtn){ startBtn.style.display = ''; startBtn.textContent = 'Start'; }
    return;
  }

  const full_text = segments
    .map((s) => (s.speaker === 'interviewer' ? 'INTERVIEWER: ' : 'CANDIDATE: ') + s.text)
    .join('\n');
  try {
    const resp = await api.createSession({
      role: getInterviewConfig().role,
      frames,
      transcript: { full_text, segments },
      events,
      emotion: null,
    });
    location.hash = '#/session/' + resp.session_id;   // open the existing report screen
  } catch (e){
    setState('Error'); setVoice('Could not score: ' + (e && e.message ? e.message : e));
    const startBtn = document.getElementById('lv-start');
    if (startBtn){ startBtn.style.display = ''; startBtn.textContent = 'Retry'; }
  }
}

function resetPanels(){
  const feed = document.getElementById('lv-feed');
  if (feed) feed.innerHTML = '<div class="fa-note">Waiting for the first action…</div>';
  const convo = document.getElementById('lv-convo');
  if (convo) convo.innerHTML = '<div class="fa-note">The interviewer will greet you when the connection is ready…</div>';
}

function cameraError(e){
  const ph = document.getElementById('lv-ph');
  if (ph){ ph.style.display = ''; ph.textContent = 'Camera unavailable: ' + (e && e.message ? e.message : e); }
  const live = document.getElementById('lv-live'); if (live) live.classList.remove('on');
  setState('Error'); setVoice('—');
  const stopBtn = document.getElementById('lv-stop'); if (stopBtn) stopBtn.style.display = 'none';
  const startBtn = document.getElementById('lv-start');
  if (startBtn){ startBtn.style.display = ''; startBtn.textContent = 'Retry'; }
}

async function startEngine(){
  const canvas = document.getElementById('lv-canvas');
  if (!canvas) return;
  const ph = document.getElementById('lv-ph');
  const live = document.getElementById('lv-live');
  const startBtn = document.getElementById('lv-start');
  const stopBtn = document.getElementById('lv-stop');

  feedCount = 0; convoCount = 0; turn = -1;
  segments = []; events = []; startTs = performance.now(); finishing = false;
  resetPanels();
  if (ph){ ph.style.display = ''; ph.textContent = 'Loading model…'; }
  setState('Starting…'); setVoice('—');
  if (startBtn) startBtn.style.display = 'none';
  if (stopBtn){ stopBtn.style.display = ''; stopBtn.disabled = false; }

  // Try camera + mic. If that's rejected, retry vision-only so the analysis still works
  // when only the microphone is blocked; if even that fails, the camera is unavailable.
  let micOk = true;
  try {
    await engine.start(canvas, { onStats, onAction, showOverlay: false, audio: true });
  } catch (e){
    micOk = false;
    try {
      await engine.start(canvas, { onStats, onAction, showOverlay: false, audio: false });
    } catch (e2){
      cameraError(e2); return;
    }
  }
  if (!engine.isRunning()) return;   // superseded (navigated away or restarted mid-load)
  if (ph) ph.style.display = 'none';
  if (live) live.classList.add('on');
  setState('Detecting');
  if (micOk) startAgent();
  else setVoice('Mic unavailable — analysis only');
}


export function live(){
  // Tear down anything left running, then arm a one-shot teardown for navigate-away.
  stopAgent(); engine.stop();
  window.addEventListener('hashchange', function leave(){
    if (location.hash.replace(/^#/, '') !== '/live'){
      stopAgent(); engine.stop();
      window.removeEventListener('hashchange', leave);
    }
  });

  queueMicrotask(() => {
    const startBtn = document.getElementById('lv-start');
    const stopBtn = document.getElementById('lv-stop');
    if (startBtn) startBtn.addEventListener('click', startEngine);
    if (stopBtn) stopBtn.addEventListener('click', finishInterview);
    startEngine();   // auto-start: the user already pressed "Start interview" on /new
  });

  return '<div class="screen"><div class="screen-head"><h1>Live interview</h1>' +
    '<span class="muted" style="font-size:12px">video stays on your device · audio drives the AI interviewer · nothing saved yet</span></div>' +
    '<div id="live-body"><div class="fa-grid">' +
      '<div class="fa-rail">' +
        '<div class="lab">Status</div>' +
        '<div class="fa-stat"><span>State</span><b id="lv-state">Starting…</b></div>' +
        '<div class="fa-stat"><span>Voice</span><b id="lv-voice">—</b></div>' +
        '<div class="fa-stat"><span>Elapsed</span><b id="lv-time">00:00</b></div>' +
        '<div class="fa-stat"><span>Face</span><b id="lv-face">—</b></div>' +
        '<div class="fa-stat"><span>FPS</span><b id="lv-fps">0</b></div>' +
        '<div class="fa-stat"><span>Detections</span><b id="lv-det">0</b></div>' +
        '<button class="fa-btn stop" id="lv-stop">Stop</button>' +
        '<button class="fa-btn start" id="lv-start" style="display:none">Start</button>' +
      '</div>' +
      '<div>' +
        '<div class="fa-stage"><div class="fa-live" id="lv-live"><span class="dot"></span> LIVE</div>' +
          '<canvas id="lv-canvas"></canvas>' +
          '<div class="ph" id="lv-ph">Loading model…</div></div>' +
        '<div class="live-cols">' +
          '<div class="fa-panel"><div class="phead"><div><h3>Conversation</h3>' +
            '<div class="desc">The AI interviewer (Claude voice) and your answers, transcribed live.</div></div></div>' +
            '<div class="convo" id="lv-convo"><div class="fa-note">The interviewer will greet you when the connection is ready…</div></div></div>' +
          '<div class="fa-panel"><div class="phead"><div><h3>Live actions</h3>' +
            '<div class="desc">Nods, smiles, and gestures detected in real time by MediaPipe.</div></div></div>' +
            '<div class="live-feed" id="lv-feed"><div class="fa-note">Waiting for the first action…</div></div></div>' +
        '</div>' +
      '</div>' +
    '</div></div></div>';
}
