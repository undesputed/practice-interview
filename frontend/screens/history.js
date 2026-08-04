import { api } from '../api.js';
import { esc } from '../util.js';
import { fmtDate, scoreClass } from '../format.js';
import { t, localizeRole } from '../i18n.js';

let CACHE = [];        // last-loaded sessions
let QUERY = '';
let SORT = 'newest';

function scoreCell(key, v){
  return '<span class="sc ' + scoreClass(key, v) + '">' + (v == null ? '—' : Math.round(v)) + '</span>';
}

function sessionTitle(s){
  return localizeRole(s.label || s.role || null);
}

function rows(){
  let list = CACHE.slice();
  const q = QUERY.trim().toLowerCase();
  if (q){
    list = list.filter((s) => {
      const raw = ((s.label || '') + ' ' + (s.role || '')).toLowerCase();
      const loc = sessionTitle(s).toLowerCase();
      return raw.includes(q) || loc.includes(q);
    });
  }
  if (SORT === 'oldest') list.reverse();   // CACHE is newest-first
  if (!list.length){
    return '<tr><td colspan="8" class="muted" style="padding:18px">' + esc(t('history.empty')) + '</td></tr>';
  }
  return list.map((s) => {
    const name = esc(sessionTitle(s));
    return '<tr data-id="' + esc(s.id) + '">' +
      '<td>' + esc(fmtDate(s.created_at)) + '</td>' +
      '<td><span class="role">' + name + '</span></td>' +
      '<td>' + (s.question_count || 0) + '</td>' +
      '<td>' + scoreCell('attention', s.scores.attention) + '</td>' +
      '<td>' + scoreCell('confidence', s.scores.confidence) + '</td>' +
      '<td>' + scoreCell('nervousness', s.scores.nervousness) + '</td>' +
      '<td>' + scoreCell('composure', s.scores.composure) + '</td>' +
      '<td class="rowact"><button class="view" data-act="view">' + esc(t('history.view')) + '</button> · ' +
        '<button data-act="rename">' + esc(t('history.rename')) + '</button> · ' +
        '<button data-act="delete">' + esc(t('history.delete')) + '</button></td></tr>';
  }).join('');
}

function paint(){
  const tb = document.getElementById('history-tbody');
  if (tb) tb.innerHTML = rows();
}

async function onClick(e){
  const btn = e.target.closest('button[data-act]');
  const tr = e.target.closest('tr[data-id]');
  if (!tr) return;
  const id = tr.getAttribute('data-id');
  const act = btn ? btn.getAttribute('data-act') : 'view';
  if (act === 'view'){ location.hash = '#/session/' + encodeURIComponent(id); return; }
  if (act === 'delete'){
    if (!confirm(t('history.deleteConfirm'))) return;
    try { await api.deleteSession(id); CACHE = CACHE.filter((s) => s.id !== id); api.updateSessionsCache(CACHE); paint(); }
    catch (err){ alert('Delete failed: ' + (err.message || err)); }
    return;
  }
  if (act === 'rename'){
    const cur = (CACHE.find((s) => s.id === id) || {});
    const label = prompt(t('history.renamePrompt'), cur.label || cur.role || '');
    if (label == null) return;
    try {
      await api.renameSession(id, label);
      const row = CACHE.find((s) => s.id === id); if (row) row.label = label;
      api.updateSessionsCache(CACHE); paint();
    } catch (err){ alert('Rename failed: ' + (err.message || err)); }
  }
}

export function history(){
  // Reset filter/sort each visit so the (freshly blank) controls and the
  // rendered table never disagree from leftover module-level state.
  QUERY = '';
  SORT = 'newest';
  queueMicrotask(async () => {
    const root = document.getElementById('history-body');
    if (!root) return;
    try {
      const data = await api.listSessions();
      const sessions = data.sessions || [];
      if (!document.body.contains(root)) return;
      CACHE = sessions;
      root.innerHTML =
        '<div class="filters">' +
          '<input id="history-q" class="field grow" placeholder="' + esc(t('history.search')) + '">' +
          '<select id="history-sort" class="field"><option value="newest">' + esc(t('history.newest')) + '</option>' +
            '<option value="oldest">' + esc(t('history.oldest')) + '</option></select>' +
        '</div>' +
        '<table class="data"><thead><tr>' +
          '<th>' + esc(t('history.date')) + '</th><th>' + esc(t('history.role')) + '</th><th>Q</th>' +
          '<th>' + esc(t('history.attention')) + '</th><th>' + esc(t('history.confidence')) + '</th>' +
          '<th>' + esc(t('history.nerves')) + '</th><th>' + esc(t('history.composure')) + '</th><th></th></tr></thead>' +
          '<tbody id="history-tbody"></tbody></table>';
      paint();
      const tbody = document.getElementById('history-tbody');
      tbody.addEventListener('click', onClick);
      document.getElementById('history-q').addEventListener('input', (ev) => { QUERY = ev.target.value; paint(); });
      document.getElementById('history-sort').addEventListener('change', (ev) => { SORT = ev.target.value; paint(); });
    } catch (e){
      root.innerHTML = '<div class="placeholder-card"><p>' + esc(t('history.loadFail')) + '</p>' +
        '<p class="muted">' + esc(String(e.message || e)) + '</p></div>';
    }
  });
  return '<div class="screen"><div class="screen-head"><h1>' + esc(t('history.title')) + '</h1>' +
    '<a class="btn btn-green" style="text-decoration:none" href="#/practice-interview">' + esc(t('dash.new')) + '</a></div>' +
    '<div id="history-body"><p class="muted">' + esc(t('common.loading')) + '</p></div></div>';
}
