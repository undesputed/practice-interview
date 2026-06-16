# Live Interview UI Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the `/live` screen as an immersive, full-screen Google-Meet-style interview: full-bleed video, captions + slide-out transcript, an AI interviewer tile, a mute/camera/end control bar, sidebar hidden, and Exit-vs-End actions.

**Architecture:** Add three small capabilities to the existing engine/clients (mute + AI-speaking on the voice client, pause/resume on the recorder, camera on/off on the capture engine), add the immersive CSS, then rewrite the `/live` screen module to use them. All the readiness-scoring capture/score logic (frames, transcript, voice analysis, finish/retry) is preserved.

**Tech Stack:** Vanilla ES modules (no JS test runner — verified by syntax check + manual browser test), Web Audio / MediaRecorder / MediaPipe, the Clean Studio CSS tokens.

Spec: [docs/superpowers/specs/2026-06-16-live-interview-ui-redesign-design.md](2026-06-16-live-interview-ui-redesign-design.md)

---

## File Structure

- **Modify** [frontend/deepgram-client.js](../../../frontend/deepgram-client.js) — add `setMuted()` + an `onSpeaking` callback (TTS playing → speaking).
- **Modify** `frontend/audio-recorder.js` — add `pause()` / `resume()`.
- **Modify** [frontend/interview-engine.js](../../../frontend/interview-engine.js) — add `setCameraOn()` + a `paused` skip in the loop.
- **Modify** [frontend/styles/clean-studio.css](../../../frontend/styles/clean-studio.css) — append the immersive live styles + sidebar-hide rules.
- **Rewrite** [frontend/screens/live.js](../../../frontend/screens/live.js) — full-bleed markup + new controls/captions/transcript/exit/end wiring (preserving capture + scoring).

No backend changes. No JS test harness exists, so each task ends with a syntax check (`node --input-type=module --check`) and the feature is verified manually in Task 6.

---

## Task 1: Voice client — mute + AI-speaking

**Files:**
- Modify: [frontend/deepgram-client.js](../../../frontend/deepgram-client.js)

- [ ] **Step 1: Add the `onSpeaking` param**

Change the function signature line:
```javascript
export function startVoiceAgent({ url, token, scheme, config, micStream, onTranscript, onError, onClose }) {
```
to:
```javascript
export function startVoiceAgent({ url, token, scheme, config, micStream, onTranscript, onError, onClose, onSpeaking }) {
```

- [ ] **Step 2: Add mute + speaking state**

After the line `let audioChunks = 0;`, add:
```javascript
  let muted = false;
  let speaking = false;
  let silenceTimer = null;
```

- [ ] **Step 3: Skip sending audio while muted**

In `processor.onaudioprocess`, the body starts with `if (ws.readyState !== WebSocket.OPEN) return;`. Add a muted check right after it:
```javascript
      if (ws.readyState !== WebSocket.OPEN) return;
      if (muted) return;
```

- [ ] **Step 4: Flag speaking when TTS plays**

In the binary-message branch, after the line `nextStart = start + buf.duration;`, add:
```javascript
      markSpeaking();
```
Then add the `markSpeaking` helper just before the `return {` at the end of the function:
```javascript
  // The AI is "speaking" while TTS audio is queued; flips off shortly after the
  // last scheduled chunk finishes playing.
  function markSpeaking(){
    if (!speaking){ speaking = true; if (onSpeaking) onSpeaking(true); }
    clearTimeout(silenceTimer);
    const ms = Math.max(0, (nextStart - outCtx.currentTime) * 1000) + 150;
    silenceTimer = setTimeout(() => { speaking = false; if (onSpeaking) onSpeaking(false); }, ms);
  }
```

- [ ] **Step 5: Expose `setMuted` and clear the timer on stop**

