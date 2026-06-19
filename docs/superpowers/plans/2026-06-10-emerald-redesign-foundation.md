# Emerald Redesign — Foundation (Design System + Dark Mode) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Re-skin the live Rehearsal app to the approved "Emerald Growth" color scheme with new typography and a working light/dark theme toggle, so every existing screen adopts the new look without changing its layout yet.

**Architecture:** The app is vanilla-JS with a hash router; all visual tokens live in `frontend/styles/clean-studio.css`. We replace the `:root` token block with an Emerald palette (keeping the old token *names* as aliases so existing component CSS keeps working), add a `[data-theme="dark"]` override block, swap the Google Fonts, and add a tiny `frontend/theme.js` module plus a sidebar toggle that persists the choice in `localStorage`. No screen markup changes in this phase — richer per-screen components come in later phases (see Roadmap).

**Tech Stack:** Vanilla ES modules, FastAPI static serving, pytest (`TestClient`) for the served-asset contract, manual browser verification for visuals (the frontend has no JS test runner by design).

**Reference:** The approved visual target lives in-repo at `docs/superpowers/mockups/2026-06-09-ui-redesign-color-mockup.html` (Emerald scheme). Use it as the source of truth for exact token values and component styling.

**Key facts the executor must respect:**
- `tests/test_shell.py` asserts the literal `--green:#157a4c` is in the served CSS, and asserts an exact tuple of served JS modules. Both assertions are updated *in the same task* as the change that breaks them, so every commit stays green.
- `frontend/util.js` `esc()` must wrap any dynamic value interpolated into `innerHTML`. This phase adds no dynamic interpolation, but keep the rule in mind.
- Existing screens reference token names `--bg --card --ink --ink-2 --ink-3 --line --line-2 --green --green-soft --green-deep --amber --red --blue --radius --radius-sm --shadow`. These names are preserved as aliases — do **not** rename them.
- Run the app with: `uvicorn backend.main:app --port 8000` (then open `http://localhost:8000`).
- Run tests with: `pytest tests/test_shell.py -v` (or `pytest` for all).

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `frontend/styles/clean-studio.css` | Modify (token block + base + key components) | The whole design system: Emerald tokens (light + dark), typography, gradient buttons, themed surfaces |
| `frontend/index.html` | Modify (fonts) | Load Bricolage Grotesque + Hanken Grotesk + JetBrains Mono |
| `frontend/theme.js` | Create | Init theme from storage/OS, toggle, expose current theme |
| `frontend/shell.js` | Modify | Render a theme-toggle control in the sidebar footer |
| `frontend/main.js` | Modify | Call `initTheme()` on boot; delegate toggle clicks |
| `tests/test_shell.py` | Modify | Update CSS literal assertion + add `/theme.js` to served-module tuple + assert font load |

---

## Task 1: Emerald token block + dark theme in clean-studio.css

**Files:**
- Modify: `frontend/styles/clean-studio.css:1-8` (the `:root{…}` block)
- Modify: `tests/test_shell.py` (CSS literal assertion)

- [ ] **Step 1: Update the CSS contract test (red)**

In `tests/test_shell.py`, find the CSS assertion (currently `assert "--green:#157a4c" in r.text`) and replace it with the new stable anchor:

```python
    # clean-studio.css is served and carries the Emerald brand token
    css = client.get("/styles/clean-studio.css")
    assert css.status_code == 200
    assert "--brand:#0d9488" in css.text
    assert '[data-theme="dark"]' in css.text
```

> If the existing CSS assertion reads `r.text` from a different response variable, mirror the surrounding style — the point is to assert `--brand:#0d9488` and the dark block exist in the served `clean-studio.css`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pytest tests/test_shell.py -v`
Expected: FAIL — current CSS has `--green:#157a4c`, no `--brand` token, no dark block.

- [ ] **Step 3: Replace the `:root{…}` block (lines 1–8) with the Emerald system**

Replace the opening token block of `frontend/styles/clean-studio.css` with:

```css
/* Clean Studio — Emerald design tokens + dark theme. See mockup for visual target. */
:root{
  /* neutrals (emerald-tinted) */
  --bg:#f4f8f5; --surface:#ffffff; --surface-2:#f2f7f3; --surface-3:#e8f1ea;
  --ink:#0f1714; --ink-2:#45514b; --ink-3:#7c8a82;
  --line:#e1eae4; --line-2:#eef4f0;
  /* brand + tool hues */
  --brand:#0d9488; --brand-2:#16a34a;
  --face:#059669; --pose:#0891b2; --hands:#ca8a04;
  --good:#16a34a; --warn:#d97706; --risk:#e11d48; --info:#0891b2;
  /* soft tints — mix with --surface so they auto-darken in dark mode */
  --brand-soft:color-mix(in srgb,var(--brand) 14%,var(--surface));
  --face-soft:color-mix(in srgb,var(--face) 14%,var(--surface));
  --pose-soft:color-mix(in srgb,var(--pose) 14%,var(--surface));
  --hands-soft:color-mix(in srgb,var(--hands) 14%,var(--surface));
  --good-soft:color-mix(in srgb,var(--good) 14%,var(--surface));
  --warn-soft:color-mix(in srgb,var(--warn) 14%,var(--surface));
  --risk-soft:color-mix(in srgb,var(--risk) 14%,var(--surface));
  --info-soft:color-mix(in srgb,var(--info) 14%,var(--surface));
  /* back-compat aliases (existing screens reference these names) */
  --card:var(--surface);
  --green:var(--brand); --green-deep:#0f766e; --green-soft:var(--brand-soft);
  --amber:var(--warn); --red:var(--risk); --blue:var(--info);
  /* structural */
  --radius:16px; --radius-sm:11px; --radius-xs:8px; --r-pill:999px;
  --shadow:0 1px 2px rgba(16,30,24,.04), 0 12px 28px -20px rgba(16,30,24,.26);
  --shadow-lg:0 24px 60px -32px rgba(16,30,24,.38);
  --grad:linear-gradient(120deg,var(--brand),var(--brand-2));
  --grad-mesh:
     radial-gradient(900px 420px at 88% -10%, color-mix(in srgb,var(--brand-2) 14%,transparent), transparent 60%),
     radial-gradient(760px 460px at -8% 6%, color-mix(in srgb,var(--brand) 12%,transparent), transparent 55%);
  --stage:#0e1613; --stage-line:rgba(255,255,255,.08);
  --t:.22s cubic-bezier(.4,0,.2,1);
  --font-display:'Bricolage Grotesque',serif;
  --font-body:'Hanken Grotesk',system-ui,-apple-system,sans-serif;
  --font-mono:'JetBrains Mono',ui-monospace,monospace;
}
[data-theme="dark"]{
  --bg:#0a0f0c; --surface:#141b16; --surface-2:#19221c; --surface-3:#212d25;
  --ink:#e7f0ea; --ink-2:#aabcb1; --ink-3:#6e8076;
  --line:#1f2b24; --line-2:#18211b;
  --brand:#2dd4bf; --brand-2:#4ade80;
  --face:#34d399; --pose:#22d3ee; --hands:#facc15;
  --good:#4ade80; --warn:#fbbf24; --risk:#fb7185; --info:#38bdf8;
  --green-deep:#5eead4;
  --shadow:0 1px 2px rgba(0,0,0,.4), 0 18px 40px -26px rgba(0,0,0,.7);
  --shadow-lg:0 30px 70px -30px rgba(0,0,0,.85);
  --stage:#050806; --stage-line:rgba(255,255,255,.06);
  --grad-mesh:
     radial-gradient(1000px 520px at 90% -12%, color-mix(in srgb,var(--brand-2) 22%,transparent), transparent 60%),
     radial-gradient(820px 520px at -10% 0%, color-mix(in srgb,var(--brand) 20%,transparent), transparent 55%);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pytest tests/test_shell.py -v`
Expected: PASS — `--brand:#0d9488` and `[data-theme="dark"]` are now in the served CSS.

- [ ] **Step 5: Commit**

```bash
git add frontend/styles/clean-studio.css tests/test_shell.py
git commit -m "feat(ui): Emerald design tokens + dark theme block"
```

---

## Task 2: Swap fonts in index.html

**Files:**
- Modify: `frontend/index.html:9` (the Google Fonts `<link>`)
- Modify: `tests/test_shell.py` (index font assertion)

