import { esc } from '../util.js';
import { setInterviewConfig } from '../interview-config.js';
import { api } from '../api.js';
import { preload } from '../interview-engine.js';
import { setLang, currentLang, t } from '../i18n.js';

// Scenarios: what the user is practicing for.
// The "job" scenario reveals the optional role picker; all others hide it.
// Display strings come from i18n; English label/desc stay for API/storage.
const SCENARIOS = [
  { id: 'job',       icon: '◑', titleKey: 'practice.sc.job',       descKey: 'practice.sc.job.desc',
    tagKeys: ['practice.tag.behavioral', 'practice.tag.qa'],
    titleEn: 'Nail a job interview', descEn: 'Read how you came across answering tough questions.' },
  { id: 'present',   icon: '▶', titleKey: 'practice.sc.present',   descKey: 'practice.sc.present.desc',
    tagKeys: ['practice.tag.delivery', 'practice.tag.slides'],
    titleEn: 'Deliver a presentation', descEn: 'See where your delivery held attention and where it slipped.' },
  { id: 'tough',     icon: '⚡', titleKey: 'practice.sc.tough',     descKey: 'practice.sc.tough.desc',
    tagKeys: ['practice.tag.pressure', 'practice.tag.clarity'],
    titleEn: 'Handle a tough talk', descEn: 'Check how steady and clear you stayed under pressure.' },
  { id: 'pitch',     icon: '◈', titleKey: 'practice.sc.pitch',     descKey: 'practice.sc.pitch.desc',
    tagKeys: ['practice.tag.persuasion'],
    titleEn: 'Pitch and persuade', descEn: 'See how convincing and specific you sounded.' },
  { id: 'negotiate', icon: '◎', titleKey: 'practice.sc.negotiate', descKey: 'practice.sc.negotiate.desc',
    tagKeys: ['practice.tag.negotiation', 'practice.tag.pressure'],
    titleEn: 'Negotiate a deal', descEn: 'See how persuasive and composed you are under pushback.' },
  { id: 'case',      icon: '⌘', titleKey: 'practice.sc.case',      descKey: 'practice.sc.case.desc',
    tagKeys: ['practice.tag.case', 'practice.tag.consulting'],
    titleEn: 'Crack a case interview', descEn: 'Work through a business problem and sharpen your structure.' },
];

// Job roles — only shown when scenario === 'job'.
// labelEn/descEn are sent to the backend; labelKey/descKey are UI-only.
const ROLES = [
  { id: 'swe',    icon: '⌨', labelKey: 'practice.role.swe',    descKey: 'practice.role.swe.desc',
    tagKeys: ['practice.tag.systemDesign'],
    labelEn: 'Software engineer', descEn: 'System design + coding talk-through' },
  { id: 'pm',     icon: '◑', labelKey: 'practice.role.pm',     descKey: 'practice.role.pm.desc',
    tagKeys: ['practice.tag.behavioral', 'practice.tag.strategy'],
    labelEn: 'Product manager', descEn: 'Behavioral + product sense' },
  { id: 'design', icon: '✦', labelKey: 'practice.role.design', descKey: 'practice.role.design.desc',
    tagKeys: ['practice.tag.portfolio'],
    labelEn: 'Designer', descEn: 'Portfolio + critique' },
  { id: 'data',   icon: '▦', labelKey: 'practice.role.data',   descKey: 'practice.role.data.desc',
    tagKeys: ['practice.tag.sql', 'practice.tag.case'],
    labelEn: 'Data analyst', descEn: 'Metrics + case study' },
  { id: 'other',  icon: '◉', labelKey: 'practice.role.other',  descKey: 'practice.role.other.desc',
    tagKeys: ['practice.tag.general'],
    labelEn: 'Other', descEn: 'General interview practice' },
];

const BARS = 18;

let media = { stream: null, ctx: null, raf: 0 };
let generatedQuestions = [];

function selectedValue(root, group, fallback) {
  const btn = root.querySelector('[data-group="' + group + '"] button.on');
  return (btn && btn.dataset.value) ? btn.dataset.value : fallback;
}

function selectedRoleEn(root) {
  const rc = root.querySelector('#role-chips .role-card.on');
  if (!rc) return '';
  const role = ROLES.find((r) => r.id === rc.dataset.role);
  return role ? (role.labelEn + ' ' + role.descEn) : '';
}