Replace the returned object:
```javascript
  return {
    stop() {
      console.log("[dg] stopping agent");
      try { if (processor) processor.disconnect(); } catch (_) {}
      try { if (source) source.disconnect(); } catch (_) {}
      try { inCtx.close(); } catch (_) {}
      try { outCtx.close(); } catch (_) {}
      if (ws.readyState === WebSocket.OPEN) ws.close();
    },
  };
```
with:
```javascript
  return {
    stop() {
      console.log("[dg] stopping agent");
      clearTimeout(silenceTimer);
      try { if (processor) processor.disconnect(); } catch (_) {}
      try { if (source) source.disconnect(); } catch (_) {}
      try { inCtx.close(); } catch (_) {}
      try { outCtx.close(); } catch (_) {}
      if (ws.readyState === WebSocket.OPEN) ws.close();
    },
    setMuted(m) { muted = !!m; },
  };
```

- [ ] **Step 6: Verify + commit**

Run: `cd /Users/carrieyu/Desktop/Hipe/mediapipe-test && node --input-type=module --check < frontend/deepgram-client.js && echo SYNTAX_OK`
Expected: `SYNTAX_OK`
```bash
git add frontend/deepgram-client.js
git commit -m "feat(live): voice client mute + AI-speaking callback"
```

---

## Task 2: Recorder — pause / resume

**Files:**
- Modify: `frontend/audio-recorder.js`

- [ ] **Step 1: Add pause/resume to the handle**

In `frontend/audio-recorder.js`, the returned object currently has only `stop()`. Add `pause` and `resume` so it reads:
```javascript
  return {
    stop(){
      return new Promise((resolve) => {
        if (recorder.state === 'inactive'){ resolve(null); return; }
        recorder.onstop = () => {
          if (!chunks.length){ resolve(null); return; }
          const type = recorder.mimeType || mime || 'audio/webm';
          resolve({ blob: new Blob(chunks, { type }), mime: type });
        };
        try { recorder.stop(); } catch (_){ resolve(null); }
      });
    },
    // Pause/resume capture for the live "mute" control, so muted silence isn't
    // recorded and doesn't drag down the Delivery score.
    pause(){ try { if (recorder.state === 'recording') recorder.pause(); } catch (_){} },
    resume(){ try { if (recorder.state === 'paused') recorder.resume(); } catch (_){} },
  };
```

- [ ] **Step 2: Verify + commit**

Run: `cd /Users/carrieyu/Desktop/Hipe/mediapipe-test && node --input-type=module --check < frontend/audio-recorder.js && echo SYNTAX_OK`
Expected: `SYNTAX_OK`
```bash
git add frontend/audio-recorder.js
git commit -m "feat(live): recorder pause/resume for mute"
```

---

## Task 3: Engine — camera on/off

**Files:**
- Modify: [frontend/interview-engine.js](../../../frontend/interview-engine.js)

- [ ] **Step 1: Add a `paused` flag to the session**

In `launch()`, the session initializer has the line:
```javascript
    lastBodyTs: 0, lastStatsTs: 0, lastVideoTime: -1, frames: [],
```
Change it to:
```javascript
    lastBodyTs: 0, lastStatsTs: 0, lastVideoTime: -1, frames: [], paused: false,
```

- [ ] **Step 2: Export `setCameraOn`**

Add this exported function right after the existing `getFrames()` function:
```javascript
// Camera on/off for the live "camera" control: disables the video track (turns
// the camera light off) and pauses frame capture so we don't analyze black frames.
export function setCameraOn(on){
  if (!session) return;
  session.paused = !on;
  const track = session.stream && session.stream.getVideoTracks ? session.stream.getVideoTracks()[0] : null;
  if (track) track.enabled = !!on;
}
```

- [ ] **Step 3: Skip the loop body while paused**

In the `loop` function, right after the line `const now = performance.now();`, add (before the duplicate-frame skip):
```javascript
    // Camera toggled off — blank the canvas, skip capture, keep the loop alive.
    if (session.paused){
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      session.rafId = requestAnimationFrame(loop);
      return;
    }
```

- [ ] **Step 4: Verify + commit**

Run: `cd /Users/carrieyu/Desktop/Hipe/mediapipe-test && node --input-type=module --check < frontend/interview-engine.js && echo SYNTAX_OK`
Expected: `SYNTAX_OK`
```bash
git add frontend/interview-engine.js
git commit -m "feat(live): engine camera on/off (pause frame capture)"
```

