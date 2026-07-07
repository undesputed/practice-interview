import { esc } from '../util.js';
import { setInterviewConfig } from '../interview-config.js';
import { api } from '../api.js';
import { preload } from '../interview-engine.js';

// Scenarios: what the user is practicing for.
// The "job" scenario reveals the optional role picker; all others hide it.
// icon: single character used in the .ri div — same pattern as the original role cards.
const SCENARIOS = [
  { id: 'job',      icon: '◑', title: 'Nail a job interview',   desc: 'Read how you came across answering tough questions.',      tags: ['behavioral', 'Q&A'] },
  { id: 'present',  icon: '▶', title: 'Deliver a presentation', desc: 'See where your delivery held attention and where it slipped.', tags: ['delivery', 'slides'] },
  { id: 'tough',    icon: '⚡', title: 'Handle a tough talk',    desc: 'Check how steady and clear you stayed under pressure.',    tags: ['pressure', 'clarity'] },
  { id: 'pitch',    icon: '◈', title: 'Pitch and persuade',     desc: 'See how convincing and specific you sounded.',             tags: ['persuasion'] },
  { id: 'teach',    icon: '◎', title: 'Teach or explain',       desc: 'Find the moments your explanation got fuzzy.',             tags: ['explanation'] },
  { id: 'language', icon: '⌘', title: 'Speak another language', desc: 'Track your fluency, pace, and pauses.',                   tags: ['fluency', 'pace'] },
];

// Job roles — only shown when scenario === 'job'.
const ROLES = [
  { id: 'swe',    icon: '⌨', label: 'Software engineer', desc: 'System design + coding talk-through', tags: ['system design'] },
  { id: 'pm',     icon: '◑', label: 'Product manager',   desc: 'Behavioral + product sense',          tags: ['behavioral', 'strategy'] },
  { id: 'design', icon: '✦', label: 'Designer',          desc: 'Portfolio + critique',                tags: ['portfolio'] },
  { id: 'data',   icon: '▦', label: 'Data analyst',      desc: 'Metrics + case study',                tags: ['SQL', 'case'] },
  { id: 'other',  icon: '◉', label: 'Other',             desc: 'General interview practice',          tags: ['general'] },
];

const BARS = 18;

let media = { stream: null, ctx: null, raf: 0 };
let generatedQuestions = [];

// Read current settings for the question generation API call.
// NOTE: question_count (snake_case) feeds POST /api/questions directly.
// saveSettings() uses questionCount (camelCase) for interview-config.js — intentionally different.
function currentSettings(root) {
  const onText = (sel, fb) => { const el = root.querySelector(sel); return el ? el.textContent.trim() : fb; };
  const sc = root.querySelector('.role-card.on');
  const rc = root.querySelector('#role-chips .role-card.on');
  const langBtn = root.querySelector('[data-group="language"] button.on');
  return {
    scenario:       sc  ? sc.dataset.scenario                       : 'job',
    role:           (sc && sc.dataset.scenario === 'job' && rc) ? [rc.querySelector('.rt'), rc.querySelector('.rd')].filter(Boolean).map((el) => el.textContent.trim()).join(' ') : '',
    focus:          onText('[data-group="focus"] button.on',      'Mixed'),
    difficulty:     onText('[data-group="difficulty"] button.on', 'Realistic'),
    question_count: parseInt(root.querySelector('#ni-qval').textContent, 10) || 5,
    language:       langBtn ? langBtn.dataset.lang : 'en',
  };
}

function renderQuestions() {
  const list = document.getElementById('ni-qlist');
  if (!list) return;
  list.innerHTML = generatedQuestions.length
    ? '<ol class="qol">' + generatedQuestions.map((q) => '<li>' + esc(q) + '</li>').join('') + '</ol>'
    : '<div class="fa-note">No questions yet — generate a set, or start without and the interviewer will improvise.</div>';
}

function clearQuestions() {
  generatedQuestions = [];
  renderQuestions();
  const btn = document.getElementById('ni-gen');
  if (btn) btn.textContent = 'Generate questions';
}