// Read current settings for the question generation API call.
// NOTE: question_count (snake_case) feeds POST /api/questions directly.
// saveSettings() uses questionCount (camelCase) for interview-config.js — intentionally different.
// Focus/difficulty/tone/role always use English canonical values for the backend.
function currentSettings(root) {
  const sc = root.querySelector('#sc-grid .role-card.on');
  const langBtn = root.querySelector('[data-group="language"] button.on');
  const scenario = sc ? sc.dataset.scenario : 'job';
  return {
    scenario,
    role: scenario === 'job' ? selectedRoleEn(root) : '',
    focus: selectedValue(root, 'focus', 'Mixed'),
    difficulty: selectedValue(root, 'difficulty', 'Realistic'),
    question_count: parseInt(root.querySelector('#ni-qval').textContent, 10) || 5,
    language: langBtn ? langBtn.dataset.lang : 'en',
  };
}

function renderQuestions() {
  const list = document.getElementById('ni-qlist');
  if (!list) return;
  list.innerHTML = generatedQuestions.length
    ? '<ol class="qol">' + generatedQuestions.map((q) => '<li>' + esc(q) + '</li>').join('') + '</ol>'
    : '<div class="fa-note">' + esc(t('practice.qEmpty')) + '</div>';
}

function clearQuestions() {
  generatedQuestions = [];
  renderQuestions();
  const btn = document.getElementById('ni-gen');
  if (btn) btn.textContent = t('practice.gen');
}

async function generate(root) {
  const btn  = document.getElementById('ni-gen');
  const list = document.getElementById('ni-qlist');
  if (!btn) return;
  btn.disabled = true;
  btn.textContent = t('practice.generating');
  if (list) list.innerHTML = '<div class="fa-note">' + esc(t('practice.generating')) + '</div>';
  const res = await api.generateQuestions(currentSettings(root));
  generatedQuestions = (res && res.questions) || [];
  if (generatedQuestions.length) {
    renderQuestions();
    btn.textContent = t('practice.regen');
  } else {
    if (list) list.innerHTML = '<div class="fa-note">' + esc(t('practice.qFail')) + '</div>';
    btn.textContent = t('practice.gen');
  }
  btn.disabled = false;
}

function scenarioCard(s, i) {
  return '<button type="button" class="role-card' + (i === 0 ? ' on' : '') + '" data-scenario="' + esc(s.id) + '">' +
    '<div class="ri">' + s.icon + '</div>' +
    '<div><div class="rt">' + esc(t(s.titleKey)) + '</div>' +
    '<div class="rd">' + esc(t(s.descKey)) + '</div>' +
    '<div class="tags">' + s.tagKeys.map((k) => '<span class="tg">' + esc(t(k)) + '</span>').join('') + '</div></div></button>';
}

function roleCard(r, i) {
  return '<button type="button" class="role-card' + (i === 0 ? ' on' : '') + '" data-role="' + esc(r.id) + '">' +
    '<div class="ri">' + r.icon + '</div>' +
    '<div><div class="rt">' + esc(t(r.labelKey)) + '</div>' +
    '<div class="rd">' + esc(t(r.descKey)) + '</div>' +
    '<div class="tags">' + r.tagKeys.map((k) => '<span class="tg">' + esc(t(k)) + '</span>').join('') + '</div></div></button>';
}

function setDevline(id, nameText, chipClass, chipLabel) {
  const line = document.getElementById(id);
  if (!line) return;
  const el = line.querySelector('.t');
  if (el && nameText != null) el.textContent = nameText;
  const chip = line.querySelector('.chip');
  if (chip) { chip.className = 'chip ' + chipClass; chip.innerHTML = '<span class="dot"></span>' + esc(chipLabel); }
}

