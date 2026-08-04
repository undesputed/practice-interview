import { api } from '../api.js';
import { esc } from '../util.js';
import { fmtDate, fmtDuration, scoreClass } from '../format.js';
import { svgLineChart } from '../charts.js';
import { t, bandLabel, currentLang, localizeRole } from '../i18n.js';

function looksJapanese(s){
  return /[\u3040-\u30ff\u3400-\u9fff]/.test(String(s || ''));
}

/** True when LLM prose is already Japanese (or there is nothing to translate). */
function feedbackLooksJapanese(vd){
  if (!vd) return true;
  const sample = [vd.headline, vd.next_action, vd.delivery_note, vd.presence_note, vd.content_note]
    .concat(vd.improvements || [])
    .concat(vd.strengths || [])
    .filter(Boolean)
    .join(' ');
  if (!sample.trim()) return true;
  return looksJapanese(sample);
}

function applyLocaleOverlay(s, lang){
  if (lang !== 'ja') return s;
  const out = Object.assign({}, s);
  const vLoc = s.verdict_ja;
  const cLoc = s.coaching_ja;
  if (vLoc && s.verdict){
    out.verdict = Object.assign({}, s.verdict, vLoc);
  }
  if (cLoc){
    out.coaching = s.coaching ? Object.assign({}, s.coaching, cLoc) : cLoc;
  }
  return out;
}

async function loadSessionForDisplay(id, onStatus){
  let s = await api.getSession(id);
  if (currentLang() !== 'ja') return s;

  // Prefer a cached Japanese translation when it actually looks Japanese.
  if (s.verdict_ja && feedbackLooksJapanese(s.verdict_ja)){
    return applyLocaleOverlay(s, 'ja');
  }
  // Already Japanese prose — no API call needed.
  if (feedbackLooksJapanese(s.verdict)){
    return s;
  }

  // English (or mixed) LLM prose — translate + cache, then overlay.
  // Do NOT trust session.language === 'ja': Claude sometimes still wrote English.
  if (onStatus) onStatus(t('report.translating'));
  try {
    s = await api.localizeSession(id, 'ja');
    // Guard: if the API returned English again, surface a soft warning in console.
    if (!feedbackLooksJapanese(s.verdict)){
      console.warn('[report] localize returned non-Japanese prose');
    }
  } catch (err){
    console.warn('[report] localize failed — showing English LLM prose', err);
    if (onStatus) onStatus(t('report.translateFail'));
    // Brief pause so the user can see the message before English content paints.
    await new Promise((r) => setTimeout(r, 1200));
  }
  return s;
}

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
  if (a >= 72) return { label: t('report.engage.high'), cls: 'good', text: t('report.engage.highText') };
  if (a >= 52) return { label: t('report.engage.mid'), cls: 'mid', text: t('report.engage.midText') };
  return { label: t('report.engage.low'), cls: 'low', text: t('report.engage.lowText') };
}

