import { api } from '../api.js';
import { esc } from '../util.js';
import { fmtDate, round, scoreClass } from '../format.js';
import { svgLineChart } from '../charts.js';
import { t, localizeRole } from '../i18n.js';

function mean(nums){
  const v = nums.filter((n) => n != null && !isNaN(n));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

function pill(key, label, v){
  return '<span class="sc ' + scoreClass(key, v) + '">' + label + ' ' + (v == null ? '—' : Math.round(v)) + '</span>';
}

function recentRow(s){
  const name = esc(localizeRole(s.label || s.role || null));
  return '<a class="list-row" href="#/session/' + encodeURIComponent(s.id) + '">' +
    '<div><div class="role">' + name + '</div>' +
    '<div class="meta">' + esc(fmtDate(s.created_at)) + ' · ' + (s.question_count || 0) + ' ' + esc(t('common.questions')) + '</div></div>' +
    '<div class="score-pills">' + pill('attention', 'Att', s.scores.attention) +
    pill('confidence', 'Conf', s.scores.confidence) + '</div></a>';
}

function view(sessions){
  if (!sessions.length){
    return '<div class="placeholder-card"><p>' + esc(t('dash.empty')) + '</p>' +
      '<p class="muted">' + esc(t('dash.emptyHint')) + '</p></div>';
  }
  const conf = mean(sessions.map((s) => s.scores.confidence));
  const nerv = mean(sessions.map((s) => s.scores.nervousness));
  const confSeries = sessions.map((s) => s.scores.confidence).reverse();
  return '<div class="gap-stats">' +
      '<div class="stat-card"><div class="n">' + sessions.length + '</div><div class="l">' + esc(t('dash.total')) + '</div></div>' +
      '<div class="stat-card"><div class="n">' + round(conf, 0) + '</div><div class="l">' + esc(t('dash.avgConf')) + '</div></div>' +
      '<div class="stat-card"><div class="n">' + round(nerv, 0) + '</div><div class="l">' + esc(t('dash.avgNerv')) + '</div></div>' +
    '</div>' +
    '<div class="two-col"><div>' +
      '<div class="panel-title">' + esc(t('dash.recent')) + ' <a href="#/history">' + esc(t('dash.viewAll')) + '</a></div>' +
      sessions.slice(0, 4).map(recentRow).join('') +
    '</div><div class="spark"><div class="st">' + esc(t('dash.confTrend')) + '</div>' +
      svgLineChart(confSeries) + '</div></div>';
}

export function dashboard(){
  queueMicrotask(async () => {
    const root = document.getElementById('dashboard-body');
    if (!root) return;
    try {
      const data = await api.listSessions();
      if (!document.body.contains(root)) return;
      root.innerHTML = view(data.sessions || []);
    } catch (e){
      root.innerHTML = '<div class="placeholder-card"><p>' + esc(t('dash.loadFail')) + '</p>' +
        '<p class="muted">' + esc(String(e.message || e)) + '</p></div>';
    }
  });
  return '<div class="screen"><div class="screen-head"><h1>' + esc(t('dash.title')) + '</h1>' +
    '<a class="btn btn-green" style="text-decoration:none" href="#/practice-interview">' + esc(t('dash.new')) + '</a></div>' +
    '<div id="dashboard-body"><p class="muted">' + esc(t('common.loading')) + '</p></div></div>';
}
