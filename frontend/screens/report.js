import { api } from '../api.js';
import { esc } from '../util.js';
import { fmtDate, fmtDuration, scoreClass } from '../format.js';
import { svgLineChart } from '../charts.js';

// ── Score cards ───────────────────────────────────────────────────────────────
function scoreCard(label, hint, key, v){
  const sc = scoreClass(key, v);
  const cls = sc === 'good' ? '' : sc;
  const pct = v == null ? 0 : Math.max(0, Math.min(100, v));
  return '<div class="score-card">' +
    '<div class="n">' + (v == null ? '—' : Math.round(v)) + '</div>' +
    '<div class="l">' + esc(label) + '</div>' +
    '<div class="score-hint">' + esc(hint) + '</div>' +
    '<div class="bar"><i class="' + cls + '" style="width:' + pct + '%"></i></div>' +
    '</div>';
}

// ── Engagement section ────────────────────────────────────────────────────────
function engageLevel(eyePct, speakingPct, attention){
  const a = ((eyePct || 0) + (speakingPct || 0) + (attention || 0)) / 3;
  if (a >= 72) return { label: 'Highly engaged', cls: 'good',
    text: 'You showed strong signs of active participation — solid eye contact, speaking a healthy amount, and staying alert.' };
  if (a >= 52) return { label: 'Moderately engaged', cls: 'mid',
    text: 'Your engagement was decent. A bit more eye contact or speaking more actively could make you feel even more present.' };
  return { label: 'Low engagement', cls: 'low',
    text: 'Engagement seemed low during this session. Try to keep your eyes toward the camera and respond more actively to each question.' };
}

function engagementSection(o, t){
  const eyePct = o.gaze_eye_contact_pct;
  const speakingPct = t.speaking_pct;
  const response = t.mean_response_sec;
  const facePct = o.face_presence_pct;
  const lvl = engageLevel(eyePct, speakingPct, o.attention);
  const stat = (val, lbl) =>
    '<div class="engage-item"><div class="engage-val">' + esc(String(val ?? '—')) + '</div>' +
    '<div class="engage-lbl">' + esc(lbl) + '</div></div>';
  return '<div class="engage-card">' +
    '<div class="engage-head">' +
      '<div><h3>Engagement</h3><p class="engage-sub">How present and active you were during the session</p></div>' +
      '<span class="engage-badge ' + lvl.cls + '">' + esc(lvl.label) + '</span>' +
    '</div>' +
    '<div class="engage-grid">' +
      stat(eyePct != null ? eyePct + '%' : null, 'eye contact with camera') +
      stat(speakingPct != null ? speakingPct + '%' : null, 'of session you spoke') +
      stat(response != null ? response + 's' : null, 'avg time to respond') +
      stat(facePct != null ? facePct + '%' : null, 'face visible in frame') +
    '</div>' +
    '<p class="engage-desc">' + esc(lvl.text) + '</p>' +
    '</div>';
}

// ── How you came across (replaces the raw metric cat-cards) ──────────────────
function impression(title, text, detail){
  return '<div class="impr-card">' +
    '<div class="impr-title">' + esc(title) + '</div>' +
    '<div class="impr-text">' + esc(text) + '</div>' +
    (detail ? '<div class="impr-detail">' + esc(detail) + '</div>' : '') +
    '</div>';
}

function howYouCameAcross(o, s){
  const eyePct     = o.gaze_eye_contact_pct;
  const smilePct   = o.pct_smiling;
  const composure  = o.composure;
  const upright    = o.upright_pct;
  const emoMp      = s.emotion_mediapipe;
  const dominant   = emoMp && emoMp.dominant;
  const compound   = s.emotion_compound && s.emotion_compound.label;

  const eyeText = eyePct >= 80 ? 'Strong — you kept your eyes toward the camera ' + eyePct + '% of the time. This reads as confident and engaged.' :
                  eyePct >= 60 ? 'Decent at ' + eyePct + '%. Try to look at your camera lens more directly — it signals confidence.' :
                  eyePct != null ? 'Low at ' + eyePct + '%. Practice looking at the camera rather than the screen to appear more engaged.' :
                  'No eye-contact data captured for this session.';

  const bodyText = composure >= 75 ? 'Calm and controlled — your posture and head stayed mostly still, which projects confidence.' :
                   composure >= 50 ? 'Mostly steady. Some movement was detected — try to relax and avoid fidgeting.' :
                   composure != null ? 'Some restlessness was picked up. Try sitting upright, keeping your hands still, and breathing slowly.' :
                   'Posture data not available.';
  const bodyDetail = upright != null ? 'Sat upright ' + upright + '% of the time' : null;

  const smileText = smilePct >= 30 ? 'Warm and expressive — you smiled ' + smilePct + '% of the session, which makes you seem friendly and enthusiastic.' :
                    smilePct >= 10 ? 'Mostly neutral (' + smilePct + '% smiling). A little more natural smiling — especially when listening — would help you seem more approachable.' :
                    smilePct != null ? 'Very little smiling detected (' + smilePct + '%). Occasional smiling makes a big difference in how likeable you come across.' :
                    'Smile data not available.';

  const emoText = dominant
    ? 'Your face mostly expressed ' + dominant + (compound ? ' — overall you came across as ' + compound + '.' : '.') + ' This is an approximate reading based on facial muscle movement.'
    : 'Emotional tone data not available for this session.';

  return '<div class="impr-grid">' +
    impression('Eye contact', eyeText) +
    impression('Body language & posture', bodyText, bodyDetail) +
    impression('Facial expression', smileText) +
    impression('Emotional tone', emoText) +
    '</div>';
}