function engagementSection(o, timing){
  const eyePct = o.gaze_eye_contact_pct;
  const speakingPct = timing.speaking_pct;
  const response = timing.mean_response_sec;
  const facePct = o.face_presence_pct;
  const lvl = engageLevel(eyePct, speakingPct, o.attention);
  const stat = (val, lbl) =>
    '<div class="engage-item"><div class="engage-val">' + esc(String(val ?? '—')) + '</div>' +
    '<div class="engage-lbl">' + esc(lbl) + '</div></div>';
  return '<div class="engage-card">' +
    '<div class="engage-head">' +
      '<div><h3>' + esc(t('report.engagement')) + '</h3><p class="engage-sub">' + esc(t('report.engageSub')) + '</p></div>' +
      '<span class="engage-badge ' + lvl.cls + '">' + esc(lvl.label) + '</span>' +
    '</div>' +
    '<div class="engage-grid">' +
      stat(eyePct != null ? eyePct + '%' : null, t('report.eyeContact')) +
      stat(speakingPct != null ? speakingPct + '%' : null, t('report.spokePct')) +
      stat(response != null ? response + 's' : null, t('report.avgRespond')) +
      stat(facePct != null ? facePct + '%' : null, t('report.faceVisible')) +
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

  const eyeText = eyePct >= 80 ? t('report.impr.eyeHigh', { pct: eyePct }) :
                  eyePct >= 60 ? t('report.impr.eyeMid', { pct: eyePct }) :
                  eyePct != null ? t('report.impr.eyeLow', { pct: eyePct }) :
                  t('report.impr.eyeNone');

  const bodyText = composure >= 75 ? t('report.impr.bodyHigh') :
                   composure >= 50 ? t('report.impr.bodyMid') :
                   composure != null ? t('report.impr.bodyLow') :
                   t('report.impr.bodyNone');
  const bodyDetail = upright != null ? t('report.impr.upright', { pct: upright }) : null;

  const smileText = smilePct >= 30 ? t('report.impr.smileHigh', { pct: smilePct }) :
                    smilePct >= 10 ? t('report.impr.smileMid', { pct: smilePct }) :
                    smilePct != null ? t('report.impr.smileLow', { pct: smilePct }) :
                    t('report.impr.smileNone');

  const emoText = dominant
    ? t('report.impr.emoHas', {
        dom: dominant,
        compound: compound ? t('report.impr.emoCompound', { c: compound }) : '',
      })
    : t('report.impr.emoNone');

  return '<div class="impr-grid">' +
    impression(t('report.impr.eye'), eyeText) +
    impression(t('report.impr.body'), bodyText, bodyDetail) +
    impression(t('report.impr.face'), smileText) +
    impression(t('report.impr.emo'), emoText) +
    '</div>';
}

// ── Voice card ────────────────────────────────────────────────────────────────
function voiceCard(v){
  if (!v || !v.available) return '<p class="muted" style="font-size:12px">' + esc(t('report.voice.na')) + '</p>';
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
    row(t('report.voice.speed'),
      wpm != null ? wpm + ' wpm' : null,
      wpm == null ? '' : wpm < 110 ? t('report.voice.slow') : wpm > 160 ? t('report.voice.fast') : t('report.voice.paceOk'),
      wpm == null ? '' : (wpm < 110 || wpm > 160) ? 'warn' : 'good') +
    row(t('report.voice.fillers'),
      fillers != null ? t('report.voice.per100', { n: fillers }) : null,
      fillers == null ? '' : fillers <= 3 ? t('report.voice.fillOk') : fillers <= 6 ? t('report.voice.fillMid') : t('report.voice.fillBad'),
      fillers == null ? '' : fillers <= 3 ? 'good' : fillers > 6 ? 'warn' : '') +
    row(t('report.voice.pauses'),
      pauses != null ? String(pauses) : null,
      pauses == null ? '' : pauses === 0 ? t('report.voice.pauseNone') : pauses <= 2 ? t('report.voice.pauseOk') : t('report.voice.pauseBad'),
      pauses == null ? '' : pauses === 0 ? 'good' : pauses > 2 ? 'warn' : '') +
    row(t('report.voice.variety'),
      pitch != null ? t('report.voice.hzVar', { n: pitch }) : null,
      pitch == null ? '' : pitch >= 25 ? t('report.voice.pitchOk') : t('report.voice.pitchFlat'),
      pitch == null ? '' : pitch >= 25 ? 'good' : 'warn') +
    '</div>' +
    '<p class="muted" style="font-size:11px;margin-top:10px">' + esc(t('report.voice.privacy')) + '</p>';
}

// ── Facial signals (replaces raw FACS / Action Units) ────────────────────────
function facialSignals(aus){
  if (!aus || !aus.length) return '<p class="muted" style="font-size:12px">' + esc(t('report.facs.na')) + '</p>';
  const top = aus.slice().sort((a, b) => (b.peak || 0) - (a.peak || 0)).slice(0, 6);
  return '<div class="facs-list">' +
    top.map((a) => {
      const lk = (a.level || 'A').toLowerCase();
      const lvlKey = 'report.facs.' + (a.level || 'A');
      return '<div class="facs-item">' +
        '<span class="facs-name">' + esc(a.name) + '</span>' +
        '<span class="facs-lvl lv-' + lk + '">' + esc(t(lvlKey)) + '</span>' +
        '</div>';
    }).join('') +
    '</div>';
}

