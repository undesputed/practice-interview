# UI Redesign — Phase 3: Data Screens (Dashboard, History, Report) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Dashboard, History, and Session-Report placeholders with real Clean Studio screens that read the Phase 2 API (`/api/sessions`, `/api/sessions/{id}`, DELETE, PATCH) and render scores, tables, coaching, and client-side SVG charts.

**Architecture:** Each screen is a render module returning an HTML string built with the existing shell + router. Shared CSS components (stat card, score card, data table, metric bar, filters) are added to `clean-studio.css`. Two small helpers — `format.js` (dates/durations/score class) and `charts.js` (SVG line chart) — are reused across screens. All dynamic values are wrapped in `esc()` (the Phase 1 convention). History wires DELETE/PATCH through `api.js`. Charts are drawn in the browser from `summary.json` data — Matplotlib stays out of the UI.

**Tech Stack:** Vanilla ES modules, no build step. Backend serving verified with pytest (existing); screen rendering verified manually in the browser (no JS test runner, per the no-build decision).

**Depends on:** Plan 1 (shell/router/`api.js`/`esc`) and Plan 2 (the `/api/sessions` endpoints), both merged.

**Data contract (from Phase 2, verified):**
- `GET /api/sessions` → `{ sessions: [ { id, created_at, role, label, duration_sec, question_count, scores:{attention,confidence,nervousness,composure} } ] }`, newest first.
- `GET /api/sessions/{id}` → the full `summary.json`: `overall` (the four scores + raw metrics like `gaze_eye_contact_pct`, `steadiness_score`, `mean_smile`, `upright_pct`, `lean`, `body_steadiness`, `blink_count`, `blinks_per_min`, `face_presence_pct`…), `per_question[]` (each `{turn, question, metrics:{…}}`), `timing` (`speaking_pct`, `mean_response_sec`, `per_question_response_sec[]`), `integrity`, `actions` (`{counts:{}, total, events:[]}`), `emotion` / `emotion_mediapipe` (`{available, dominant, overall_distribution:{emotion:pct}, per_question, timeline}`), `coaching` (`{summary, strengths[], improvements[], score, rationale}`), plus `id`, `created_at`, `role`, optional `label`.

---

## File Structure (Phase 3)

**Create:**
- `frontend/format.js` — `fmtDate`, `fmtDuration`, `scoreClass` helpers.
- `frontend/charts.js` — `svgLineChart(values, opts)` returning an SVG string.
- `frontend/screens/dashboard.js` — Dashboard render module.
- `frontend/screens/history.js` — History render module (+ delete/rename actions).
- `frontend/screens/report.js` — Session Report render module.

**Modify:**
- `frontend/styles/clean-studio.css` — append shared component styles.
- `frontend/screens/registry.js` — point `/`, `/history`, `/session/:id` at the real modules.
- `tests/test_shell.py` — assert the new JS modules are served.

**Untouched:** backend, the interview engine, other placeholder screens.

---

## A note on async screens

The current router calls a screen function and drops its return value into `content.innerHTML` synchronously. These screens need to fetch data. Pattern used here: **the screen function returns an immediate "loading" HTML string, then kicks off an async fill that replaces a known container's contents.** Each screen exports a default render function `(params) => htmlString` that also schedules the async work via `queueMicrotask`/`then`. The screens locate their container with `document.getElementById` after the router has injected the HTML. To keep this reliable, each screen wraps its content in a uniquely-IDed root (e.g. `id="dashboard-root"`) and the async code writes into that node, bailing out if the user has navigated away (node no longer in the document).

---

## Task 1: Shared helpers + component CSS

**Files:**
- Create: `frontend/format.js`, `frontend/charts.js`
- Modify: `frontend/styles/clean-studio.css` (append)

- [ ] **Step 1: Create `frontend/format.js`**

```js
// Small formatting helpers shared across screens.

export function fmtDate(iso){
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export function fmtDuration(sec){
  if (sec == null) return '—';
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return m ? (m + 'm ' + s + 's') : (s + 's');
}

// Returns 'good' | 'mid' | 'low' for color-coding. Nervousness is inverted
// (low is good); the other three score higher-is-better.
export function scoreClass(key, v){
  if (v == null) return '';
  if (key === 'nervousness') return v <= 40 ? 'good' : (v <= 60 ? 'mid' : 'low');
  return v >= 70 ? 'good' : (v >= 50 ? 'mid' : 'low');
}

export function round(v, dp){
  if (v == null || isNaN(v)) return '—';
  const f = Math.pow(10, dp || 0);
  return Math.round(v * f) / f;
}
```

- [ ] **Step 2: Create `frontend/charts.js`**

