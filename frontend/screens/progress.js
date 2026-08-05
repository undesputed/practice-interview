import { api } from '../api.js';
import { esc } from '../util.js';
import { round, fmtDate } from '../format.js';
import { svgLineChart } from '../charts.js';
import { t, localizeRole } from '../i18n.js';

// Nervousness is the one "lower is better" metric; the rest score higher-is-better.
function metrics(){
  return [
    { key: 'attention',   label: t('report.attention'),   betterHigh: true },
    { key: 'confidence',  label: t('report.confidence'),  betterHigh: true },
    { key: 'nervousness', label: t('progress.nervousness'), betterHigh: false },
    { key: 'composure',   label: t('report.composure'),   betterHigh: true },
  ];
}

function bandText(band){
  return t('progress.band.' + (band || 'needs_work'));
}

function sessionList(sessions){
  return sessions.map((s) => {
    const r = s.readiness || {};
    const band = r.band || null;
    const badge = band
      ? '<span class="rbadge rbadge-' + band + '">' + esc(bandText(band)) +
        (r.score == null ? '' : ' · ' + Math.round(r.score)) + '</span>'
      : '<span class="rbadge rbadge-none">—</span>';
    return '<a class="sess-row" href="#/session/' + encodeURIComponent(s.id) + '">' +
      '<span class="sr-when">' + esc(fmtDate(s.created_at)) + '</span>' +
      '<span class="sr-role">' + esc(localizeRole(s.role || s.label)) + '</span>' +
      badge + '</a>';
  }).join('');
}

function mean(nums){
  const v = nums.filter((n) => n != null && !isNaN(n));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

function series(sessions, key){ return sessions.map((s) => s.scores[key]).reverse(); }

function deltaHtml(vals, betterHigh){
  const v = vals.filter((n) => n != null && !isNaN(n));
  if (v.length < 2) return '<div class="delta flat">' + esc(t('progress.tracking')) + '</div>';
  const d = v[v.length - 1] - v[0];
  const r = Math.round(Math.abs(d));
  if (r === 0) return '<div class="delta flat">' + esc(t('progress.noChange')) + '</div>';
  const improved = betterHigh ? d > 0 : d < 0;
  return '<div class="delta ' + (improved ? 'up' : 'down') + '">' +
    (d > 0 ? '↑' : '↓') + ' ' + r + ' pts</div>';
}

function metricCard(sessions, m){
  const s = series(sessions, m.key);
  return '<div class="metric-card"><div class="l">' + esc(m.label) + '</div>' +
    '<div class="n">' + round(mean(s), 0) + '</div>' +
    deltaHtml(s, m.betterHigh) +
    '<div class="mini">' + svgLineChart(s, { height: 40 }) + '</div></div>';
}

function byRole(sessions){
  const map = {};
  sessions.forEach((s) => {
    const k = s.role || s.label || 'Interview';
    (map[k] = map[k] || []).push(s);
  });
  const rows = Object.keys(map).map((k) => ({
    name: k, count: map[k].length, conf: mean(map[k].map((s) => s.scores.confidence)),
  })).sort((a, b) => b.count - a.count);
  return rows.map((r) => {
    const w = r.conf == null ? 0 : Math.max(0, Math.min(100, Math.round(r.conf)));
    const label = localizeRole(r.name);
    return '<div class="emrow"><span class="nm" title="' + esc(label) + '">' + esc(label) + '</span>' +
      '<span class="track"><span class="fill" style="width:' + w + '%"></span></span>' +
      '<span class="val">' + (r.conf == null ? '—' : Math.round(r.conf)) + '</span></div>';
  }).join('');
}

function view(sessions){
  const mets = metrics();
  if (!sessions.length){
    return '<div class="placeholder-card"><p>' + esc(t('progress.empty')) + '</p>' +
      '<p class="muted">' + esc(t('progress.emptyHint')) + '</p>' +
      '<p style="margin-top:12px"><a class="btn btn-green" style="text-decoration:none" href="#/practice-interview">' +
      esc(t('dash.new')) + '</a></p></div>';
  }
  const intro = '<p class="muted" style="font-size:13px;margin:-6px 0 16px">' +
    esc(sessions.length === 1
      ? t('progress.introOne')
      : t('progress.intro', { n: sessions.length })) +
    '</p>';

  const cards = '<div class="prog-metrics">' + mets.map((m) => metricCard(sessions, m)).join('') + '</div>';

  const seg = '<div class="seg" id="prog-seg">' + mets.map((m, i) =>
    '<button data-metric="' + m.key + '"' + (i === 1 ? ' class="on"' : '') + '>' + esc(m.label) + '</button>').join('') + '</div>';

  const body = '<div class="two-col">' +
    '<div class="chart-card"><div class="ct">' + esc(t('progress.trend')) + '</div>' +
      '<div class="cs">' + esc(t('progress.trendSub')) + '</div>' + seg +
      '<div id="prog-chart" style="margin-top:10px">' + svgLineChart(series(sessions, 'confidence'), { height: 170 }) + '</div>' +
    '</div>' +
    '<div class="spark"><div class="st">' + esc(t('progress.byRole')) + '</div>' + byRole(sessions) + '</div>' +
  '</div>';

  const recent = '<div class="chart-card" style="margin-top:14px"><div class="ct">' + esc(t('progress.recent')) + '</div>' +
    '<div class="cs">' + esc(t('progress.recentSub')) + '</div>' +
    '<div class="sess-list">' + sessionList(sessions) + '</div></div>';
  return intro + cards + body + recent;
}

export function progress(){
  queueMicrotask(async () => {
    const root = document.getElementById('progress-body');
    if (!root) return;
    try {
      const data = await api.listSessions();
      if (!document.body.contains(root)) return;
      const sessions = data.sessions || [];
      root.innerHTML = view(sessions);

      const seg = document.getElementById('prog-seg');
      if (seg) seg.addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-metric]');
        if (!btn) return;
        seg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === btn));
        const chart = document.getElementById('prog-chart');
        if (chart) chart.innerHTML = svgLineChart(series(sessions, btn.getAttribute('data-metric')), { height: 170 });
      });
    } catch (e){
      root.innerHTML = '<div class="placeholder-card"><p>' + esc(t('progress.loadFail')) + '</p>' +
        '<p class="muted">' + esc(String(e.message || e)) + '</p></div>';
    }
  });
  return '<div class="screen"><div class="screen-head"><h1>' + esc(t('progress.title')) + '</h1></div>' +
    '<div id="progress-body"><p class="muted">' + esc(t('progress.loading')) + '</p></div></div>';
}