// ── Emotion bars ──────────────────────────────────────────────────────────────
function emotionBars(emo){
  if (!emo || !emo.available) return '<p class="muted" style="font-size:12px">' + esc(t('report.emo.na')) + '</p>';
  const dist = emo.overall_distribution || {};
  const items = Object.keys(dist).map((k) => [k, dist[k]]).sort((a, b) => b[1] - a[1]);
  return '<p style="font-size:12px;margin-bottom:10px">' + esc(t('report.emo.overall')) + ' <b>' + esc(emo.dominant || '—') + '</b></p>' +
    items.map((it) => '<div class="emrow"><span>' + esc(it[0]) + '</span>' +
      '<span class="track"><span class="fill" style="width:' + Math.max(0, Math.min(100, it[1])) + '%"></span></span>' +
      '<span class="val">' + Math.round(it[1]) + '%</span></div>').join('');
}

// ── CEO-scannable executive brief (added above full verdict) ──────────────────
function execBrief(vd){
  if (!vd || vd.readiness_score == null) return '';
  const band = vd.band || 'needs_work';
  const focus = (vd.improvements || []).slice(0, 3)
    .map((x) => '<li>' + esc(x) + '</li>').join('');
  return '<div class="exec-brief verdict-' + band + '">' +
    '<div class="exec-kicker">' + esc(t('report.execTitle')) +
      '<span class="exec-kicker-sub">' + esc(t('report.execSub')) + '</span></div>' +
    '<div class="exec-row">' +
      '<div class="exec-score">' + Math.round(vd.readiness_score) + '<span>/100</span></div>' +
      '<div class="exec-copy">' +
        '<div class="exec-band">' + esc(bandLabel(band)) + '</div>' +
        (vd.headline ? '<div class="exec-hl">' + esc(vd.headline) + '</div>' : '') +
      '</div>' +
    '</div>' +
    (focus
      ? '<div class="exec-focus"><div class="exec-focus-label">' + esc(t('report.focus')) + '</div>' +
        '<ul>' + focus + '</ul></div>'
      : '') +
    (vd.next_action
      ? '<div class="exec-next"><span>' + esc(t('report.tryNext')) + '</span> ' +
        esc(vd.next_action) + '</div>'
      : '') +
    '</div>';
}

// ── Readiness verdict (full detail — kept for context) ────────────────────────
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
    '<div class="v-detail-label">' + esc(t('report.detailTitle')) + '</div>' +
    '<div class="vhead"><div class="vscore">' + Math.round(vd.readiness_score) + '<span>/100</span></div>' +
      '<div class="vband"><div class="vlabel">' + esc(bandLabel(band)) + '</div>' +
      '<div class="vhl">' + esc(vd.headline || '') + '</div></div></div>' +
    '<div class="vsubs">' +
      sub(t('report.voice'), comp.delivery) +
      sub(t('report.presence'), comp.presence) +
      sub(t('report.content'), comp.content) +
    '</div>' +
    (notes ? '<ul class="vnotes">' + notes + '</ul>' : '') +
    (str   ? '<h5>' + esc(t('report.didWell')) + '</h5><ul>' + str + '</ul>' : '') +
    (imp   ? '<h5>' + esc(t('report.workOn')) + '</h5><ul>' + imp + '</ul>' : '') +
    (vd.next_action ? '<p class="vnext"><b>' + esc(t('report.nextAction')) + '</b> ' + esc(vd.next_action) + '</p>' : '') +
    '<p class="muted" style="font-size:11px;margin-top:10px">' + esc(t('report.disclaimer')) + '</p>' +
    '</div>';
}