```js
// Minimal dependency-free SVG charts drawn from numeric data.

// A responsive line chart. `values` is an array of numbers (nulls skipped).
export function svgLineChart(values, opts){
  opts = opts || {};
  const stroke = opts.stroke || '#157a4c';
  const height = opts.height || 120;
  const pts = (values || []).filter((v) => v != null && !isNaN(v));
  if (pts.length < 2){
    return '<div class="muted" style="font-size:12px;padding:8px 0">Not enough data to chart yet.</div>';
  }
  const w = 600, h = height, pad = 8;
  const max = Math.max.apply(null, pts);
  const min = Math.min.apply(null, pts);
  const span = (max - min) || 1;
  const step = w / (pts.length - 1);
  const coords = pts.map((v, i) => {
    const x = (i * step).toFixed(1);
    const y = (h - pad - ((v - min) / span) * (h - 2 * pad)).toFixed(1);
    return x + ',' + y;
  }).join(' ');
  const last = coords.split(' ').pop().split(',');
  return '<svg viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="none" ' +
         'style="width:100%;height:' + h + 'px;display:block">' +
         '<polyline points="' + coords + '" fill="none" stroke="' + stroke +
         '" stroke-width="2.5" vector-effect="non-scaling-stroke"/>' +
         '<circle cx="' + last[0] + '" cy="' + last[1] + '" r="3.5" fill="' + stroke + '"/>' +
         '</svg>';
}
```

- [ ] **Step 3: Append component styles to `frontend/styles/clean-studio.css`**

Append exactly this to the END of the existing file (do not remove anything already there):

```css

/* ---- Phase 3 shared components ---- */
.row-between{display:flex;justify-content:space-between;align-items:center}
.gap-stats{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:18px}
.stat-card{background:var(--card);border:1px solid var(--line);border-radius:var(--radius);padding:15px 16px}
.stat-card .n{font-size:28px;font-weight:700;letter-spacing:-.02em;line-height:1}
.stat-card .l{font-size:11.5px;color:var(--ink-3);margin-top:6px}
.stat-card .d{font-size:11px;margin-top:8px;font-weight:600;color:var(--green)}

.two-col{display:grid;grid-template-columns:1.5fr 1fr;gap:16px;align-items:start}
.panel-title{font-size:13px;font-weight:600;margin:4px 0 10px;display:flex;justify-content:space-between;align-items:center}
.panel-title a{font-size:11.5px;font-weight:500;color:var(--ink-3);text-decoration:none}

.list-row{display:flex;justify-content:space-between;align-items:center;background:var(--card);
  border:1px solid var(--line);border-radius:11px;padding:11px 14px;margin-bottom:7px;
  font-size:12.5px;text-decoration:none;color:inherit;cursor:pointer}
.list-row:hover{border-color:var(--green)}
.list-row .role{font-weight:600;color:var(--ink)}
.list-row .meta{color:var(--ink-3);font-size:11.5px}
.score-pills{display:flex;gap:6px;flex-wrap:wrap}

.sc{font-variant-numeric:tabular-nums;font-weight:600}
.sc.good{color:var(--green)} .sc.mid{color:var(--amber)} .sc.low{color:var(--red)}

.spark{background:var(--card);border:1px solid var(--line);border-radius:var(--radius);padding:15px 16px}
.spark .st{font-size:12px;font-weight:600;margin-bottom:10px}

/* filters + table */
.filters{display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap}
.field{background:var(--card);border:1px solid var(--line);border-radius:var(--radius-sm);
  padding:8px 12px;font-size:12.5px;color:var(--ink-2);font-family:inherit}
.field.grow{flex:1;min-width:160px}
table.data{width:100%;border-collapse:separate;border-spacing:0;background:var(--card);
  border:1px solid var(--line);border-radius:var(--radius);overflow:hidden;font-size:12.5px}
table.data thead th{text-align:left;font-size:11px;letter-spacing:.04em;text-transform:uppercase;
  color:var(--ink-3);font-weight:600;padding:11px 14px;background:#fafbfa;border-bottom:1px solid var(--line)}
table.data tbody td{padding:12px 14px;border-bottom:1px solid var(--line-2);color:var(--ink-2)}
table.data tbody tr:last-child td{border-bottom:none}
table.data tbody tr{cursor:pointer}
table.data tbody tr:hover td{background:#fafbfa}
table.data .role{font-weight:600;color:var(--ink)}
.rowact{color:var(--ink-3);font-weight:600;white-space:nowrap}
.rowact button{background:none;border:none;font:inherit;color:var(--ink-3);cursor:pointer;padding:2px 4px}
.rowact button.view{color:var(--green)}

/* report */
.backlink{font-size:12px;color:var(--ink-3);font-weight:500;text-decoration:none;display:inline-block;margin-bottom:6px}
.score-cards{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:16px}
.score-card{background:var(--card);border:1px solid var(--line);border-radius:var(--radius);padding:14px}
.score-card .n{font-size:30px;font-weight:700;letter-spacing:-.03em;line-height:1}
.score-card .l{font-size:11px;color:var(--ink-3);margin-top:6px}
.score-card .bar{height:4px;border-radius:100px;background:var(--line);margin-top:9px;overflow:hidden}
.score-card .bar i{display:block;height:100%;border-radius:100px;background:var(--green)}
.score-card .bar i.mid{background:var(--amber)} .score-card .bar i.low{background:var(--red)}
.cat-cards{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.cat{background:var(--card);border:1px solid var(--line);border-radius:var(--radius);padding:13px 14px}
.cat h4{font-size:12.5px;font-weight:700;margin-bottom:8px}
.cat .r{display:flex;justify-content:space-between;font-size:11.5px;color:var(--ink-3);padding:4px 0}
.cat .r b{color:var(--ink-2);font-weight:600}
.coach{background:var(--card);border:1px solid var(--line);border-radius:var(--radius);padding:16px}
.coach .badge{display:inline-block;background:var(--green-soft);color:var(--green-deep);font-size:11px;
  font-weight:700;border-radius:100px;padding:3px 10px;margin-bottom:10px}
.coach h5{font-size:12.5px;font-weight:700;margin:12px 0 5px}
.coach p{font-size:12px;color:var(--ink-2)} .coach li{font-size:12px;color:var(--ink-2);margin-left:16px}
.chart-card{background:var(--card);border:1px solid var(--line);border-radius:var(--radius);padding:15px;margin-top:14px}
.chart-card .ct{font-size:12.5px;font-weight:700;margin-bottom:2px}
.chart-card .cs{font-size:11px;color:var(--ink-3);margin-bottom:10px}
.emrow{display:grid;grid-template-columns:90px 1fr 42px;align-items:center;gap:10px;font-size:12px;padding:3px 0}
.emrow .track{height:7px;border-radius:100px;background:var(--line);overflow:hidden}
.emrow .fill{height:100%;border-radius:100px;background:var(--green)}
.emrow .val{text-align:right;font-variant-numeric:tabular-nums;color:var(--ink-3);font-size:11px}
@media(max-width:820px){.two-col,.cat-cards{grid-template-columns:1fr}.score-cards{grid-template-columns:repeat(2,1fr)}}
```