// ── Voice card (plain-English labels) ────────────────────────────────────────
function voiceCard(v){
  if (!v || !v.available) return '<p class="muted" style="font-size:12px">Voice analysis was not available for this session.</p>';
  const m = v.metrics || {};
  const wpm    = m.wpm;
  const fillers = m.filler_rate_per100;
  const pauses  = m.long_pause_count;
  const pitch   = m.pitch_std_hz;

  const row = (label, val, note, cls) =>
    '<div class="vc-row">' +
    '<span class="vc-lbl">' + esc(label) + '</span>' +
    '<span class="vc-val">' + esc(val ?? '—') + '</span>' +
    '<span class="vc-note ' + (cls || '') + '">' + esc(note || '') + '</span>' +
    '</div>';

  return '<div class="vc-grid">' +
    row('Speaking speed',
      wpm != null ? wpm + ' wpm' : null,
      wpm == null ? '' : wpm < 110 ? 'a bit slow — try speaking more naturally' : wpm > 160 ? 'a bit fast — try slowing down slightly' : 'good pace',
      wpm == null ? '' : (wpm < 110 || wpm > 160) ? 'warn' : 'good') +
    row('Filler words (um, uh, like…)',
      fillers != null ? fillers + ' per 100 words' : null,
      fillers == null ? '' : fillers <= 3 ? 'excellent' : fillers <= 6 ? 'decent' : 'try to reduce these',
      fillers == null ? '' : fillers <= 3 ? 'good' : fillers > 6 ? 'warn' : '') +
    row('Long silences (over 2 sec)',
      pauses != null ? String(pauses) : null,
      pauses == null ? '' : pauses === 0 ? 'none — great!' : pauses <= 2 ? 'fine' : 'aim for 2 or fewer',
      pauses == null ? '' : pauses === 0 ? 'good' : pauses > 2 ? 'warn' : '') +
    row('Vocal variety',
      pitch != null ? pitch + ' Hz variation' : null,
      pitch == null ? '' : pitch >= 25 ? 'expressive' : 'a bit flat — try varying your tone more',
      pitch == null ? '' : pitch >= 25 ? 'good' : 'warn') +
    '</div>' +
    '<p class="muted" style="font-size:11px;margin-top:10px">Your audio was analyzed and then deleted — it is never stored.</p>';
}

// ── Facial signals (replaces raw FACS / Action Units) ────────────────────────
const FACS_LEVEL = { A: 'barely noticeable', B: 'slight', C: 'noticeable', D: 'strong', E: 'very strong' };

function facialSignals(aus){
  if (!aus || !aus.length) return '<p class="muted" style="font-size:12px">No facial-signal data for this session.</p>';
  const top = aus.slice().sort((a, b) => (b.peak || 0) - (a.peak || 0)).slice(0, 6);
  return '<div class="facs-list">' +
    top.map((a) => {
      const lk = (a.level || 'A').toLowerCase();
      return '<div class="facs-item">' +
        '<span class="facs-name">' + esc(a.name) + '</span>' +
        '<span class="facs-lvl lv-' + lk + '">' + esc(FACS_LEVEL[a.level] || a.level) + '</span>' +
        '</div>';
    }).join('') +
    '</div>';
}

