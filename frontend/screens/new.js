import { esc } from '../util.js';
import { setInterviewConfig } from '../interview-config.js';
import { api } from '../api.js';

// Static role set for the setup layout. Roles can later bind to api.getRoles()
// once the library screen owns them — kept inline so the layout stands alone.
const ROLES = [
  { id: 'pm',     icon: '◑', title: 'Product Manager',   desc: 'Behavioral + product sense',        tags: ['behavioral', 'strategy'] },
  { id: 'swe',    icon: '⌨', title: 'Software Engineer',  desc: 'System design + coding talk-through', tags: ['system design'] },
  { id: 'design', icon: '✦', title: 'Designer',          desc: 'Portfolio + critique',               tags: ['portfolio'] },
  { id: 'data',   icon: '▦', title: 'Data Analyst',       desc: 'Metrics + case study',               tags: ['SQL', 'case'] },
];

const BARS = 18;   // mic level-meter bars

// One live media session (camera + mic preview). Torn down on Stop/leave.
let media = { stream: null, ctx: null, raf: 0 };
let generatedQuestions = [];   // current AI-generated set for the live interview

// Read the current role/focus/difficulty/count without storing (for generation).
function currentSettings(root){
  const onText = (sel, fb) => { const el = root.querySelector(sel); return el ? el.textContent.trim() : fb; };
  const rc = root.querySelector('.role-card.on');
  return {
    role: rc ? rc.querySelector('.rt').textContent.trim() : 'Software Engineer',
    focus: onText('[data-group="focus"] button.on', 'Mixed'),
    difficulty: onText('[data-group="difficulty"] button.on', 'Realistic'),
    question_count: parseInt(root.querySelector('#ni-qval').textContent, 10) || 5,
  };
}

function renderQuestions(){
  const list = document.getElementById('ni-qlist'); if (!list) return;
  list.innerHTML = generatedQuestions.length
    ? '<ol class="qol">' + generatedQuestions.map((q) => '<li>' + esc(q) + '</li>').join('') + '</ol>'
    : '<div class="fa-note">No questions generated yet — generate a set, or start without and the interviewer will improvise.</div>';
}

// Settings changed → the current set no longer matches; clear it.
function clearQuestions(){
  generatedQuestions = [];
  renderQuestions();
  const btn = document.getElementById('ni-gen'); if (btn) btn.textContent = 'Generate questions';
}

async function generate(root){
  const btn = document.getElementById('ni-gen'); if (!btn) return;
  const list = document.getElementById('ni-qlist');
  btn.disabled = true; btn.textContent = 'Generating…';
  if (list) list.innerHTML = '<div class="fa-note">Generating…</div>';
  const res = await api.generateQuestions(currentSettings(root));
  generatedQuestions = (res && res.questions) || [];
  if (generatedQuestions.length){
    renderQuestions();
    btn.textContent = 'Regenerate';
  } else {
    if (list) list.innerHTML = '<div class="fa-note">Couldn’t generate — you can still start; the interviewer will improvise.</div>';
    btn.textContent = 'Generate questions';
  }
  btn.disabled = false;
}

function roleCard(r, i){
  return '<button type="button" class="role-card' + (i === 0 ? ' on' : '') + '" data-role="' + esc(r.id) + '">' +
    '<div class="ri">' + r.icon + '</div>' +
    '<div><div class="rt">' + esc(r.title) + '</div>' +
    '<div class="rd">' + esc(r.desc) + '</div>' +
    '<div class="tags">' + r.tags.map((t) => '<span class="tg">' + esc(t) + '</span>').join('') + '</div></div></button>';
}

function setDevline(id, nameSel, chipClass, chipLabel){
  const line = document.getElementById(id); if (!line) return;
  const t = line.querySelector('.t'); if (t && nameSel != null) t.textContent = nameSel;
  const chip = line.querySelector('.chip');
  if (chip){ chip.className = 'chip ' + chipClass; chip.innerHTML = '<span class="dot"></span>' + chipLabel; }
}