- [ ] **Step 4: Manual verify the helpers load**

Run `uvicorn backend.main:app --port 8000`; open `http://localhost:8000/format.js` and `http://localhost:8000/charts.js` — both should return JS (200), and `http://localhost:8000/styles/clean-studio.css` should now include `.score-cards`.

- [ ] **Step 5: Commit**

```bash
git add frontend/format.js frontend/charts.js frontend/styles/clean-studio.css
git commit -m "feat(ui): add format/chart helpers and Phase 3 component styles"
```

---

## Task 2: Dashboard screen

**Files:**
- Create: `frontend/screens/dashboard.js`
- Modify: `frontend/screens/registry.js`

- [ ] **Step 1: Create `frontend/screens/dashboard.js`**

```js
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
```

- [ ] **Step 2: Wire it in `frontend/screens/registry.js`**

Add the import at the top of `registry.js`:
```js
import { dashboard } from './dashboard.js';
```
Change the `'/'` entry from the placeholder to:
```js
  ['/',            dashboard],
```
(Leave all other entries unchanged.)

- [ ] **Step 3: Manual verify**

Run the server, open `http://localhost:8000/#/` — the Dashboard shows stats, recent sessions (clicking one navigates to `#/session/<id>`), and a confidence sparkline. If you have zero saved sessions, it shows the empty-state card with a "New interview" link. (You can generate sessions by running an interview at `/legacy.html`.)

- [ ] **Step 4: Commit**

```bash
git add frontend/screens/dashboard.js frontend/screens/registry.js
git commit -m "feat(ui): real Dashboard screen reading /api/sessions"
```

---

## Task 3: History screen

**Files:**
- Create: `frontend/screens/history.js`
- Modify: `frontend/screens/registry.js`

- [ ] **Step 1: Create `frontend/screens/history.js`**

```js
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
    try { await api.deleteSession(id); CACHE = CACHE.filter((s) => s.id !== id); paint(); }
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
      paint();
    } catch (err){ alert('Rename failed: ' + (err.message || err)); }
  }
}

export function history(){
  queueMicrotask(async () => {
    const root = document.getElementById('history-body');
    if (!root) return;
    try {
      const data = await api.listSessions();
      if (!document.body.contains(root)) return;
      CACHE = data.sessions || [];
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
    '<a class="btn btn-green" style="text-decoration:none" href="#/new">＋ New interview</a></div>' +
    '<div id="history-body"><p class="muted">Loading…</p></div></div>';
}
```