// ── Emotion bars ──────────────────────────────────────────────────────────────
function emotionBars(emo){
  if (!emo || !emo.available) return '<p class="muted" style="font-size:12px">Emotional tone data not available.</p>';
  const dist = emo.overall_distribution || {};
  const items = Object.keys(dist).map((k) => [k, dist[k]]).sort((a, b) => b[1] - a[1]);
  return '<p style="font-size:12px;margin-bottom:10px">Overall tone: <b>' + esc(emo.dominant || '—') + '</b></p>' +
    items.map((it) => '<div class="emrow"><span>' + esc(it[0]) + '</span>' +
      '<span class="track"><span class="fill" style="width:' + Math.max(0, Math.min(100, it[1])) + '%"></span></span>' +
      '<span class="val">' + Math.round(it[1]) + '%</span></div>').join('');
}

// ── Readiness verdict ─────────────────────────────────────────────────────────
const BAND_LABEL = { ready: 'Interview ready', almost: 'Almost there', needs_work: 'Needs more practice' };

function verdictHeader(vd){
  if (!vd || vd.readiness_score == null) return '';
  const band = vd.band || 'needs_work';
  const comp = vd.components || {};
  const sub = (label, val) => '<div class="vsub"><span>' + label + '</span><b>' +
    (val == null ? '—' : Math.round(val)) + '</b></div>';
  const notes = [vd.delivery_note, vd.presence_note, vd.content_note]
    .filter(Boolean).map((n) => '<li>' + esc(n) + '</li>').join('');
  const str  = (vd.strengths    || []).map((x) => '<li>' + esc(x) + '</li>').join('');
  const imp  = (vd.improvements || []).map((x) => '<li>' + esc(x) + '</li>').join('');
  return '<div class="verdict verdict-' + band + '">' +
    '<div class="vhead"><div class="vscore">' + Math.round(vd.readiness_score) + '<span>/100</span></div>' +
      '<div class="vband"><div class="vlabel">' + esc(BAND_LABEL[band] || band) + '</div>' +
      '<div class="vhl">' + esc(vd.headline || '') + '</div></div></div>' +
    '<div class="vsubs">' +
      sub('Voice & delivery', comp.delivery) +
      sub('On-camera presence', comp.presence) +
      sub('Answer quality', comp.content) +
    '</div>' +
    (notes ? '<ul class="vnotes">' + notes + '</ul>' : '') +
    (str   ? '<h5>What you did well</h5><ul>' + str + '</ul>' : '') +
    (imp   ? '<h5>What to work on</h5><ul>' + imp + '</ul>' : '') +
    (vd.next_action ? '<p class="vnext"><b>Try this next:</b> ' + esc(vd.next_action) + '</p>' : '') +
    '<p class="muted" style="font-size:11px;margin-top:10px">This is practice feedback to help you improve — not a hiring decision.</p>' +
    '</div>';
}

// ── Scoring breakdown (plain-English pillar labels) ───────────────────────────
const RLABEL = { good: 'Good', mid: 'OK', low: 'Low' };
function rate01(s){ return s >= 0.70 ? 'good' : s >= 0.50 ? 'mid' : 'low'; }

function sbkRow(label, score01, valueText, targetText){
  const r   = rate01(score01);
  const pct = Math.round(Math.max(0, Math.min(1, score01)) * 100);
  return '<div class="sbk-row"><span class="sbk-name">' + esc(label) + '</span>' +
    '<span class="sbk-bar"><i class="' + (r === 'good' ? '' : r) + '" style="width:' + pct + '%"></i></span>' +
    '<span class="sbk-rrate ' + r + '">' + RLABEL[r] + '</span>' +
    '<span class="sbk-val">' + esc(valueText) + '</span>' +
    '<span class="sbk-target">' + esc(targetText || '') + '</span></div>';
}

const DELIVERY_META = {
  pace:    (m) => ['Speaking speed',         (m.wpm ?? '—') + ' wpm',              'ideal: 110–160 wpm'],
  fillers: (m) => ['Filler words',           (m.filler_rate_per100 ?? '—') + '/100', 'aim: under 3'],
  pauses:  (m) => ['Long silences',          String(m.long_pause_count ?? '—'),     'aim: 2 or fewer'],
  pitch:   (m) => ['Vocal variety',          (m.pitch_std_hz ?? '—') + ' Hz',       'aim: 25+ Hz'],
  energy:  (m) => ['Voice projection',       String(m.energy_mean ?? '—'),          'aim: 0.02+'],
};

function deliveryRows(v){
  if (!v || !v.available || !Array.isArray(v.breakdown)) return '';
  const m = v.metrics || {};
  return v.breakdown.map((b) => {
    const meta = DELIVERY_META[b.key]; if (!meta) return '';
    const [label, val, target] = meta(m);
    return sbkRow(label, b.score, val, target);
  }).join('');
}

