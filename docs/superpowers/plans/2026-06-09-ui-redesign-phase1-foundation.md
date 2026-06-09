# UI Redesign — Phase 1: Foundation (Shell + Router + Design System) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the new "Clean Studio" app shell — a left sidebar, a hash router, the design-token CSS, and Clean Studio placeholder screens for all ten routes — while preserving the existing interview app verbatim at `/legacy.html`.

**Architecture:** Vanilla JS, no build step. A hash router maps `#/route` to a render function; a shell module renders the persistent sidebar + content slot; placeholder screen modules fill each route for now. The existing MediaPipe/Deepgram interview app is copied to `legacy.html` and left untouched so nothing is lost during the migration. Real screens replace the placeholders in Phases 2–5.

**Tech Stack:** Vanilla ES modules, FastAPI static serving (existing), pytest (existing, backend only), Inter + JetBrains Mono via Google Fonts.

**Testing philosophy:** The backend has a pytest setup (`tests/`), so static-serving behavior is tested with `TestClient`. The frontend has **no** JS test framework, and the approved architecture forbids adding a build step/toolchain — so frontend modules are verified with explicit manual browser steps. This is a deliberate, spec-approved trade-off, not an oversight.

**This is Plan 1 of 5.** Later plans: (2) backend read-back endpoints + Dashboard/History/Report, (3) New-interview setup + Live restyle, (4) Facial + Audio analysis, (5) Settings + Progress + Library.

---

## File Structure (Phase 1)

**Create:**
- `frontend/styles/clean-studio.css` — design tokens, base styles, shell + sidebar + shared component classes.
- `frontend/router.js` — hash router (parse, match, params, navigate).
- `frontend/shell.js` — mount the shell DOM; render the sidebar with groups + active state.
- `frontend/screens/placeholder.js` — helper that builds a Clean Studio placeholder screen.
- `frontend/screens/registry.js` — maps each route pattern to its render function (placeholders in Phase 1).
- `frontend/main.js` — bootstrap: mount shell, register routes, start router.
- `frontend/api.js` — data-layer fetch wrappers for the (Phase 2) backend endpoints.
- `frontend/util.js` — shared helpers; exports `esc()` to HTML-escape dynamic/user-controlled values before interpolating into `innerHTML`. **Convention for all later phases:** any dynamic value (session id, role name, transcript text) put into an HTML string MUST be wrapped in `esc()`.
- `frontend/legacy.html` — verbatim copy of the current interview app (preserves the working flow).
- `tests/test_shell.py` — backend serving tests for the new shell + preserved legacy app.

**Modify:**
- `frontend/index.html` — replaced with the new shell entry. (The old content is preserved in `legacy.html`.)

**Untouched (still used by `legacy.html`):**
- `frontend/app.js`, `frontend/config.js`, `frontend/landmarks.js`, `frontend/actions.js`, `frontend/deepgram-client.js`, `frontend/style.css`, and all of `backend/`.

---

## Task 1: Clean Studio design system CSS

**Files:**
- Create: `frontend/styles/clean-studio.css`

- [ ] **Step 1: Create the design-token + base + shell stylesheet**

Create `frontend/styles/clean-studio.css` with exactly this content:

```css
/* Clean Studio — design tokens + base + shell. See spec §4. */
:root{
  --bg:#f7f8f7; --card:#ffffff; --ink:#11150f; --ink-2:#3a403c; --ink-3:#7c837d;
  --line:#e6e8e6; --line-2:#eceeec; --green:#157a4c; --green-soft:#eef6f0; --green-deep:#0f5c39;
  --amber:#b4791f; --red:#c0492f; --blue:#2f6fb4;
  --radius:12px; --radius-sm:9px;
  --shadow:0 14px 36px -28px rgba(17,21,15,.4);
}
*{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%}
body{
  background:var(--bg); color:var(--ink);
  font-family:'Inter',system-ui,-apple-system,sans-serif;
  -webkit-font-smoothing:antialiased; line-height:1.5; letter-spacing:-.005em;
}
.mono{font-family:'JetBrains Mono',ui-monospace,monospace;font-variant-numeric:tabular-nums}
.muted{color:var(--ink-3)}

/* shell */
.app-shell{display:grid;grid-template-columns:200px 1fr;min-height:100vh}
.sidebar{background:var(--card);border-right:1px solid var(--line-2);padding:18px 14px;position:sticky;top:0;height:100vh;overflow:auto}
.sidebar .brand{font-weight:700;font-size:17px;letter-spacing:-.02em;margin-bottom:18px;padding:0 8px}
.sidebar .nav-group{font-size:9.5px;letter-spacing:.12em;text-transform:uppercase;color:var(--ink-3);font-weight:700;margin:14px 8px 6px}
.sidebar .nav-item{display:flex;align-items:center;gap:9px;padding:8px 10px;border-radius:8px;font-size:13px;color:var(--ink-2);text-decoration:none;font-weight:500;margin-bottom:2px}
.sidebar .nav-item:hover{background:var(--bg)}
.sidebar .nav-item.on{background:var(--green-soft);color:var(--green-deep);font-weight:600}
.sidebar .nav-ic{width:16px;text-align:center;opacity:.9}
.content{padding:26px 30px}

/* screen scaffolding */
.screen{max-width:1080px;margin:0 auto}
.screen-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:18px}
.screen-head h1{font-size:24px;font-weight:700;letter-spacing:-.02em}
.placeholder-card{background:var(--card);border:1px solid var(--line);border-radius:var(--radius);padding:26px;box-shadow:var(--shadow)}
.placeholder-card p{color:var(--ink-2);margin-bottom:6px}

/* shared components (used in later phases) */
.btn{border:none;border-radius:var(--radius-sm);padding:9px 15px;font-family:inherit;font-weight:600;font-size:12.5px;cursor:pointer}
.btn-green{background:var(--green);color:#fff}
.btn-ghost{background:var(--card);color:var(--ink-2);border:1px solid var(--line)}
.card{background:var(--card);border:1px solid var(--line);border-radius:var(--radius)}
.pill{font-size:10.5px;font-weight:600;border-radius:100px;padding:2px 9px;background:var(--green-soft);color:var(--green-deep)}
```

- [ ] **Step 2: Manual verify the file loads**

Run the app: `uvicorn backend.main:app --port 8000` (from repo root), then open `http://localhost:8000/styles/clean-studio.css` in a browser.
Expected: the CSS text is served (HTTP 200), not a 404.

- [ ] **Step 3: Commit**

```bash
git add frontend/styles/clean-studio.css
git commit -m "feat(ui): add Clean Studio design-token stylesheet"
```

---

## Task 2: Preserve the existing interview app as legacy.html

**Files:**
- Create: `frontend/legacy.html` (copy of current `frontend/index.html`)

- [ ] **Step 1: Copy the current app before we replace index.html**

Run:
```bash
cp frontend/index.html frontend/legacy.html
```
This keeps the working interview flow reachable at `/legacy.html`. It references `app.js`, `style.css`, etc. by relative path, which still resolve from the frontend static mount.

- [ ] **Step 2: Manual verify legacy still works**

Run `uvicorn backend.main:app --port 8000`, open `http://localhost:8000/legacy.html`.
Expected: the original Rehearsal start screen ("Begin interview") renders exactly as before.

- [ ] **Step 3: Commit**

```bash
git add frontend/legacy.html
git commit -m "chore(ui): preserve current interview app as legacy.html"
```

---

## Task 3: Hash router module

**Files:**
- Create: `frontend/router.js`

- [ ] **Step 1: Write the router**

Create `frontend/router.js` with exactly this content:

```js
// Minimal hash router. Patterns like '/session/:id' capture params.
const routes = [];
let notFoundHandler = () => {};

export function register(pattern, handler){ routes.push({ pattern, handler }); }
export function setNotFound(fn){ notFoundHandler = fn; }

export function currentPath(){
  const raw = (location.hash || '#/').replace(/^#/, '');
  return raw === '' ? '/' : raw;
}

function matchPattern(pattern, path){
  const pp = pattern.split('/').filter(Boolean);
  const xp = path.split('/').filter(Boolean);
  if (pp.length !== xp.length) return null;
  const params = {};
  for (let i = 0; i < pp.length; i++){
    if (pp[i].startsWith(':')) params[pp[i].slice(1)] = decodeURIComponent(xp[i]);
    else if (pp[i] !== xp[i]) return null;
  }
  return params;
}

function resolve(){
  const path = currentPath();
  for (const { pattern, handler } of routes){
    const params = matchPattern(pattern, path);
    if (params){ handler(params, path); return; }
  }
  notFoundHandler(path);
}

export function navigate(path){ location.hash = '#' + path; }

export function start(){
  window.addEventListener('hashchange', resolve);
  if (!location.hash) location.hash = '#/';
  else resolve();
}
```

- [ ] **Step 2: Verify (covered by Task 6 manual nav check)**

The router is exercised once `main.js` wires it (Task 6). No standalone JS test (no JS test runner by design).

- [ ] **Step 3: Commit**

```bash
git add frontend/router.js
git commit -m "feat(ui): add hash router"
```

---

## Task 4: App shell + sidebar module

**Files:**
- Create: `frontend/shell.js`

- [ ] **Step 1: Write the shell module**

Create `frontend/shell.js` with exactly this content:

```js
// Renders the persistent shell (sidebar + content slot) and the sidebar nav.
const NAV = [
  { group: null, items: [
    { path: '/',         icon: '◷', label: 'Dashboard' },
    { path: '/history',  icon: '▤', label: 'History' },
    { path: '/progress', icon: '◴', label: 'Progress' },
    { path: '/new',      icon: '＋', label: 'New interview' },
  ]},
  { group: 'Live tools', items: [
    { path: '/facial', icon: '◉', label: 'Facial Analysis' },
    { path: '/audio',  icon: '♫', label: 'Audio Analysis' },
  ]},
  { group: null, items: [
    { path: '/settings', icon: '⚙', label: 'Settings' },
    { path: '/library',  icon: '▥', label: 'Role & question library' },
  ]},
];

export function mountShell(root){
  root.innerHTML =
    '<div class="app-shell">' +
      '<aside class="sidebar" id="sidebar"></aside>' +
      '<main class="content" id="content"></main>' +
    '</div>';
  return {
    sidebar: root.querySelector('#sidebar'),
    content: root.querySelector('#content'),
  };
}

export function renderSidebar(sidebar, activePath){
  const isActive = (p) => p === '/' ? activePath === '/' : activePath.startsWith(p);
  const html = ['<div class="brand">Rehearsal</div>'];
  for (const sec of NAV){
    if (sec.group) html.push('<div class="nav-group">' + sec.group + '</div>');
    for (const it of sec.items){
      html.push(
        '<a class="nav-item ' + (isActive(it.path) ? 'on' : '') + '" href="#' + it.path + '">' +
          '<span class="nav-ic">' + it.icon + '</span>' + it.label +
        '</a>'
      );
    }
  }
  sidebar.innerHTML = html.join('');
}
```

- [ ] **Step 2: Verify (covered by Task 6 manual nav check)**

- [ ] **Step 3: Commit**

```bash
git add frontend/shell.js
git commit -m "feat(ui): add app shell and sidebar nav"
```

---

## Task 5: Screen registry + placeholder screens

**Files:**
- Create: `frontend/screens/placeholder.js`
- Create: `frontend/screens/registry.js`

- [ ] **Step 1: Write the placeholder helper**