// ── Scoring breakdown (plain-English pillar labels) ───────────────────────────
function rateLabels(){ return { good: t('report.good'), mid: t('report.ok'), low: t('report.low') }; }
function rate01(s){ return s >= 0.70 ? 'good' : s >= 0.50 ? 'mid' : 'low'; }

function sbkRow(label, score01, valueText, targetText){
  const r   = rate01(score01);
  const pct = Math.round(Math.max(0, Math.min(1, score01)) * 100);
  const RLABEL = rateLabels();
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
    const RLABEL = rateLabels();
    return '<div class="sbk-pillar"><div class="sbk-head">' +
      '<span class="sbk-pname">' + esc(name) + '</span>' +
      '<span class="sbk-weight">' + wPct(key) + ' ' + esc(t('report.ofScore')) + '</span>' +
      '<span class="sbk-score">' + (has ? Math.round(score) : '—') + '<small>/100</small></span>' +
      (has ? '<span class="sbk-rate ' + r + '">' + RLABEL[r] + '</span>'
           : '<span class="sbk-rate muted">' + esc(t('report.notCaptured')) + '</span>') +
      '</div>' + (rows || '') + '</div>';
  };
  return '<div class="chart-card sbk"><div class="ct">' + esc(t('report.scoreHow')) + '</div>' +
    '<div class="cs">' + esc(t('report.scoreHowBody', { d: wPct('delivery'), p: wPct('presence'), c: wPct('content') })) + '</div>' +
    pillar(t('report.pillar.delivery'), 'delivery', deliveryRows(v)) +
    pillar(t('report.pillar.presence'),  'presence', presenceRows(o)) +
    pillar(t('report.pillar.content'),   'content',  contentRows(vd)) +
    '</div>';
}

// ── Per-question table (simplified columns) ───────────────────────────────────
function perQuestionTable(perQ, timing){
  if (!perQ || !perQ.length) return '';
  const rows = perQ.map((q) => {
    const m  = q.metrics || {};
    const rt = (timing.per_question_response_sec || [])[q.turn];
    return '<tr><td>' + esc(q.question || ('Q' + (q.turn + 1))) + '</td>' +
      '<td>' + (m.gaze_eye_contact_pct != null ? m.gaze_eye_contact_pct + '%' : '—') + '</td>' +
      '<td>' + (m.composure != null ? m.composure + '/100' : '—') + '</td>' +
      '<td>' + (rt != null ? rt + 's' : '—') + '</td></tr>';
  }).join('');
  return '<div class="chart-card"><div class="ct">' + esc(t('report.perQ')) + '</div>' +
    '<div class="cs">' + esc(t('report.perQSub')) + '</div>' +
    '<table class="data"><thead><tr>' +
      '<th>' + esc(t('report.qCol')) + '</th><th>' + esc(t('report.eyeCol')) + '</th>' +
      '<th>' + esc(t('report.compCol')) + '</th><th>' + esc(t('report.respCol')) + '</th>' +
    '</tr></thead><tbody>' + rows + '</tbody></table></div>';
}

// ── AI coaching ───────────────────────────────────────────────────────────────
function coachSection(c){
  if (!c) return '<div class="coach"><p class="muted">' + esc(t('report.coach.na')) + '</p></div>';
  return '<div class="coach">' +
    '<span class="badge">★ AI Coach · ' + (c.score == null ? '—' : esc(String(c.score))) + '/10</span>' +
    '<p>' + esc(c.summary || '') + '</p>' +
    (c.strengths    && c.strengths.length    ? '<h5>' + esc(t('report.didWell')) + '</h5><ul>'    + c.strengths.map((x)    => '<li>' + esc(x) + '</li>').join('') + '</ul>' : '') +
    (c.improvements && c.improvements.length ? '<h5>' + esc(t('report.workOn')) + '</h5><ul>' + c.improvements.map((x) => '<li>' + esc(x) + '</li>').join('') + '</ul>' : '') +
    '</div>';
}

