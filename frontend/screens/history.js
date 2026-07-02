import { api } from '../api.js';
import { esc } from '../util.js';
import { fmtDate, scoreClass } from '../format.js';

let CACHE = [];        // last-loaded sessions
let QUERY = '';
let SORT = 'newest';

function scoreCell(key, v){
  return '<span class="sc ' + scoreClass(key, v) + '">' + (v == null ? '—' : Math.round(v)) + '</span>';
}

function rows(){
  let list = CACHE.slice();
  const q = QUERY.trim().toLowerCase();
  if (q) list = list.filter((s) => ((s.label || '') + ' ' + (s.role || '')).toLowerCase().includes(q));
  if (SORT === 'oldest') list.reverse();   // CACHE is newest-first
  if (!list.length) return '<tr><td colspan="8" class="muted" style="padding:18px">No matching sessions.</td></tr>';
  return list.map((s) => {
    const name = esc(s.label || s.role || 'Interview');
    return '<tr data-id="' + esc(s.id) + '">' +
      '<td>' + esc(fmtDate(s.created_at)) + '</td>' +
      '<td><span class="role">' + name + '</span></td>' +
      '<td>' + (s.question_count || 0) + '</td>' +
      '<td>' + scoreCell('attention', s.scores.attention) + '</td>' +
      '<td>' + scoreCell('confidence', s.scores.confidence) + '</td>' +
      '<td>' + scoreCell('nervousness', s.scores.nervousness) + '</td>' +
      '<td>' + scoreCell('composure', s.scores.composure) + '</td>' +
      '<td class="rowact"><button class="view" data-act="view">View</button> · ' +
        '<button data-act="rename">Rename</button> · ' +
        '<button data-act="delete">Delete</button></td></tr>';
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
    if (!confirm('Delete this session permanently?')) return;
    try { await api.deleteSession(id); CACHE = CACHE.filter((s) => s.id !== id); api.updateSessionsCache(CACHE); paint(); }
    catch (err){ alert('Delete failed: ' + (err.message || err)); }
    return;
  }
  if (act === 'rename'){
    const cur = (CACHE.find((s) => s.id === id) || {});
    const label = prompt('Label for this session:', cur.label || cur.role || '');
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
          '<input id="history-q" class="field grow" placeholder="Search by role or label…">' +
          '<select id="history-sort" class="field"><option value="newest">Newest first</option>' +
            '<option value="oldest">Oldest first</option></select>' +
        '</div>' +
        '<table class="data"><thead><tr>' +
          '<th>Date</th><th>Role</th><th>Q</th><th>Attention</th><th>Confidence</th>' +
          '<th>Nerves</th><th>Composure</th><th></th></tr></thead>' +
          '<tbody id="history-tbody"></tbody></table>';
      paint();
      const tbody = document.getElementById('history-tbody');
      tbody.addEventListener('click', onClick);
      document.getElementById('history-q').addEventListener('input', (ev) => { QUERY = ev.target.value; paint(); });
      document.getElementById('history-sort').addEventListener('change', (ev) => { SORT = ev.target.value; paint(); });
    } catch (e){
      root.innerHTML = '<div class="placeholder-card"><p>Could not load sessions.</p>' +
        '<p class="muted">' + esc(String(e.message || e)) + '</p></div>';
    }
  });
  return '<div class="screen"><div class="screen-head"><h1>History</h1>' +
    '<a class="btn btn-green" style="text-decoration:none" href="#/practice-interview">＋ New practice interview</a></div>' +
    '<div id="history-body"><p class="muted">Loading…</p></div></div>';
}