Create `frontend/screens/placeholder.js` with exactly this content:

```js
// Builds a Clean Studio placeholder screen. Replaced per-screen in later phases.
export function placeholder(title, note){
  return (params) => {
    const idSuffix = params && params.id ? ' · ' + params.id : '';
    return '' +
      '<div class="screen">' +
        '<div class="screen-head"><h1>' + title + idSuffix + '</h1></div>' +
        '<div class="placeholder-card">' +
          '<p>' + note + '</p>' +
          '<p class="muted">Placeholder — this screen is built in a later phase.</p>' +
        '</div>' +
      '</div>';
  };
}
```

- [ ] **Step 2: Write the route registry**

Create `frontend/screens/registry.js` with exactly this content:

```js
import { placeholder } from './placeholder.js';

// Route pattern -> render(params) => htmlString. Phase 1 = placeholders.
export const screens = [
  ['/',            placeholder('Dashboard', 'Overview, headline stats, and recent sessions.')],
  ['/history',     placeholder('History', 'All saved sessions in a sortable table.')],
  ['/progress',    placeholder('Progress', 'Trends across all sessions.')],
  ['/new',         placeholder('New interview', 'Camera/mic check and role pick.')],
  ['/live',        placeholder('Live interview', 'The recording screen.')],
  ['/session/:id', placeholder('Session report', 'A single saved session report.')],
  ['/facial',      placeholder('Facial Analysis', 'Live MediaPipe instrument (Face / Pose / Hands).')],
  ['/audio',       placeholder('Audio & Transcript Analysis', 'Live Deepgram instrument.')],
  ['/settings',    placeholder('Settings', 'Toggles and preferences.')],
  ['/library',     placeholder('Role & question library', 'Manage interview roles and questions.')],
];
```

- [ ] **Step 3: Commit**

```bash
git add frontend/screens/placeholder.js frontend/screens/registry.js
git commit -m "feat(ui): add screen registry and placeholder screens"
```

---

## Task 6: New shell entry + bootstrap

**Files:**
- Create: `frontend/main.js`
- Modify: `frontend/index.html` (replace whole file)

- [ ] **Step 1: Write the bootstrap module**

Create `frontend/main.js` with exactly this content:

```js
import { mountShell, renderSidebar } from './shell.js';
import * as router from './router.js';
import { screens } from './screens/registry.js';

const root = document.getElementById('app');
const { sidebar, content } = mountShell(root);

function show(html){
  content.innerHTML = html;
  renderSidebar(sidebar, router.currentPath());
  content.scrollTop = 0;
}

for (const [pattern, render] of screens){
  router.register(pattern, (params) => show(render(params)));
}
router.setNotFound(() =>
  show('<div class="screen"><div class="screen-head"><h1>Not found</h1></div>' +
       '<p class="muted">No screen for this route.</p></div>')
);

router.start();
```

- [ ] **Step 2: Replace index.html with the new shell**

Replace the entire contents of `frontend/index.html` with exactly this:

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Rehearsal — Studio</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;600&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/styles/clean-studio.css">
</head>
<body>
  <div id="app"></div>
  <script type="module" src="/main.js"></script>
</body>
</html>
```

- [ ] **Step 3: Manual verify navigation works end to end**

Run `uvicorn backend.main:app --port 8000`, open `http://localhost:8000/`.
Expected:
- The sidebar renders with: Dashboard, History, Progress, New interview, a "Live tools" group (Facial Analysis, Audio Analysis), Settings, Role & question library.
- Dashboard placeholder shows by default; the Dashboard nav item is highlighted (green).
- Clicking each nav item changes the content heading and moves the green highlight.
- Visiting `http://localhost:8000/#/session/abc123` shows "Session report · abc123".
- Visiting `http://localhost:8000/#/nonsense` shows "Not found".

- [ ] **Step 4: Commit**