// ── Main view ─────────────────────────────────────────────────────────────────
function view(s){
  const o   = s.overall || {};
  const timing = s.timing  || {};
  const v   = s.voice   || { available: false };
  const aus = s.action_units || [];
  const vd  = s.verdict  || null;
  const c   = s.coaching || null;
  const title = esc(localizeRole(s.label || s.role || null));
  const perQ  = s.per_question || [];
  const composureSeries = perQ.map((q) => (q.metrics || {}).composure);
  const calm = o.nervousness != null ? Math.round(100 - o.nervousness) : null;

  return '<a class="backlink" href="#/history">' + esc(t('common.backHistory')) + '</a>' +
    '<div class="screen-head"><div><h1>' + title + '</h1>' +
      '<div class="muted" style="font-size:12.5px">' + esc(fmtDate(s.created_at)) +
        ' · ' + perQ.length + ' ' + esc(t('common.questions')) + ' · ' + esc(fmtDuration(s.duration_sec)) + '</div></div>' +
      '<button class="btn btn-ghost" onclick="window.print()">' + esc(t('common.exportPdf')) + '</button></div>' +

    // ① Score summary cards
    '<div class="score-cards">' +
      scoreCard(t('report.attention'),  t('report.attentionHint'),  'attention',  o.attention)  +
      scoreCard(t('report.confidence'), t('report.confidenceHint'), 'confidence', o.confidence) +
      scoreCard(t('report.composure'),  t('report.composureHint'),  'composure',  o.composure)  +
      scoreCard(t('report.calm'),       t('report.calmHint'),       'composure',  calm)         +
    '</div>' +

    // ② CEO glance card (score + headline + focus) — then full verdict detail
    execBrief(vd) +
    verdictHeader(vd) +

    // ③ Engagement
    engagementSection(o, timing) +

    // ④ Score breakdown
    scoringBreakdown(vd, o, v) +

    // ⑤ How you came across
    '<div class="chart-card"><div class="ct">' + esc(t('report.howCame')) + '</div>' +
      '<div class="cs">' + esc(t('report.howCameSub')) + '</div>' +
      howYouCameAcross(o, s) + '</div>' +

    // ⑥ AI coaching (shown when verdict is absent)
    (vd && vd.readiness_score != null ? '' : coachSection(c)) +

    // ⑦ Composure trend
    '<div class="chart-card"><div class="ct">' + esc(t('report.composureTrend')) + '</div>' +
      '<div class="cs">' + esc(t('report.composureTrendSub')) + '</div>' +
      svgLineChart(composureSeries) + '</div>' +

    // ⑧ Per-question table
    perQuestionTable(perQ, timing) +

    // ⑨ Voice details
    '<div class="chart-card"><div class="ct">' + esc(t('report.voiceTitle')) + '</div>' +
      '<div class="cs">' + esc(t('report.voiceSub')) + '</div>' +
      voiceCard(v) + '</div>' +

    // ⑩ Emotional tone
    '<div class="chart-card"><div class="ct">' + esc(t('report.emoTitle')) + '</div>' +
      '<div class="cs">' + esc(t('report.emoSub')) + '</div>' +
      emotionBars(s.emotion_mediapipe) + '</div>' +

    // ⑪ Facial signals
    '<div class="chart-card"><div class="ct">' + esc(t('report.facsTitle')) + '</div>' +
      '<div class="cs">' + esc(t('report.facsSub')) + '</div>' +
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
      const s = await loadSessionForDisplay(id, (msg) => {
        if (document.body.contains(root)) root.innerHTML = '<p class="muted">' + esc(msg) + '</p>';
      });
      if (!document.body.contains(root)) return;
      root.innerHTML = view(s);
    } catch (e){
      const msg = String(e.message || e);
      root.innerHTML = '<a class="backlink" href="#/history">' + esc(t('common.backHistory')) + '</a>' +
        '<div class="placeholder-card"><p>' +
        esc(msg.indexOf('404') >= 0 ? t('common.sessionMissing') : t('common.loadFailed')) +
        '</p><p class="muted">' + esc(msg) + '</p></div>';
    }
  });
  return '<div class="screen" id="report-body"><p class="muted">' + esc(t('common.loading')) + '</p></div>';
}