- [ ] **Step 1: Add a font assertion to the index test (red)**

In `tests/test_shell.py`, in the test that checks `index.html` (the one asserting `id="app"` and `/main.js`), add:

```python
    assert "Bricolage+Grotesque" in r.text
    assert "Hanken+Grotesk" in r.text
```

- [ ] **Step 2: Run to verify it fails**

Run: `pytest tests/test_shell.py -v`
Expected: FAIL — index.html still requests only Inter + JetBrains Mono.

- [ ] **Step 3: Replace the font link in `frontend/index.html`**

Replace the existing `<link href="https://fonts.googleapis.com/css2?family=Inter…">` line with:

```html
  <link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500..800&family=Hanken+Grotesk:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;700&display=swap" rel="stylesheet">
```

- [ ] **Step 4: Run to verify it passes**

Run: `pytest tests/test_shell.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/index.html tests/test_shell.py
git commit -m "feat(ui): load Bricolage Grotesque + Hanken Grotesk fonts"
```

---

## Task 3: theme.js module

**Files:**
- Create: `frontend/theme.js`
- Modify: `tests/test_shell.py` (served-module tuple)

- [ ] **Step 1: Add `/theme.js` to the served-module assertion (red)**

In `tests/test_shell.py`, add `"/theme.js"` to the tuple of paths asserted to return 200 (the tuple that already lists `/router.js`, `/shell.js`, `/main.js`, …):

```python
    for path in ("/router.js", "/shell.js", "/main.js", "/theme.js",
                 "/api.js", "/screens/registry.js", "/screens/placeholder.js", "/util.js",
                 "/format.js", "/charts.js", "/screens/dashboard.js",
                 "/screens/history.js", "/screens/report.js",
                 "/emotion.js", "/vision.js", "/screens/facial.js"):
        assert client.get(path).status_code == 200, path
```

- [ ] **Step 2: Run to verify it fails**

Run: `pytest tests/test_shell.py -v`
Expected: FAIL — `/theme.js` returns 404.

- [ ] **Step 3: Create `frontend/theme.js`**

```javascript
// Persisted light/dark theme. Applies data-theme on <html>; remembers choice.
const KEY = 'rehearsal-theme';

export function initTheme(){
  const saved = localStorage.getItem(KEY);
  const prefersDark = window.matchMedia &&
    window.matchMedia('(prefers-color-scheme: dark)').matches;
  const theme = saved || (prefersDark ? 'dark' : 'light');
  document.documentElement.setAttribute('data-theme', theme);
}

export function currentTheme(){
  return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
}

export function toggleTheme(){
  const next = currentTheme() === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem(KEY, next);
  return next;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pytest tests/test_shell.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/theme.js tests/test_shell.py
git commit -m "feat(ui): theme.js — persisted light/dark theme"
```

---

## Task 4: Wire theme init + sidebar toggle

**Files:**
- Modify: `frontend/main.js` (init on boot + delegate toggle clicks)
- Modify: `frontend/shell.js` (render the toggle in the sidebar footer)

- [ ] **Step 1: Render a toggle in the sidebar**

In `frontend/shell.js`, import `currentTheme` at the top:

```javascript
import { currentTheme } from './theme.js';
```

At the end of `renderSidebar(sidebar, activePath)`, append a footer block before `sidebar.innerHTML = html.join('')`. Add to the `html` array:

```javascript
  const dark = currentTheme() === 'dark';
  html.push(
    '<div class="side-foot">' +
      '<button class="theme-toggle" data-theme-toggle type="button">' +
        '<span class="tt-ic">' + (dark ? '☾' : '☀') + '</span>' +
        '<span>' + (dark ? 'Dark' : 'Light') + ' mode</span>' +
      '</button>' +
    '</div>'
  );
```

- [ ] **Step 2: Style the toggle**

Append to `frontend/styles/clean-studio.css`:

```css
/* theme toggle (sidebar footer) */
.side-foot{margin-top:18px;padding-top:14px;border-top:1px solid var(--line-2)}
.theme-toggle{display:flex;align-items:center;gap:9px;width:100%;cursor:pointer;
  background:var(--surface-2);border:1px solid var(--line);border-radius:var(--radius-sm);
  padding:9px 12px;font-family:inherit;font-size:13px;font-weight:600;color:var(--ink-2);
  transition:background var(--t),color var(--t),border-color var(--t)}
.theme-toggle:hover{border-color:var(--brand);color:var(--brand)}
.theme-toggle .tt-ic{font-size:15px}
```

- [ ] **Step 3: Init theme on boot + delegate toggle clicks in `frontend/main.js`**

Import at the top:

```javascript
import { initTheme, toggleTheme } from './theme.js';
```

Call `initTheme()` **before** `mountShell(...)` runs (it must set `data-theme` before first paint). Then, after the shell refs (`sidebar`, `content`) are obtained, add one delegated listener:

```javascript
  initTheme(); // before mountShell

  // …after mountShell gives you `sidebar`:
  sidebar.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-theme-toggle]');
    if (!btn) return;
    e.preventDefault();
    toggleTheme();
    renderSidebar(sidebar, router.currentPath());
  });
```

> The listener lives on the persistent `sidebar` element, so it survives the `innerHTML` re-render that `renderSidebar` performs on each navigation. Match the existing variable names in `main.js` (the explore map shows `renderSidebar(sidebar, router.currentPath())` is already used).

- [ ] **Step 4: Manual verification**

```bash
uvicorn backend.main:app --port 8000
```
Open `http://localhost:8000`. Verify:
1. App loads with Emerald colors (teal/green accents) and the new fonts.
2. The sidebar footer shows a "Light mode" toggle. Click it → whole app flips to dark; label becomes "Dark mode".
3. Navigate between Dashboard/History/Facial → the toggle stays and reflects the current theme.
4. Reload the page → the chosen theme persists (localStorage).
5. Open DevTools console → no errors.

- [ ] **Step 5: Commit**

```bash
git add frontend/main.js frontend/shell.js frontend/styles/clean-studio.css
git commit -m "feat(ui): light/dark toggle in sidebar with persistence"
```

---

## Task 5: Re-skin shared components for the new aesthetic + dark-mode safety

**Files:**
- Modify: `frontend/styles/clean-studio.css` (base + shared components + hardcoded-color audit)

- [ ] **Step 1: Update base typography + background mesh**

In `frontend/styles/clean-studio.css`, update the `body` rule to use the new font and mesh, and add a theme transition:

```css
body{
  background:var(--bg); background-image:var(--grad-mesh); background-attachment:fixed;
  color:var(--ink);
  font-family:var(--font-body);
  -webkit-font-smoothing:antialiased; line-height:1.5; letter-spacing:-.006em;
  transition:background-color var(--t), color var(--t);
}
.mono{font-family:var(--font-mono);font-variant-numeric:tabular-nums}
```

Add display-font to headings (find `.screen-head h1` and the `.brand`):

```css
.screen-head h1{font-family:var(--font-display);font-size:26px;font-weight:700;letter-spacing:-.025em}
.sidebar .brand{font-family:var(--font-display)}
```

- [ ] **Step 2: Gradient primary buttons + pills**

Replace the `.btn-green` rule and enrich the active nav:

```css
.btn-green{background:var(--grad);color:#fff;box-shadow:0 10px 24px -14px var(--brand)}
.btn-green:hover{box-shadow:0 14px 30px -14px var(--brand)}
.sidebar .nav-item.on{background:var(--brand-soft);color:var(--brand);font-weight:600}
```

- [ ] **Step 3: Audit hardcoded colors so dark mode is correct**

Replace these literal colors (they were baked for light mode and break in dark):

| Find | Replace with |
|---|---|
| `background:#fafbfa` (table `thead th`) | `background:var(--surface-2)` |
| `tr:hover td{background:#fafbfa}` | `tr:hover td{background:var(--surface-2)}` |
| `.fa-stage{background:#0f1113;` | `.fa-stage{background:var(--stage);` |
| `.fa-stage .ph{…color:#6f767c` | `…color:rgba(255,255,255,.55)` |
| `.fa-live .dot{…background:#7ad6a0}` | `…background:var(--good)}` |

Leave `.fa-live{background:rgba(20,18,16,.6);color:#fff}` as-is — it overlays the dark video stage and reads correctly in both themes.