function stopMedia(){
  if (media.raf) cancelAnimationFrame(media.raf);
  if (media.ctx){ media.ctx.close().catch(() => {}); }
  if (media.stream){ media.stream.getTracks().forEach((t) => t.stop()); }
  media = { stream: null, ctx: null, raf: 0 };
  const v = document.getElementById('ni-video'); if (v){ v.srcObject = null; v.style.display = 'none'; }
  const sil = document.getElementById('ni-silh'); if (sil) sil.style.display = '';
  const bars = document.querySelectorAll('#ni-levels i'); bars.forEach((b) => { b.style.transform = 'scaleY(.12)'; });
  const cam = document.getElementById('ni-cam-badge'); if (cam) cam.style.display = 'none';
  setDevline('ni-cam', 'Camera', 'warn', 'Idle');
  setDevline('ni-mic', 'Microphone', 'warn', 'Idle');
  const btn = document.getElementById('ni-test'); if (btn) btn.textContent = 'Test camera & mic';
}

function meter(){
  const node = media.analyser; if (!node) return;
  const data = new Uint8Array(node.frequencyBinCount);
  const bars = Array.from(document.querySelectorAll('#ni-levels i'));
  if (!bars.length) return;
  const tick = () => {
    node.getByteFrequencyData(data);
    const bins = Math.floor(data.length / bars.length) || 1;
    bars.forEach((bar, i) => {
      let sum = 0;
      for (let j = 0; j < bins; j++) sum += data[i * bins + j];
      const v = Math.min(1, (sum / bins) / 180);
      bar.style.transform = 'scaleY(' + Math.max(0.12, v).toFixed(2) + ')';
    });
    media.raf = requestAnimationFrame(tick);
  };
  tick();
}

async function startMedia(){
  const btn = document.getElementById('ni-test');
  if (media.stream){ stopMedia(); return; }     // toggle off
  if (btn){ btn.disabled = true; btn.textContent = 'Starting…'; }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    media.stream = stream;
    const v = document.getElementById('ni-video');
    if (v){ v.srcObject = stream; v.style.display = 'block'; v.play().catch(() => {}); }
    const sil = document.getElementById('ni-silh'); if (sil) sil.style.display = 'none';
    const cam = document.getElementById('ni-cam-badge'); if (cam) cam.style.display = '';

    const vTrack = stream.getVideoTracks()[0];
    const aTrack = stream.getAudioTracks()[0];
    setDevline('ni-cam', (vTrack && vTrack.label) || 'Camera', 'good', 'OK');
    setDevline('ni-mic', (aTrack && aTrack.label) || 'Microphone', 'good', 'OK');

    // live mic level meter
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (Ctx && aTrack){
      media.ctx = new Ctx();
      const src = media.ctx.createMediaStreamSource(stream);
      media.analyser = media.ctx.createAnalyser();
      media.analyser.fftSize = 64;
      src.connect(media.analyser);
      meter();
    }
    if (btn) btn.textContent = 'Stop test';
  } catch (e){
    setDevline('ni-cam', 'Camera blocked', 'warn', 'No access');
    setDevline('ni-mic', 'Microphone blocked', 'warn', 'No access');
    const sil = document.getElementById('ni-silh');
    if (sil){ sil.textContent = '⚠'; sil.title = String(e && e.message ? e.message : e); }
    if (btn) btn.textContent = 'Retry';
  } finally {
    if (btn) btn.disabled = false;
  }
}

// Read the chosen role/focus/difficulty/question-count out of the form and stash them
// for the Live screen. Each single-select group marks its choice with class "on".
function saveSettings(root){
  const onText = (sel, fallback) => {
    const el = root.querySelector(sel);
    return el ? el.textContent.trim() : fallback;
  };
  const roleCard = root.querySelector('.role-card.on');
  const role = roleCard ? roleCard.querySelector('.rt').textContent.trim() : 'Software Engineer';
  const focus = onText('[data-group="focus"] button.on', 'Mixed');
  const difficulty = onText('[data-group="difficulty"] button.on', 'Realistic');
  const questionCount = parseInt(root.querySelector('#ni-qval').textContent, 10) || 5;
  setInterviewConfig({ role, focus, difficulty, questionCount, questions: generatedQuestions });
}

