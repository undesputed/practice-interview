import { api } from '../api.js';
import { esc } from '../util.js';
import { fmtDate, fmtDuration, scoreClass } from '../format.js';
import { svgLineChart } from '../charts.js';

function scoreCard(label, key, v){
  const sc = scoreClass(key, v);          // 'good' | 'mid' | 'low' | ''
  const cls = sc === 'good' ? '' : sc;    // the bar is green by default
  const pct = v == null ? 0 : Math.max(0, Math.min(100, v));
  return '<div class="score-card"><div class="n">' + (v == null ? '—' : Math.round(v)) + '</div>' +
    '<div class="l">' + label + '</div>' +
    '<div class="bar"><i class="' + cls + '" style="width:' + pct + '%"></i></div></div>';
}

function cat(title, lines){
  return '<div class="cat"><h4>' + esc(title) + '</h4>' +
    lines.map((l) => '<div class="r"><span>' + esc(l[0]) + '</span><b>' + esc(String(l[1] == null ? '—' : l[1])) + '</b></div>').join('') +
    '</div>';
}

function emotionBars(emo){
  if (!emo || !emo.available) return '<p class="muted" style="font-size:12px">Emotion analysis not available for this session.</p>';
  const dist = emo.overall_distribution || {};
  const items = Object.keys(dist).map((k) => [k, dist[k]]).sort((a, b) => b[1] - a[1]);
  return '<p style="font-size:12px;margin-bottom:10px">Dominant: <b>' + esc(emo.dominant || '—') + '</b></p>' +
    items.map((it) => '<div class="emrow"><span>' + esc(it[0]) + '</span>' +
      '<span class="track"><span class="fill" style="width:' + Math.max(0, Math.min(100, it[1])) + '%"></span></span>' +
      '<span class="val">' + Math.round(it[1]) + '%</span></div>').join('');
}

function voiceCard(v){
  if (!v || !v.available) return '<p class="muted" style="font-size:12px">Voice delivery analysis not available for this session.</p>';
  const m = v.metrics || {};
  const rows = [
    ['Delivery score', (v.delivery_score == null ? '—' : v.delivery_score) + '/100'],
    ['Speaking pace', (m.wpm ?? '—') + ' wpm'],
    ['Filler words', (m.filler_count ?? '—') + ' (' + (m.filler_rate_per100 ?? '—') + '/100 words)'],
    ['Long pauses', (m.long_pause_count ?? '—')],
    ['Pitch variation', (m.pitch_std_hz ?? '—') + ' Hz'],
  ];
  return rows.map((r) => '<div class="r"><span>' + esc(r[0]) + '</span><b>' + esc(String(r[1])) + '</b></div>').join('');
}

const BAND_LABEL = { ready: 'Ready', almost: 'Almost ready', needs_work: 'Needs work' };

function verdictHeader(vd){
  if (!vd || vd.readiness_score == null) return '';
  const band = vd.band || 'needs_work';
  const comp = vd.components || {};
  const sub = (label, val) => '<div class="vsub"><span>' + label + '</span><b>' +
    (val == null ? '—' : Math.round(val)) + '</b></div>';
  const notes = [vd.delivery_note, vd.presence_note, vd.content_note]
    .filter(Boolean).map((n) => '<li>' + esc(n) + '</li>').join('');
  const str = (vd.strengths || []).map((x) => '<li>' + esc(x) + '</li>').join('');
  const imp = (vd.improvements || []).map((x) => '<li>' + esc(x) + '</li>').join('');
  return '<div class="verdict verdict-' + band + '">' +
    '<div class="vhead"><div class="vscore">' + Math.round(vd.readiness_score) + '<span>/100</span></div>' +
      '<div class="vband"><div class="vlabel">' + esc(BAND_LABEL[band] || band) + '</div>' +
      '<div class="vhl">' + esc(vd.headline || '') + '</div></div></div>' +
    '<div class="vsubs">' + sub('Delivery', comp.delivery) + sub('Presence', comp.presence) +
      sub('Content', comp.content) + '</div>' +
    (notes ? '<ul class="vnotes">' + notes + '</ul>' : '') +
    (str ? '<h5>Strengths</h5><ul>' + str + '</ul>' : '') +
    (imp ? '<h5>To improve</h5><ul>' + imp + '</ul>' : '') +
    (vd.next_action ? '<p class="vnext"><b>Next:</b> ' + esc(vd.next_action) + '</p>' : '') +
    '</div>';
}