function presenceRows(o){
  const rows = [];
  const add = (label, val, hint) => {
    if (typeof val === 'number') rows.push(sbkRow(label, val / 100, Math.round(val) + '/100', hint));
  };
  add('Attention & focus',    o.attention,   'were you alert and present?');
  add('Confidence',           o.confidence,  'did your body show assurance?');
  add('Composure',            o.composure,   'did you stay calm and steady?');
  if (typeof o.nervousness === 'number')
    rows.push(sbkRow('Calm (vs nervous)', (100 - o.nervousness) / 100,
      Math.round(100 - o.nervousness) + '/100', 'higher = more relaxed'));
  return rows.join('');
}

function contentRows(vd){
  if (vd.content_score == null)
    return '<div class="sbk-row"><span class="sbk-name">Answer quality</span>' +
      '<span class="sbk-note muted">Not scored — needs the AI coach (ANTHROPIC_API_KEY).</span></div>';
  return sbkRow('Answer quality', vd.content_score / 100, vd.content_score + '/100',
    'clarity · structure · relevance');
}

function scoringBreakdown(vd, o, v){
  if (!vd || vd.readiness_score == null) return '';
  const w = vd.weights_used || {};
  const comp = vd.components || {};
  const wPct = (k) => typeof w[k] === 'number' ? Math.round(w[k] * 100) + '%' : '—';
  const pillar = (name, key, rows) => {
    const score = comp[key];
    const has   = typeof score === 'number';
    const r     = has ? rate01(score / 100) : null;
    return '<div class="sbk-pillar"><div class="sbk-head">' +
      '<span class="sbk-pname">' + esc(name) + '</span>' +
      '<span class="sbk-weight">' + wPct(key) + ' of score</span>' +
      '<span class="sbk-score">' + (has ? Math.round(score) : '—') + '<small>/100</small></span>' +
      (has ? '<span class="sbk-rate ' + r + '">' + RLABEL[r] + '</span>'
           : '<span class="sbk-rate muted">not captured</span>') +
      '</div>' + (rows || '') + '</div>';
  };
  return '<div class="chart-card sbk"><div class="ct">How your score is calculated</div>' +
    '<div class="cs">Your readiness score combines three things: <b>how you sounded</b> (' + wPct('delivery') + '), ' +
      '<b>how you looked on camera</b> (' + wPct('presence') + '), and ' +
      '<b>what you actually said</b> (' + wPct('content') + '). ' +
      'If one signal wasn\'t captured, the others carry more weight. ' +
      'Scores: 70+ = interview ready · 50–69 = almost there · under 50 = needs more practice.</div>' +
    pillar('How you sounded — voice & delivery',   'delivery', deliveryRows(v)) +
    pillar('How you looked — on-camera presence',  'presence', presenceRows(o)) +
    pillar('What you said — answer quality',        'content',  contentRows(vd)) +
    '</div>';
}

// ── Per-question table (simplified columns) ───────────────────────────────────
function perQuestionTable(perQ, t){
  if (!perQ || !perQ.length) return '';
  const rows = perQ.map((q) => {
    const m  = q.metrics || {};
    const rt = (t.per_question_response_sec || [])[q.turn];
    return '<tr><td>' + esc(q.question || ('Q' + (q.turn + 1))) + '</td>' +
      '<td>' + (m.gaze_eye_contact_pct != null ? m.gaze_eye_contact_pct + '%' : '—') + '</td>' +
      '<td>' + (m.composure != null ? m.composure + '/100' : '—') + '</td>' +
      '<td>' + (rt != null ? rt + 's' : '—') + '</td></tr>';
  }).join('');
  return '<div class="chart-card"><div class="ct">Question by question</div>' +
    '<div class="cs">A snapshot of how you performed on each question.</div>' +
    '<table class="data"><thead><tr>' +
      '<th>Question</th><th>Eye contact</th><th>Composure</th><th>Response time</th>' +
    '</tr></thead><tbody>' + rows + '</tbody></table></div>';
}

// ── AI coaching ───────────────────────────────────────────────────────────────
function coachSection(c){
  if (!c) return '<div class="coach"><p class="muted">AI coaching was not generated for this session.</p></div>';
  return '<div class="coach">' +
    '<span class="badge">★ AI Coach · ' + (c.score == null ? '—' : esc(String(c.score))) + '/10</span>' +
    '<p>' + esc(c.summary || '') + '</p>' +
    (c.strengths    && c.strengths.length    ? '<h5>What you did well</h5><ul>'    + c.strengths.map((x)    => '<li>' + esc(x) + '</li>').join('') + '</ul>' : '') +
    (c.improvements && c.improvements.length ? '<h5>What to work on</h5><ul>' + c.improvements.map((x) => '<li>' + esc(x) + '</li>').join('') + '</ul>' : '') +
    '</div>';
}