```bash
git add frontend/main.js frontend/index.html
git commit -m "feat(ui): mount shell + router as new app entry"
```

---

## Task 7: Data layer (fetch wrappers for Phase 2 endpoints)

**Files:**
- Create: `frontend/api.js`

- [ ] **Step 1: Write the data layer**

Create `frontend/api.js` with exactly this content:

```js
// Thin fetch wrappers for the backend. Endpoints land in Phase 2; defined now
// so screen modules can import a stable surface.
async function request(method, url, body){
  const opts = { method, headers: {} };
  if (body !== undefined){
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(method + ' ' + url + ' -> ' + res.status);
  return res.status === 204 ? null : res.json();
}

export const api = {
  listSessions:   ()        => request('GET',    '/api/sessions'),
  getSession:     (id)      => request('GET',    '/api/sessions/' + encodeURIComponent(id)),
  deleteSession:  (id)      => request('DELETE', '/api/sessions/' + encodeURIComponent(id)),
  renameSession:  (id, lbl) => request('PATCH',  '/api/sessions/' + encodeURIComponent(id), { label: lbl }),
  getSettings:    ()        => request('GET',    '/api/settings'),
  putSettings:    (s)       => request('PUT',    '/api/settings', s),
  getRoles:       ()        => request('GET',    '/api/roles'),
  putRoles:       (r)       => request('PUT',    '/api/roles', r),
};
```

- [ ] **Step 2: Commit**

```bash
git add frontend/api.js
git commit -m "feat(ui): add backend data-layer wrappers"
```

---

## Task 8: Backend serving tests + verification

**Files:**
- Create: `tests/test_shell.py`

- [ ] **Step 1: Write the failing tests**

Create `tests/test_shell.py` with exactly this content:

```python
from fastapi.testclient import TestClient
from backend.main import app

client = TestClient(app)


def test_root_serves_new_shell():
    r = client.get("/")
    assert r.status_code == 200
    assert 'id="app"' in r.text
    assert "/main.js" in r.text


def test_clean_studio_css_served():
    r = client.get("/styles/clean-studio.css")
    assert r.status_code == 200
    assert "--green:#157a4c" in r.text


def test_router_and_shell_modules_served():
    for path in ("/router.js", "/shell.js", "/main.js",
                 "/api.js", "/screens/registry.js", "/screens/placeholder.js"):
        assert client.get(path).status_code == 200, path


def test_legacy_app_preserved():
    r = client.get("/legacy.html")
    assert r.status_code == 200
    assert 'id="screen-start"' in r.text  # original start screen marker
```

- [ ] **Step 2: Run the tests to verify they pass**

Run: `pytest tests/test_shell.py -v`
Expected: all four tests PASS (Tasks 1–7 created every file they assert on). If a test fails with 404, the corresponding file from an earlier task is missing or misnamed — fix that file, do not weaken the test.

- [ ] **Step 3: Full manual smoke check**

Run `uvicorn backend.main:app --port 8000`:
- `http://localhost:8000/` → new shell, all nav items, default Dashboard placeholder.
- Click through every nav item → heading + active highlight update.
- `http://localhost:8000/legacy.html` → original interview app still fully works (start a short interview if you want to be thorough).

- [ ] **Step 4: Commit**

```bash
git add tests/test_shell.py
git commit -m "test(ui): assert new shell served and legacy app preserved"
```

---

## Phase 1 Done — Definition of Done

- New Clean Studio shell at `/` with a working sidebar + hash router and placeholders for all ten routes.
- `pytest tests/test_shell.py` passes.
- The original interview app is intact at `/legacy.html`.
- No build step introduced; `backend/` and the existing interview JS are unchanged.

**Next:** Plan 2 — backend read-back endpoints (`GET /api/sessions`, `GET /api/sessions/{id}`, `DELETE`, `PATCH`), persist `role` into `summary.json`, then build the real Dashboard, History, and rewired Session Report with client-side SVG charts.