---

## Task 4: Immersive CSS

**Files:**
- Modify: [frontend/styles/clean-studio.css](../../../frontend/styles/clean-studio.css)

- [ ] **Step 1: Append the immersive live styles**

Append this block to the END of `frontend/styles/clean-studio.css` (it reuses existing tokens like `--stage`, `--brand`, `--risk`, `--good`, `--surface`, `--r-pill`, and the existing `.convo` bubble styles for the transcript):
```css

/* ---- Immersive live interview (Option B) ---- */
body.live-immersive .app-shell{grid-template-columns:1fr}
body.live-immersive .sidebar{display:none}
body.live-immersive .content{padding:0}

.live-imm{position:relative;width:100%;height:100vh;height:100dvh;background:var(--stage);overflow:hidden;color:#fff}
.live-imm canvas{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;transform:scaleX(-1);display:block}

.li-camoff{position:absolute;inset:0;display:none;place-items:center;background:#0c1411;color:rgba(255,255,255,.55);font-size:15px;z-index:1}
.live-imm.cam-off .li-camoff{display:grid}

.li-top{position:absolute;top:16px;left:16px;right:16px;display:flex;justify-content:space-between;align-items:flex-start;gap:8px;z-index:4}
.li-left{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.li-pill{display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:700;padding:6px 11px;border-radius:var(--r-pill);background:rgba(0,0,0,.45);color:#fff;border:none;font-family:inherit}
.li-pill.ghost{background:rgba(255,255,255,.88);color:#16201b;cursor:pointer}
.li-pill.live{background:var(--brand)}
.li-pill .dot{width:7px;height:7px;border-radius:50%;background:#fff;animation:liblink 1.4s ease-in-out infinite}
@keyframes liblink{0%,100%{opacity:1}50%{opacity:.35}}

.li-cap{position:absolute;left:50%;bottom:96px;transform:translateX(-50%) translateY(8px);max-width:70%;
  background:rgba(0,0,0,.55);color:#fff;border-radius:14px;padding:11px 18px;font-size:14px;line-height:1.45;text-align:center;
  opacity:0;transition:opacity .25s,transform .25s;z-index:3;pointer-events:none}
.li-cap.show{opacity:1;transform:translateX(-50%) translateY(0)}
.li-cap .who{display:block;font-size:9.5px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;opacity:.7;margin-bottom:3px}

.li-controls{position:absolute;left:50%;bottom:22px;transform:translateX(-50%);display:flex;gap:14px;align-items:center;z-index:5}
.li-ctrl{position:relative;width:46px;height:46px;border-radius:50%;border:none;display:grid;place-items:center;
  background:rgba(255,255,255,.92);color:#16201b;cursor:pointer;box-shadow:0 2px 10px rgba(0,0,0,.25)}
.li-ctrl svg{width:21px;height:21px}
.li-ctrl:disabled{opacity:.45;cursor:not-allowed}
.li-ctrl.off{background:var(--risk);color:#fff}
.li-ctrl.off::after{content:"";position:absolute;width:28px;height:2.5px;border-radius:2px;background:#fff;transform:rotate(-45deg)}
.li-ctrl.end{width:auto;border-radius:var(--r-pill);padding:0 20px;height:46px;background:var(--risk);color:#fff;font-weight:700;font-size:13.5px}

.li-ai{position:absolute;right:16px;bottom:92px;width:164px;height:108px;border-radius:14px;overflow:hidden;z-index:4;
  background:#19221c;border:1px solid rgba(255,255,255,.14);box-shadow:0 6px 20px rgba(0,0,0,.35);display:grid;place-items:center}
.li-ai .ava{position:relative;width:56px;height:56px;border-radius:50%;display:grid;place-items:center;color:#fff;font-weight:800;font-size:20px;background:linear-gradient(135deg,var(--brand-2),var(--brand))}
.li-ai .ava .ring{position:absolute;inset:-6px;border-radius:50%;border:2px solid var(--good);opacity:0}
.li-ai.speaking .ava .ring{animation:liring 1.4s ease-out infinite}
@keyframes liring{0%{transform:scale(.9);opacity:.9}100%{transform:scale(1.4);opacity:0}}
.li-ai .ainame{position:absolute;left:8px;bottom:7px;display:flex;align-items:center;gap:5px;font-size:10px;font-weight:700;color:#fff;background:rgba(0,0,0,.45);padding:2px 8px;border-radius:var(--r-pill)}
.li-ai .ainame .dot{width:6px;height:6px;border-radius:50%;background:var(--good)}

.li-ph{position:absolute;inset:0;display:grid;place-items:center;text-align:center;padding:0 24px;
  color:rgba(255,255,255,.88);font-size:14px;background:rgba(8,12,10,.55);z-index:6}
.li-start{position:absolute;left:50%;top:58%;transform:translateX(-50%);z-index:7;display:none;
  background:var(--brand);color:#fff;border:none;border-radius:var(--r-pill);padding:11px 22px;font-weight:700;font-size:13.5px;font-family:inherit;cursor:pointer}

.li-transcript{position:absolute;top:0;right:0;bottom:0;width:min(420px,46%);z-index:8;
  background:var(--surface);color:var(--ink);border-left:1px solid var(--line);
  transform:translateX(100%);transition:transform .25s ease;display:flex;flex-direction:column;padding:16px}
.li-transcript.open{transform:none}
.li-tx-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px}
.li-tx-head h3{font-size:15px;font-weight:700;font-family:var(--font-display)}
.li-tx-close{background:none;border:none;font-size:16px;cursor:pointer;color:var(--ink-2);font-family:inherit}
.li-transcript .convo{max-height:none;height:auto;flex:1;overflow:auto}

@media(max-width:640px){
  .li-ai{width:120px;height:80px;bottom:84px}
  .li-cap{max-width:86%;bottom:86px}
  .li-transcript{width:100%}
}
```