function stopMedia() {
  if (media.raf) cancelAnimationFrame(media.raf);
  if (media.ctx)    { media.ctx.close().catch(() => {}); }
  if (media.stream) { media.stream.getTracks().forEach((tr) => tr.stop()); }
  media = { stream: null, ctx: null, raf: 0 };
  const v = document.getElementById('ni-video');
  if (v) { v.srcObject = null; v.style.display = 'none'; }
  const sil = document.getElementById('ni-silh');
  if (sil) sil.style.display = '';
  const bars = document.querySelectorAll('#ni-levels i');
  bars.forEach((b) => { b.style.transform = 'scaleY(.12)'; });
  const cam = document.getElementById('ni-cam-badge');
  if (cam) cam.style.display = 'none';
  setDevline('ni-cam', t('practice.camera'), 'warn', t('practice.idle'));
  setDevline('ni-mic', t('practice.mic'),    'warn', t('practice.idle'));
  const btn = document.getElementById('ni-test');
  if (btn) btn.textContent = t('practice.testDevices');
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
  if (btn) { btn.disabled = true; btn.textContent = t('practice.starting'); }
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
    setDevline('ni-cam', (vTrack && vTrack.label) || t('practice.camera'), 'good', t('practice.ok'));
    setDevline('ni-mic', (aTrack && aTrack.label) || t('practice.mic'),    'good', t('practice.ok'));
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (Ctx && aTrack) {
      media.ctx      = new Ctx();
      const src      = media.ctx.createMediaStreamSource(stream);
      media.analyser = media.ctx.createAnalyser();
      media.analyser.fftSize = 64;
      src.connect(media.analyser);
      meter();
    }
    if (btn) btn.textContent = t('practice.stopTest');
  } catch (e) {
    setDevline('ni-cam', t('practice.camBlocked'), 'warn', t('practice.noAccess'));
    setDevline('ni-mic', t('practice.micBlocked'), 'warn', t('practice.noAccess'));
    const sil = document.getElementById('ni-silh');
    if (sil) { sil.textContent = '⚠'; sil.title = String(e && e.message ? e.message : e); }
    if (btn) btn.textContent = t('practice.retry');
  } finally {
    if (btn) btn.disabled = false;
  }
}

function saveSettings(root) {
  const sc = root.querySelector('#sc-grid .role-card.on');
  const scenario = sc ? sc.dataset.scenario : 'job';
  const role = scenario === 'job' ? selectedRoleEn(root) : '';
  const focus = selectedValue(root, 'focus', 'Mixed');
  const difficulty = selectedValue(root, 'difficulty', 'Realistic');
  const tone = selectedValue(root, 'tone', 'Professional');
  const questionCount = parseInt(root.querySelector('#ni-qval').textContent, 10) || 5;
  const langBtn = root.querySelector('[data-group="language"] button.on');
  const language = langBtn ? langBtn.dataset.lang : 'en';
  setInterviewConfig({ scenario, role, focus, difficulty, tone, questionCount, questions: generatedQuestions, language });
  // Keep the studio UI language in sync with the interview language.
  setLang(language === 'ja' ? 'ja' : 'en');
}