function view(s){
  const o = s.overall || {};
  const t = s.timing || {};
  const ig = s.integrity || {};
  const v = s.voice || { available: false };
  const vd = s.verdict || null;
  const c = s.coaching || null;
  const title = esc(s.label || s.role || 'Interview');
  const perQ = s.per_question || [];
  // timeline: composure per question (a real series already in summary)
  const composureSeries = perQ.map((q) => (q.metrics || {}).composure);

  const cats =
    cat('Eye & Gaze', [['Eye contact', (o.gaze_eye_contact_pct ?? '—') + '%'],
                       ['Blinks', (o.blink_count ?? '—') + ' (' + (o.blinks_per_min ?? '—') + '/min)']]) +
    cat('Head Pose', [['Steadiness', (o.steadiness_score ?? '—') + '/100'],
                      ['Movement', o.head_movement ?? '—']]) +
    cat('Expression', [['Smile', 'mean ' + (o.mean_smile ?? '—') + ', peak ' + (o.peak_smile ?? '—')],
                       ['Smiling', (o.pct_smiling ?? '—') + '% of time']]) +
    cat('Posture', [['Upright', (o.upright_pct ?? '—') + '%'],
                    ['Lateral lean', (o.lean ?? '—') + '°'],
                    ['Body steadiness', (o.body_steadiness ?? '—') + '/100']]) +
    cat('Engagement', [['Speaking', (t.speaking_pct ?? 0) + '%'],
                       ['Mean response', (t.mean_response_sec ?? 0) + 's']]) +
    cat('Integrity', [['Face present', (o.face_presence_pct ?? '—') + '%'],
                      ['Another person', ig.another_person_detected ? 'yes' : 'no'],
                      ['Device in frame', ig.device_detected ? 'yes' : 'no']]);

  const coachHtml = c ? (
    '<div class="coach"><span class="badge">★ Coaching · ' + (c.score == null ? '—' : esc(String(c.score))) + '/10</span>' +
    '<p>' + esc(c.summary || '') + '</p>' +
    (c.strengths && c.strengths.length ? '<h5>Strengths</h5><ul>' + c.strengths.map((x) => '<li>' + esc(x) + '</li>').join('') + '</ul>' : '') +
    (c.improvements && c.improvements.length ? '<h5>To improve</h5><ul>' + c.improvements.map((x) => '<li>' + esc(x) + '</li>').join('') + '</ul>' : '') +
    '</div>'
  ) : '<div class="coach"><p class="muted">No coaching was generated for this session.</p></div>';

  const qrows = perQ.map((q) => {
    const m = q.metrics || {};
    const rt = (t.per_question_response_sec || [])[q.turn];
    return '<tr><td>' + esc(q.question || ('Q' + q.turn)) + '</td>' +
      '<td>' + (m.gaze_eye_contact_pct ?? '—') + '%</td>' +
      '<td>' + (m.upright_pct ?? '—') + '%</td>' +
      '<td>' + (m.composure ?? '—') + '</td>' +
      '<td>' + (rt != null ? rt + 's' : '—') + '</td></tr>';
  }).join('');

  return '<a class="backlink" href="#/history">← History</a>' +
    '<div class="screen-head"><div><h1>' + title + '</h1>' +
      '<div class="muted" style="font-size:12.5px">' + esc(fmtDate(s.created_at)) + ' · ' +
        (perQ.length) + ' questions · ' + esc(fmtDuration(s.duration_sec)) + '</div></div>' +
      '<button class="btn btn-ghost" onclick="window.print()">Export PDF</button></div>' +
    '<div class="score-cards">' +
      scoreCard('Attention', 'attention', o.attention) +
      scoreCard('Confidence', 'confidence', o.confidence) +
      scoreCard('Nervousness', 'nervousness', o.nervousness) +
      scoreCard('Composure', 'composure', o.composure) +
    '</div>' +
    verdictHeader(vd) +
    '<div class="two-col"><div class="cat-cards">' + cats + '</div>' + ((vd && vd.readiness_score != null) ? '' : coachHtml) + '</div>' +
    '<div class="chart-card"><div class="ct">Composure across questions</div>' +
      '<div class="cs">Drawn in-browser from this session\'s data.</div>' +
      svgLineChart(composureSeries) + '</div>' +
    (qrows ? ('<div class="chart-card"><div class="ct">Per-question</div>' +
      '<table class="data"><thead><tr><th>Question</th><th>Eye contact</th><th>Upright</th>' +
      '<th>Composure</th><th>Response</th></tr></thead><tbody>' + qrows + '</tbody></table></div>') : '') +
    '<div class="chart-card"><div class="ct">Voice (Delivery)</div>' +
      '<div class="cs">Pace, fillers, pauses, and pitch variation from your recorded audio.</div>' +
      voiceCard(v) + '</div>' +
    '<div class="chart-card"><div class="ct">Emotion (MediaPipe)</div>' +
      '<div class="cs">Heuristic emotion track from face blendshapes.</div>' +
      emotionBars(s.emotion_mediapipe) + '</div>' +
    (s.emotion && s.emotion.available ? ('<div class="chart-card"><div class="ct">Emotion (HSEmotion)</div>' +
      emotionBars(s.emotion) + '</div>') : '');
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