async function generate(root) {
  const btn  = document.getElementById('ni-gen');
  const list = document.getElementById('ni-qlist');
  if (!btn) return;
  btn.disabled = true;
  btn.textContent = 'Generating…';
  if (list) list.innerHTML = '<div class="fa-note">Generating…</div>';
  const res = await api.generateQuestions(currentSettings(root));
  generatedQuestions = (res && res.questions) || [];
  if (generatedQuestions.length) {
    renderQuestions();
    btn.textContent = 'Regenerate';
  } else {
    if (list) list.innerHTML = '<div class="fa-note">Couldn\'t generate — you can still start; the interviewer will improvise.</div>';
    btn.textContent = 'Generate questions';
  }
  btn.disabled = false;
}

function scenarioCard(s, i) {
  return '<button type="button" class="role-card' + (i === 0 ? ' on' : '') + '" data-scenario="' + esc(s.id) + '">' +
    '<div class="ri">' + s.icon + '</div>' +
    '<div><div class="rt">' + esc(s.title) + '</div>' +
    '<div class="rd">' + esc(s.desc) + '</div>' +
    '<div class="tags">' + s.tags.map((t) => '<span class="tg">' + esc(t) + '</span>').join('') + '</div></div></button>';
}

function setDevline(id, nameText, chipClass, chipLabel) {
  const line = document.getElementById(id);
  if (!line) return;
  const t = line.querySelector('.t');
  if (t && nameText != null) t.textContent = nameText;
  const chip = line.querySelector('.chip');
  if (chip) { chip.className = 'chip ' + chipClass; chip.innerHTML = '<span class="dot"></span>' + chipLabel; }
}

function stopMedia() {
  if (media.raf) cancelAnimationFrame(media.raf);
  if (media.ctx)    { media.ctx.close().catch(() => {}); }
  if (media.stream) { media.stream.getTracks().forEach((t) => t.stop()); }
  media = { stream: null, ctx: null, raf: 0 };
  const v = document.getElementById('ni-video');
  if (v) { v.srcObject = null; v.style.display = 'none'; }
  const sil = document.getElementById('ni-silh');
  if (sil) sil.style.display = '';
  const bars = document.querySelectorAll('#ni-levels i');
  bars.forEach((b) => { b.style.transform = 'scaleY(.12)'; });
  const cam = document.getElementById('ni-cam-badge');
  if (cam) cam.style.display = 'none';
  setDevline('ni-cam', 'Camera',     'warn', 'Idle');
  setDevline('ni-mic', 'Microphone', 'warn', 'Idle');
  const btn = document.getElementById('ni-test');
  if (btn) btn.textContent = 'Test camera & mic';
}

function meter() {
  const node = media.analyser;
  if (!node) return;
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

async function startMedia() {
  const btn = document.getElementById('ni-test');
  if (media.stream) { stopMedia(); return; }
  if (btn) { btn.disabled = true; btn.textContent = 'Starting…'; }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    media.stream = stream;
    const v = document.getElementById('ni-video');
    if (v) { v.srcObject = stream; v.style.display = 'block'; v.play().catch(() => {}); }
    const sil = document.getElementById('ni-silh');
    if (sil) sil.style.display = 'none';
    const cam = document.getElementById('ni-cam-badge');
    if (cam) cam.style.display = '';
    const vTrack = stream.getVideoTracks()[0];
    const aTrack = stream.getAudioTracks()[0];
    setDevline('ni-cam', (vTrack && vTrack.label) || 'Camera',     'good', 'OK');
    setDevline('ni-mic', (aTrack && aTrack.label) || 'Microphone', 'good', 'OK');
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (Ctx && aTrack) {
      media.ctx      = new Ctx();
      const src      = media.ctx.createMediaStreamSource(stream);
      media.analyser = media.ctx.createAnalyser();
      media.analyser.fftSize = 64;
      src.connect(media.analyser);
      meter();
    }
    if (btn) btn.textContent = 'Stop test';
  } catch (e) {
    setDevline('ni-cam', 'Camera blocked',     'warn', 'No access');
    setDevline('ni-mic', 'Microphone blocked', 'warn', 'No access');
    const sil = document.getElementById('ni-silh');
    if (sil) { sil.textContent = '⚠'; sil.title = String(e && e.message ? e.message : e); }
    if (btn) btn.textContent = 'Retry';
  } finally {
    if (btn) btn.disabled = false;
  }
}