- [ ] **Step 4: Manual verification (light + dark)**

```bash
uvicorn backend.main:app --port 8000
```
Open `http://localhost:8000`, then for **both** themes:
1. Dashboard: cards, stat numbers, score pills use Emerald hues; headings use Bricolage.
2. History: table header + row hover backgrounds adapt to the theme (no white-on-dark).
3. Report (`/session/<id>` via a History row, if any sessions exist): score bars/cards readable; emotion bars colored.
4. Facial Analysis: the video stage stays dark; the "LIVE" badge and start button render; segmented controls visible.
5. Primary buttons show the teal→green gradient.
6. No console errors.

Optional automated visual check (headless Chrome, server running):
```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --disable-gpu --hide-scrollbars --window-size=1440,1000 --screenshot=/tmp/app-light.png "http://localhost:8000/" && open /tmp/app-light.png
```

- [ ] **Step 5: Commit**

```bash
git add frontend/styles/clean-studio.css
git commit -m "style(ui): re-skin shared components + dark-mode color audit"
```

---

## Task 6: Full suite + final verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full backend suite**

Run: `pytest`
Expected: PASS (all existing tests, including the updated `test_shell.py`).

- [ ] **Step 2: Final manual pass**

With `uvicorn backend.main:app --port 8000` running, click every nav item in both themes and confirm: no broken layouts, no console errors, theme persists across reloads, legacy app still reachable at `/legacy.html`.

- [ ] **Step 3: Commit any final tweaks**

```bash
git add -A && git commit -m "chore(ui): finalize Emerald foundation phase"
```

---

## Self-Review (completed by author)

- **Spec coverage:** Color scheme (Task 1) ✓, dark mode + toggle (Tasks 3–4) ✓, fonts (Task 2) ✓, existing screens adopt the look (Tasks 1 + 5) ✓. Per-screen *detail* (sparklines, rings, timelines) is explicitly deferred to the Roadmap — not silently dropped.
- **Placeholder scan:** No TBD/TODO; every code step shows real code.
- **Type/name consistency:** `initTheme`/`toggleTheme`/`currentTheme` used identically across theme.js, main.js, shell.js. Token alias names match the existing screens' references.
- **Test-green invariant:** Each task that breaks a `test_shell.py` assertion updates that assertion in the same task, so no commit is left red.

---

## Roadmap — remaining phases (separate plans, one each)

This foundation makes the live app fully Emerald + dark-mode capable. The richer per-screen detail from the mockup follows as its own plan, each producing working software and each adding any new JS module to `tests/test_shell.py`:

- **Phase 5 — Dashboard + Progress.** KPI cards with sparklines, "readiness over time" chart, skill-balance bars, recent-sessions list, goal/streak ring. **Decision to resolve at plan time:** the mockup's labels were illustrative; bind cards to *real* data — composite scores (`attention/confidence/nervousness/composure`), session counts/dates from `api.listSessions()`, and body-language metrics from `overall{…}`. Likely needs a small client-side aggregator (or a new `GET /api/stats` endpoint, TDD'd) since there's no "weekly trend" stored today.
- **Phase 6 — Report.** Hero score ring, score cards, category breakdowns, emotion timeline, coach panel, transcript highlights, per-question table. Mostly frontend — the session schema already carries `overall`, `per_question[]`, `emotion(_mediapipe)`, `timing`, `coaching`. Maps cleanly; no new backend.
- **Phase 7 — Facial Analysis polish.** Apply the mockup's rail/stage/panel styling and the emotion-timeline strip to the existing `facial.js` (live data is already wired through `vision.js` + `emotion.js`).
- **Phase 8 — New interview + Live interview.** Build `screens/new.js` (role picker from `api.getRoles()` + device check) and `screens/live.js` (recording flow — port the loop from `frontend/legacy.html`/`app.js`, reusing `POST /api/interview/token` and `POST /api/session`). Largest; register both in `registry.js`, `shell.js` NAV, and `tests/test_shell.py`.

**Sequence rationale:** 5 and 6 are the highest-visibility "wow" screens and depend only on this foundation; 7 is a quick polish; 8 is the heaviest (real recording flow) and is best done last.