export function newInterview(){
  // Reset any media left from a prior visit, then arm a one-shot teardown for
  // when the user navigates away from this screen.
  generatedQuestions = [];
  stopMedia();
  window.addEventListener('hashchange', function leave(){
    if (location.hash.replace(/^#/, '') !== '/new'){
      stopMedia();
      window.removeEventListener('hashchange', leave);
    }
  });

  queueMicrotask(() => {
    const root = document.getElementById('new-body');
    if (!root) return;

    // single-select groups (roles + segmented controls)
    root.querySelectorAll('[data-group]').forEach((group) => {
      group.addEventListener('click', (e) => {
        const btn = e.target.closest('button, .role-card');
        if (!btn || !group.contains(btn)) return;
        group.querySelectorAll('button, .role-card').forEach((b) => b.classList.toggle('on', b === btn));
        clearQuestions();
      });
    });

    // question count stepper (3–12)
    const val = document.getElementById('ni-qval');
    root.querySelectorAll('[data-step]').forEach((b) => b.addEventListener('click', () => {
      const cur = parseInt(val.textContent, 10) || 6;
      const next = Math.max(3, Math.min(12, cur + parseInt(b.getAttribute('data-step'), 10)));
      val.textContent = next;
      clearQuestions();
    }));

    document.getElementById('ni-test').addEventListener('click', startMedia);
    document.getElementById('ni-gen').addEventListener('click', () => generate(root));
    document.getElementById('ni-start').addEventListener('click', () => {
      saveSettings(root);
      stopMedia();
      location.hash = '#/live';
    });
  });

  const bars = Array.from({ length: BARS }, () => '<i></i>').join('');

  return '<div class="screen"><div class="screen-head"><h1>New interview</h1>' +
    '<span class="muted" style="font-size:12px">camera &amp; mic stay on your device</span></div>' +
    '<div id="new-body"><div class="ni-grid">' +

      // ---- left column: role + settings ----
      '<div>' +
        '<div class="ni-set"><div class="ni-fl">1 · Choose a role</div>' +
          '<div class="role-grid" data-group="role">' + ROLES.map(roleCard).join('') + '</div></div>' +

        '<div class="ni-set"><div class="ni-fl">2 · Tune the set</div>' +
          '<div class="row-wrap">' +
            '<div><span class="ql">Focus</span><div class="ni-seg grad" data-group="focus">' +
              '<button class="on">Behavioral</button><button>Technical</button><button>Mixed</button></div></div>' +
            '<div><span class="ql">Difficulty</span><div class="ni-seg" data-group="difficulty">' +
              '<button>Warm-up</button><button class="on">Realistic</button><button>Hard</button></div></div>' +
            '<div><span class="ql">Questions</span><div class="stepper">' +
              '<button data-step="-1">−</button><span class="val" id="ni-qval">6</span><button data-step="1">+</button></div></div>' +
          '</div></div>' +
        '<div class="ni-set"><div class="ni-fl">3 · Your questions</div>' +
          '<div class="ni-q-head">' +
            '<span class="muted" style="font-size:12px">AI-written for your role, focus &amp; difficulty.</span>' +
            '<button class="btn btn-ghost" id="ni-gen" type="button">Generate questions</button>' +
          '</div>' +
          '<div class="ni-qlist" id="ni-qlist"><div class="fa-note">No questions generated yet — generate a set, or start without and the interviewer will improvise.</div></div>' +
        '</div>' +
      '</div>' +

      // ---- right column: device check ----
      '<div class="devcheck"><div class="ni-fl">4 · Device check</div>' +
        '<div class="cam-prev">' +
          '<video id="ni-video" playsinline muted style="display:none"></video>' +
          '<div class="frame"></div>' +
          '<div class="silh" id="ni-silh">☺</div>' +
          '<div class="tagrow"><span class="mini-badge" id="ni-cam-badge" style="display:none">' +
            '<span class="dot"></span>Camera live</span></div>' +
        '</div>' +
        '<div class="levels" id="ni-levels">' + bars + '</div>' +
        '<div class="devlist">' +
          '<div class="devline" id="ni-cam"><span class="nm">📷 <span class="t">Camera</span></span>' +
            '<span class="chip warn"><span class="dot"></span>Idle</span></div>' +
          '<div class="devline" id="ni-mic"><span class="nm">🎙 <span class="t">Microphone</span></span>' +
            '<span class="chip warn"><span class="dot"></span>Idle</span></div>' +
          '<div class="devline"><span class="nm">⚙ <span class="t">Analysis engine</span></span>' +
            '<span class="chip face"><span class="dot"></span>MediaPipe</span></div>' +
        '</div>' +
        '<button class="btn btn-ghost" id="ni-test" style="width:100%;margin-top:14px">Test camera &amp; mic</button>' +
        '<button class="btn btn-green" id="ni-start" style="width:100%;margin-top:10px">Start interview →</button>' +
      '</div>' +

    '</div></div></div>';
}