function saveSettings(root) {
  const onText = (sel, fb) => { const el = root.querySelector(sel); return el ? el.textContent.trim() : fb; };
  const sc   = root.querySelector('.role-card.on');
  const rc   = root.querySelector('#role-chips .role-card.on');
  const scenario      = sc ? sc.dataset.scenario    : 'job';
  const role          = (scenario === 'job' && rc) ? [rc.querySelector('.rt'), rc.querySelector('.rd')].filter(Boolean).map((el) => el.textContent.trim()).join(' ') : '';
  const focus         = onText('[data-group="focus"] button.on',      'Mixed');
  const difficulty    = onText('[data-group="difficulty"] button.on', 'Realistic');
  const tone          = onText('[data-group="tone"] button.on',       'Professional');
  const questionCount = parseInt(root.querySelector('#ni-qval').textContent, 10) || 5;
  const langBtn       = root.querySelector('[data-group="language"] button.on');
  const language      = langBtn ? langBtn.dataset.lang : 'en';
  setInterviewConfig({ scenario, role, focus, difficulty, tone, questionCount, questions: generatedQuestions, language });
}

export function newInterview() {
  generatedQuestions = [];
  stopMedia();
  // Kick off MediaPipe model downloads immediately so they are ready (or nearly so)
  // by the time the user finishes the form and clicks Start.
  preload();
  window.addEventListener('hashchange', function leave() {
    if (location.hash.replace(/^#/, '') !== '/practice-interview') {
      stopMedia();
      window.removeEventListener('hashchange', leave);
    }
  });

  queueMicrotask(() => {
    const root = document.getElementById('new-body');
    if (!root) return;

    // Scenario selection — show/hide role sub-picker
    const scGrid  = root.querySelector('#sc-grid');
    const roleSub = root.querySelector('#role-sub');
    scGrid.addEventListener('click', (e) => {
      const card = e.target.closest('.role-card');
      if (!card || !scGrid.contains(card)) return;
      scGrid.querySelectorAll('.role-card').forEach((c) => c.classList.remove('on'));
      card.classList.add('on');
      roleSub.style.display = card.dataset.scenario === 'job' ? '' : 'none';
      clearQuestions();
    });

    // Role chip single-select
    const roleChips = root.querySelector('#role-chips');
    if (roleChips) {
      roleChips.addEventListener('click', (e) => {
        const chip = e.target.closest('.role-card');
        if (!chip || !roleChips.contains(chip)) return;
        roleChips.querySelectorAll('.role-card').forEach((c) => c.classList.remove('on'));
        chip.classList.add('on');
        clearQuestions();
      });
    }

    // Segmented controls (focus / difficulty / tone)
    root.querySelectorAll('[data-group]').forEach((group) => {
      group.addEventListener('click', (e) => {
        const btn = e.target.closest('button');
        if (!btn || !group.contains(btn)) return;
        group.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === btn));
        clearQuestions();
      });
    });

    // Question count stepper (3 to 12)
    const val = document.getElementById('ni-qval');
    root.querySelectorAll('[data-step]').forEach((b) => b.addEventListener('click', () => {
      const next = Math.max(3, Math.min(12, (parseInt(val.textContent, 10) || 6) + parseInt(b.getAttribute('data-step'), 10)));
      val.textContent = next;
      clearQuestions();
    }));

    document.getElementById('ni-test').addEventListener('click', startMedia);
    document.getElementById('ni-gen').addEventListener('click',  () => generate(root));
    document.getElementById('ni-start').addEventListener('click', () => {
      saveSettings(root);
      stopMedia();
      location.hash = '#/live';
    });
  });

  const bars = Array.from({ length: BARS }, () => '<i></i>').join('');

  return '<div class="screen"><div class="screen-head">' +
    '<h1>New session</h1>' +
    '<span class="muted" style="font-size:12px">camera &amp; mic stay on your device</span>' +
    '</div>' +
    '<div id="new-body"><div class="ni-grid">' +

    // ---- left column ----
    '<div>' +
      '<div class="ni-set">' +
        '<div class="ni-fl">1 · What are you practicing for?</div>' +
        '<div class="role-grid" id="sc-grid">' +
          SCENARIOS.map(scenarioCard).join('') +
        '</div> <br>' +
        '<div class="role-sub" id="role-sub">' +
          '<div class="ni-fl">Job role</div>' +
          '<div class="role-grid" id="role-chips">' +
            ROLES.map((r, i) =>
              '<button type="button" class="role-card' + (i === 0 ? ' on' : '') + '" data-role="' + esc(r.id) + '">' +
              '<div class="ri">' + r.icon + '</div>' +
              '<div><div class="rt">' + esc(r.label) + '</div>' +
              '<div class="rd">' + esc(r.desc) + '</div>' +
              '<div class="tags">' + r.tags.map((t) => '<span class="tg">' + esc(t) + '</span>').join('') + '</div></div></button>'
            ).join('') +
          '</div>' +
        '</div>' +
      '</div>' +

      '<div class="ni-set">' +
        '<div class="ni-fl">2 · Tune the session</div>' +
        '<div class="row-wrap">' +
          '<div><span class="ql">Focus</span><div class="ni-seg" data-group="focus">' +
            '<button class="on">Behavioral</button><button>Technical</button><button>Mixed</button></div></div>' +
          '<div><span class="ql">Difficulty</span><div class="ni-seg" data-group="difficulty">' +
            '<button>Warm-up</button><button class="on">Realistic</button><button>Hard</button></div></div>' +
          '<div><span class="ql">Tone</span><div class="ni-seg" data-group="tone">' +
            '<button>Friendly</button><button class="on">Professional</button><button>Stern</button><button>Intimidating</button></div></div>' +
          '<div><span class="ql">Language</span><div class="ni-seg" data-group="language">' +
            '<button class="on" data-lang="en">English</button><button data-lang="ja">日本語</button></div></div>' +
          '<div><span class="ql">Questions</span><div class="stepper">' +
            '<button data-step="-1">−</button><span class="val" id="ni-qval">6</span><button data-step="1">+</button></div></div>' +
        '</div>' +
      '</div>' +

      '<div class="ni-set">' +
        '<div class="ni-fl">3 · Your questions</div>' +
        '<div class="ni-q-head">' +
          '<span class="muted" style="font-size:12px">AI-written for your scenario, focus &amp; difficulty.</span>' +
          '<button class="btn btn-ghost" id="ni-gen" type="button">Generate questions</button>' +
        '</div>' +
        '<div class="ni-qlist" id="ni-qlist">' +
          '<div class="fa-note">No questions yet — generate a set, or start without and the interviewer will improvise.</div>' +
        '</div>' +
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
        '<div class="devline" id="ni-cam">' +
          '<span class="nm">📷 <span class="t">Camera</span></span>' +
          '<span class="chip warn"><span class="dot"></span>Idle</span>' +
        '</div>' +
        '<div class="devline" id="ni-mic">' +
          '<span class="nm">🎙 <span class="t">Microphone</span></span>' +
          '<span class="chip warn"><span class="dot"></span>Idle</span>' +
        '</div>' +
        '<div class="devline">' +
          '<span class="nm">⚙ <span class="t">Analysis engine</span></span>' +
          '<span class="chip face"><span class="dot"></span>MediaPipe</span>' +
        '</div>' +
      '</div>' +
      '<button class="btn btn-ghost" id="ni-test" style="width:100%;margin-top:14px">Test camera &amp; mic</button>' +
      '<button class="btn btn-green" id="ni-start" style="width:100%;margin-top:10px">Start session →</button>' +
    '</div>' +

    '</div></div></div>';
}