- [ ] **Step 2: Sanity-check braces + commit**

Run: `cd /Users/carrieyu/Desktop/Hipe/mediapipe-test && awk '{o+=gsub(/{/,"{"); c+=gsub(/}/,"}")} END{print "open="o" close="c}' frontend/styles/clean-studio.css`
Expected: `open` equals `close` (balanced braces).
```bash
git add frontend/styles/clean-studio.css
git commit -m "style(live): immersive interview layout + sidebar hide"
```

---

## Task 5: Rewrite the `/live` screen

**Files:**
- Rewrite: [frontend/screens/live.js](../../../frontend/screens/live.js)

This replaces the whole file. It keeps all capture/scoring logic (frames via `engine.getFrames()`, transcript `segments`, action `events`, voice analysis, `finishInterview`/`submitScore`/retry) and adds: immersive markup, captions, slide-out transcript, mute/camera/exit controls, the AI tile, and the `live-immersive` body class.

- [ ] **Step 1: Replace `frontend/screens/live.js` with exactly this**

```javascript
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
let finishing = false;     // guard so End + agent-close don't double-submit
let pendingScore = null;   // payload from a failed score POST, kept for retry
let recorder = null;       // active audio recorder handle, or null
let role = '';             // interview role captured at start
let muted = false;         // mic muted?
let camOn = true;          // camera on?

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
  window.addEventListener('hashchange', function leave(){
    if (location.hash.replace(/^#/, '') !== '/live'){
      stopAgent(); engine.stop();
      document.body.classList.remove('live-immersive');
      window.removeEventListener('hashchange', leave);
    }
  });

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
```

- [ ] **Step 2: Verify it parses**

Run: `cd /Users/carrieyu/Desktop/Hipe/mediapipe-test && node --input-type=module --check < frontend/screens/live.js && echo SYNTAX_OK`
Expected: `SYNTAX_OK`

- [ ] **Step 3: Confirm the registry still imports `live`**

Run: `grep -n "live" frontend/screens/registry.js`
Expected: the `/live` route still maps to the `live` export (unchanged — we kept the same export name). No edit needed.

- [ ] **Step 4: Commit**