function segBtn(value, label, on) {
  return '<button type="button" data-value="' + esc(value) + '"' + (on ? ' class="on"' : '') + '>' +
    esc(label) + '</button>';
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

    // Segmented controls (focus / difficulty / tone / language)
    root.querySelectorAll('[data-group]').forEach((group) => {
      group.addEventListener('click', (e) => {
        const btn = e.target.closest('button');
        if (!btn || !group.contains(btn)) return;
        group.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === btn));
        if (group.dataset.group === 'language') {
          setLang(btn.dataset.lang === 'ja' ? 'ja' : 'en');
        }
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
  const lang = currentLang();

  return '<div class="screen"><div class="screen-head">' +
    '<h1>' + esc(t('practice.heading')) + '</h1>' +
    '<span class="muted" style="font-size:12px">' + esc(t('practice.privacy')) + '</span>' +
    '</div>' +
    '<div id="new-body"><div class="ni-grid">' +

    // ---- left column ----
    '<div>' +
      '<div class="ni-set">' +
        '<div class="ni-fl">' + esc(t('practice.step1')) + '</div>' +
        '<div class="role-grid" id="sc-grid">' +
          SCENARIOS.map(scenarioCard).join('') +
        '</div> <br>' +
        '<div class="role-sub" id="role-sub">' +
          '<div class="ni-fl">' + esc(t('practice.jobRole')) + '</div>' +
          '<div class="role-grid" id="role-chips">' +
            ROLES.map(roleCard).join('') +
          '</div>' +
        '</div>' +
      '</div>' +

      '<div class="ni-set">' +
        '<div class="ni-fl">' + esc(t('practice.step2')) + '</div>' +
        '<div class="row-wrap">' +
          '<div><span class="ql">' + esc(t('practice.focus')) + '</span><div class="ni-seg" data-group="focus">' +
            segBtn('Behavioral', t('practice.focus.behavioral'), true) +
            segBtn('Technical',  t('practice.focus.technical'),  false) +
            segBtn('Mixed',      t('practice.focus.mixed'),      false) +
          '</div></div>' +
          '<div><span class="ql">' + esc(t('practice.difficulty')) + '</span><div class="ni-seg" data-group="difficulty">' +
            segBtn('Warm-up',   t('practice.diff.warmup'),    false) +
            segBtn('Realistic', t('practice.diff.realistic'), true) +
            segBtn('Hard',      t('practice.diff.hard'),      false) +
          '</div></div>' +
          '<div><span class="ql">' + esc(t('practice.tone')) + '</span><div class="ni-seg" data-group="tone">' +
            segBtn('Friendly',      t('practice.tone.friendly'),      false) +
            segBtn('Professional',  t('practice.tone.professional'),  true) +
            segBtn('Stern',         t('practice.tone.stern'),         false) +
            segBtn('Intimidating',  t('practice.tone.intimidating'),  false) +
          '</div></div>' +
          '<div><span class="ql">' + esc(t('practice.language')) + '</span><div class="ni-seg" data-group="language">' +
            '<button type="button"' + (lang === 'en' ? ' class="on"' : '') + ' data-lang="en">English</button>' +
            '<button type="button"' + (lang === 'ja' ? ' class="on"' : '') + ' data-lang="ja">日本語</button></div></div>' +
          '<div><span class="ql">' + esc(t('practice.questions')) + '</span><div class="stepper">' +
            '<button type="button" data-step="-1">−</button><span class="val" id="ni-qval">6</span><button type="button" data-step="1">+</button></div></div>' +
        '</div>' +
      '</div>' +

      '<div class="ni-set">' +
        '<div class="ni-fl">' + esc(t('practice.step3')) + '</div>' +
        '<div class="ni-q-head">' +
          '<span class="muted" style="font-size:12px">' + esc(t('practice.qHint')) + '</span>' +
          '<button class="btn btn-ghost" id="ni-gen" type="button">' + esc(t('practice.gen')) + '</button>' +
        '</div>' +
        '<div class="ni-qlist" id="ni-qlist">' +
          '<div class="fa-note">' + esc(t('practice.qEmpty')) + '</div>' +
        '</div>' +
      '</div>' +
    '</div>' +

    // ---- right column: device check ----
    '<div class="devcheck"><div class="ni-fl">' + esc(t('practice.step4')) + '</div>' +
      '<div class="cam-prev">' +
        '<video id="ni-video" playsinline muted style="display:none"></video>' +
        '<div class="frame"></div>' +
        '<div class="silh" id="ni-silh">☺</div>' +
        '<div class="tagrow"><span class="mini-badge" id="ni-cam-badge" style="display:none">' +
          '<span class="dot"></span>' + esc(t('practice.camLive')) + '</span></div>' +
      '</div>' +
      '<div class="levels" id="ni-levels">' + bars + '</div>' +
      '<div class="devlist">' +
        '<div class="devline" id="ni-cam">' +
          '<span class="nm">📷 <span class="t">' + esc(t('practice.camera')) + '</span></span>' +
          '<span class="chip warn"><span class="dot"></span>' + esc(t('practice.idle')) + '</span>' +
        '</div>' +
        '<div class="devline" id="ni-mic">' +
          '<span class="nm">🎙 <span class="t">' + esc(t('practice.mic')) + '</span></span>' +
          '<span class="chip warn"><span class="dot"></span>' + esc(t('practice.idle')) + '</span>' +
        '</div>' +
        '<div class="devline">' +
          '<span class="nm">⚙ <span class="t">' + esc(t('practice.engine')) + '</span></span>' +
          '<span class="chip face"><span class="dot"></span>MediaPipe</span>' +
        '</div>' +
      '</div>' +
      '<button class="btn btn-ghost" id="ni-test" style="width:100%;margin-top:14px">' + esc(t('practice.testDevices')) + '</button>' +
      '<button class="btn btn-green" id="ni-start" style="width:100%;margin-top:10px">' + esc(t('practice.start')) + '</button>' +
    '</div>' +

    '</div></div></div>';
}
