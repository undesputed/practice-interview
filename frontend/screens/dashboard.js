import { api } from '../api.js';
import { esc } from '../util.js';
import { fmtDate, round, scoreClass } from '../format.js';
import { svgLineChart } from '../charts.js';

function mean(nums){
  const v = nums.filter((n) => n != null && !isNaN(n));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

function pill(key, label, v){
  return '<span class="sc ' + scoreClass(key, v) + '">' + label + ' ' + (v == null ? '—' : Math.round(v)) + '</span>';
}

function recentRow(s){
  const name = esc(s.label || s.role || 'Interview');
  return '<a class="list-row" href="#/session/' + encodeURIComponent(s.id) + '">' +
    '<div><div class="role">' + name + '</div>' +
    '<div class="meta">' + esc(fmtDate(s.created_at)) + ' · ' + (s.question_count || 0) + ' questions</div></div>' +
    '<div class="score-pills">' + pill('attention', 'Att', s.scores.attention) +
    pill('confidence', 'Conf', s.scores.confidence) + '</div></a>';
}

function view(sessions){
  if (!sessions.length){
    return '<div class="placeholder-card"><p>No interviews yet.</p>' +
      '<p class="muted">Start your first one to see stats and history here.</p>' +
      '<p style="margin-top:12px"><a class="btn btn-green" style="text-decoration:none" href="#/new">＋ New interview</a></p></div>';
  }
  const conf = mean(sessions.map((s) => s.scores.confidence));
  const nerv = mean(sessions.map((s) => s.scores.nervousness));
  // chronological for the sparkline (api returns newest-first)
  const confSeries = sessions.map((s) => s.scores.confidence).reverse();
  return '<div class="gap-stats">' +
      '<div class="stat-card"><div class="n">' + sessions.length + '</div><div class="l">Total sessions</div></div>' +
      '<div class="stat-card"><div class="n">' + round(conf, 0) + '</div><div class="l">Avg confidence</div></div>' +
      '<div class="stat-card"><div class="n">' + round(nerv, 0) + '</div><div class="l">Avg nervousness</div></div>' +
    '</div>' +
    '<div class="two-col"><div>' +
      '<div class="panel-title">Recent sessions <a href="#/history">View all →</a></div>' +
      sessions.slice(0, 4).map(recentRow).join('') +
    '</div><div class="spark"><div class="st">Confidence over time</div>' +
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
      root.innerHTML = '<div class="placeholder-card"><p>Could not load sessions.</p>' +
        '<p class="muted">' + esc(String(e.message || e)) + '</p></div>';
    }
  });
  return '<div class="screen"><div class="screen-head"><h1>Dashboard</h1>' +
    '<a class="btn btn-green" style="text-decoration:none" href="#/new">＋ New interview</a></div>' +
    '<div id="dashboard-body"><p class="muted">Loading…</p></div></div>';
}