```bash
git add frontend/screens/live.js
git commit -m "feat(live): immersive full-screen interview UI (Option B)"
```

---

## Task 6: Manual browser verification

No JS test runner exists, so verify in the browser (needs `DEEPGRAM_API_KEY`; `ANTHROPIC_API_KEY` for the verdict).

- [ ] **Step 1: Run the app**

Run from the repo root: `cd /Users/carrieyu/Desktop/Hipe/mediapipe-test && .venv/bin/uvicorn backend.main:app --reload --port 8000` (stop any old server on 8000 first). Open `http://localhost:8000`, go to **New interview**, start it.

- [ ] **Step 2: Verify the immersive layout**

- The `/live` screen is **full-screen with no sidebar**; the video fills the window (mirrored).
- Top-left: `← Exit`, `● LIVE · timer`, voice state. Top-right: `Transcript`.
- Control bar (bottom-center): mic, camera, **End interview**. AI tile lower-right.

- [ ] **Step 3: Verify behaviors**

- Speak: the **caption** at the bottom updates with the latest line; the **AI tile pulses** while the interviewer talks, calm when listening.
- **Transcript** button slides the full conversation panel in/out.
- **Mute**: mic button turns red with a slash, voice pill shows "Muted", the interviewer stops responding; unmute resumes.
- **Camera**: video blanks to a "Camera off" panel, button turns red/slashed; turning it back on resumes the video.
- **End interview**: shows "Processing…" → opens the report (with the verdict if keys are set).
- **← Exit**: prompts "Leave without scoring?"; confirming returns to the dashboard with the sidebar back and **no** session created.

- [ ] **Step 4: Verify the sidebar restores**

After End or Exit, the normal app chrome (sidebar) is back on the destination screen.

---

## Self-Review

**Spec coverage:**
- Immersive full-screen video → Task 4 (CSS) + Task 5 (markup). ✓
- Sidebar hidden on `/live` → `live-immersive` class (Task 4 CSS + Task 5 add/remove). ✓
- Captions (latest line) → Task 5 `onTranscript` + `.li-cap`. ✓
- Slide-out transcript → Task 5 `toggleTranscript` + `.li-transcript`. ✓
- AI tile, pulses while speaking → Task 1 `onSpeaking` + Task 5 `onAiSpeaking` + Task 4 `.li-ai.speaking`. ✓
- Mute (stops AI hearing + pauses recording) → Task 1 `setMuted` + Task 2 `pause/resume` + Task 5 `toggleMute`. ✓
- Camera toggle (pauses facial analysis) → Task 3 `setCameraOn` + Task 5 `toggleCamera`. ✓
- End (score) vs Exit (no score, confirm) → Task 5 `finishInterview` / `exitInterview`. ✓
- Line icons, 46px controls → Task 4 + Task 5 SVGs. ✓
- Live feedback panel removed → Task 5 markup omits it; `onAction` now only buffers for the report. ✓

**Placeholder scan:** every step has complete code + exact commands. ✓

**Type/name consistency:** `setMuted`/`onSpeaking` (deepgram-client) called by `toggleMute`/`onAiSpeaking` (live.js); `pause`/`resume` (recorder) called by `toggleMute`; `setCameraOn` (engine) called by `toggleCamera`; DOM ids (`lv-cap`, `lv-ai`, `lv-ai-state`, `lv-controls`, `lv-mute`, `lv-cam`, `lv-end`, `lv-exit`, `lv-tx-btn`, `lv-tx-close`, `lv-transcript`, `lv-convo`, `lv-ph`, `lv-start`, `lv-canvas`, `lv-time`, `lv-voice`, `lv-state`) are all created in the Task 5 markup and referenced by the handlers; CSS classes (`live-imm`, `cam-off`, `li-*`, `li-ctrl.off`, `li-ai.speaking`) match the markup. The capture/score payload still matches `SessionRequest` (`{role, frames, transcript:{full_text,segments}, events, emotion, voice}`). ✓

---

## Execution Handoff

After implementation, do the Task 6 manual browser pass with real keys. Then use `superpowers:finishing-a-development-branch` to integrate.