- [ ] **Step 2: Wire it in `frontend/screens/registry.js`**

Add import: `import { history } from './history.js';`
Change the `'/history'` entry to:
```js
  ['/history',     history],
```

- [ ] **Step 3: Manual verify**

Open `http://localhost:8000/#/history`. The table lists sessions; search filters by role/label; sort flips order; **Rename** prompts and persists (reload to confirm); **Delete** confirms then removes the row; **View** (or row click) opens the report. With zero sessions the table shows "No matching sessions."

- [ ] **Step 4: Commit**

```bash
git add frontend/screens/history.js frontend/screens/registry.js
git commit -m "feat(ui): real History screen with search, rename, delete"
```

---

## Task 4: Session Report screen

**Files:**
- Create: `frontend/screens/report.js`
- Modify: `frontend/screens/registry.js`

- [ ] **Step 1: Create `frontend/screens/report.js`**

```js
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

function view(s){
  const o = s.overall || {};
  const t = s.timing || {};
  const ig = s.integrity || {};
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
    '<div class="two-col"><div class="cat-cards">' + cats + '</div>' + coachHtml + '</div>' +
    '<div class="chart-card"><div class="ct">Composure across questions</div>' +
      '<div class="cs">Drawn in-browser from this session’s data.</div>' +
      svgLineChart(composureSeries) + '</div>' +
    (qrows ? ('<div class="chart-card"><div class="ct">Per-question</div>' +
      '<table class="data"><thead><tr><th>Question</th><th>Eye contact</th><th>Upright</th>' +
      '<th>Composure</th><th>Response</th></tr></thead><tbody>' + qrows + '</tbody></table></div>') : '') +
    '<div class="chart-card"><div class="ct">Emotion (MediaPipe)</div>' +
      '<div class="cs">Heuristic emotion track from face blendshapes.</div>' +
      emotionBars(s.emotion_mediapipe) + '</div>' +
    (s.emotion && s.emotion.available ? ('<div class="chart-card"><div class="ct">Emotion (DeepFace)</div>' +
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
```

- [ ] **Step 2: Wire it in `frontend/screens/registry.js`**

Add import: `import { report } from './report.js';`
Change the `'/session/:id'` entry to:
```js
  ['/session/:id', report],
```

- [ ] **Step 3: Manual verify**

Open a session report from History (or `http://localhost:8000/#/session/<an-existing-id>`). Confirm: score cards show the four scores with color-coded bars; category cards show real metrics; coaching renders (or a graceful "no coaching" note); the composure chart draws; the per-question table fills; the MediaPipe emotion bars show (DeepFace section only if available). Visit `#/session/bogus-id` → "Session not found." Try **Export PDF** → the browser print dialog opens.

- [ ] **Step 4: Commit**

```bash
git add frontend/screens/report.js frontend/screens/registry.js
git commit -m "feat(ui): rewired Session Report screen with SVG charts"
```

---

## Task 5: Serving test + final verification

**Files:**
- Modify: `tests/test_shell.py`

- [ ] **Step 1: Extend the served-modules assertion**

In `tests/test_shell.py`, in `test_router_and_shell_modules_served`, add these paths to the tuple it checks:
`"/format.js", "/charts.js", "/screens/dashboard.js", "/screens/history.js", "/screens/report.js"`

- [ ] **Step 2: Run tests**

Run: `pytest tests/test_shell.py -v`
Expected: PASS (all served, including the new modules).
Run: `pytest -q`
Expected: whole suite green.

- [ ] **Step 3: Full manual smoke**

Run the server. With at least one saved session: Dashboard → stats + recent + sparkline; click a recent item → report; History → search/sort/rename/delete/view; report → all sections + chart + print. Confirm `/legacy.html` still works and the other placeholder routes (`/new`, `/facial`, `/audio`, `/settings`, `/progress`, `/library`) still render their placeholders.

- [ ] **Step 4: Commit**

```bash
git add tests/test_shell.py
git commit -m "test(ui): assert Phase 3 screen modules are served"
```

---

## Phase 3 Done — Definition of Done

- Dashboard, History, and Session Report are real Clean Studio screens backed by `/api/sessions`.
- History supports search, sort, rename (persisted), and delete.
- Report renders scores, category metrics, coaching, per-question table, emotion distribution, and an in-browser SVG chart — no Matplotlib in the UI.
- All dynamic values pass through `esc()`. `pytest -q` is green. `/legacy.html` and remaining placeholders are unaffected.

**Next:** Plan 4 — New-interview setup + restyle the Live interview screen (wiring the existing recording engine into the new shell).
```