// ── Main view ─────────────────────────────────────────────────────────────────
function view(s){
  const o   = s.overall || {};
  const t   = s.timing  || {};
  const v   = s.voice   || { available: false };
  const aus = s.action_units || [];
  const vd  = s.verdict  || null;
  const c   = s.coaching || null;
  const title = esc(s.label || s.role || 'Session');
  const perQ  = s.per_question || [];
  const composureSeries = perQ.map((q) => (q.metrics || {}).composure);
  const calm = o.nervousness != null ? Math.round(100 - o.nervousness) : null;

  return '<a class="backlink" href="#/history">← History</a>' +
    '<div class="screen-head"><div><h1>' + title + '</h1>' +
      '<div class="muted" style="font-size:12.5px">' + esc(fmtDate(s.created_at)) +
        ' · ' + perQ.length + ' questions · ' + esc(fmtDuration(s.duration_sec)) + '</div></div>' +
      '<button class="btn btn-ghost" onclick="window.print()">Export PDF</button></div>' +

    // ① Score summary cards
    '<div class="score-cards">' +
      scoreCard('Attention',  'Were you focused?',       'attention',  o.attention)  +
      scoreCard('Confidence', 'Did you project assurance?', 'confidence', o.confidence) +
      scoreCard('Composure',  'Did you stay steady?',    'composure',  o.composure)  +
      scoreCard('Calm',       'How relaxed were you?',   'composure',  calm)         +
    '</div>' +

    // ② Readiness verdict (Claude prose)
    verdictHeader(vd) +

    // ③ Engagement (NEW — plain-English participation overview)
    engagementSection(o, t) +

    // ④ Score breakdown
    scoringBreakdown(vd, o, v) +

    // ⑤ How you came across (plain-English impressions)
    '<div class="chart-card"><div class="ct">How you came across</div>' +
      '<div class="cs">A plain-English summary of your on-camera presence.</div>' +
      howYouCameAcross(o, s) + '</div>' +

    // ⑥ AI coaching (shown when verdict is absent)
    (vd && vd.readiness_score != null ? '' : coachSection(c)) +

    // ⑦ Composure trend
    '<div class="chart-card"><div class="ct">Composure across questions</div>' +
      '<div class="cs">How calm and steady you looked as each question progressed.</div>' +
      svgLineChart(composureSeries) + '</div>' +

    // ⑧ Per-question table
    perQuestionTable(perQ, t) +

    // ⑨ Voice details
    '<div class="chart-card"><div class="ct">Voice & delivery</div>' +
      '<div class="cs">Based on your recorded audio — how fast you spoke, filler words, silences, and vocal variety.</div>' +
      voiceCard(v) + '</div>' +

    // ⑩ Emotional tone
    '<div class="chart-card"><div class="ct">Emotional tone</div>' +
      '<div class="cs">Estimated from your facial movements during the session. Use this as a rough guide, not a clinical reading.</div>' +
      emotionBars(s.emotion_mediapipe) + '</div>' +

    // ⑪ Facial signals (plain FACS)
    '<div class="chart-card"><div class="ct">Facial signals</div>' +
      '<div class="cs">Which facial muscles were active and how strongly — gives a rough picture of what your face was expressing.</div>' +
      facialSignals(aus) + '</div>' +

    // ⑫ Deep emotion model (optional)
    (s.emotion && s.emotion.available
      ? '<div class="chart-card"><div class="ct">Emotion (deep model)</div>' + emotionBars(s.emotion) + '</div>'
      : '');
}

export function report(params){
  const id = params && params.id;
  queueMicrotask(async () => {
    const root = document.getElementById('report-body');
    if (!root) return;
    try {
      const s = await api.getSession(id);
      if (!document.body.contains(root)) return;
      root.innerHTML = view(s);
    } catch (e){
      const msg = String(e.message || e);
      root.innerHTML = '<a class="backlink" href="#/history">← History</a>' +
        '<div class="placeholder-card"><p>' +
        (msg.indexOf('404') >= 0 ? 'Session not found.' : 'Could not load this session.') +
        '</p><p class="muted">' + esc(msg) + '</p></div>';
    }
  });
  return '<div class="screen" id="report-body"><p class="muted">Loading…</p></div>';
}
