# Rehearsal — UI Redesign Design Spec

**Date:** 2026-06-09
**Status:** Approved design, ready for implementation planning
**Topic:** Full UI layout redesign — single-screen tool → multi-screen "studio"

---

## 1. Overview

Rehearsal is a local, privacy-focused mock-interview studio. Today it is a single-page
app with three states (start → live interview → results) and a warm "editorial" look.
Reports are raw Matplotlib PNGs, and saved sessions are written to disk but never read
back.

This redesign turns Rehearsal into a small **single-user, local studio**: a dashboard
with a left sidebar and ten screens, in a new "Clean Studio" visual system. The change is
deliberately **additive** — the real-time analysis engine (MediaPipe, Deepgram, Web Audio)
is wrapped, not rewritten.

### What this is NOT
No accounts, no login, no multi-user, no cloud database, no billing. Single user, local
machine, single privileged context.

---

## 2. Goals & Non-Goals

### Goals
- A real "home" that lists and reopens past sessions (today they are write-only on disk).
- A consistent, modern visual system across every screen ("Clean Studio").
- Two new live "instrument" screens: Facial Analysis and Audio & Transcript Analysis.
- Crisp, on-brand charts rendered in the browser instead of raw Matplotlib PNGs.
- Keep zero-build deployment (FastAPI static serving + Docker) intact.

### Non-Goals (out of scope for this milestone)
- User accounts / authentication / multi-user data.
- A database (the filesystem `sessions/` directory remains the store).
- Real DeepFace wiring on the Facial Analysis screen (stubbed behind the toggle).
- A real "Local" audio engine and tone/sentiment analysis (stubbed behind the toggle).
- A framework migration (React/Vue/Svelte). Explicitly deferred; see §6.

---

## 3. The Ten Screens

| # | Screen | Purpose | Status |
|---|--------|---------|--------|
| 1 | Dashboard (Home) | Greeting, headline stats, recent sessions, "New interview" CTA | New |
| 2 | History / All sessions | Sortable, filterable table of every saved session | New |
| 3 | Session report (detail) | Existing report, restyled + loadable by ID | Exists · rewired |
| 4 | New interview (setup) | Camera/mic check + role pick + readiness → launch | Exists · slimmed |
| 5 | Live interview | Recording screen; restyle only | Exists · unchanged logic |
| 6 | Settings | Surface env flags as editable toggles | New |
| 7 | Progress / Insights | Trends across all sessions | New |
| 8 | Role & question library | CRUD on interview roles + question banks | New |
| 9 | Facial Analysis | Live MediaPipe instrument (Face/Pose/Hands) | New · low-effort |
| 10 | Audio & Transcript Analysis | Live Deepgram instrument (transcript + speech metrics) | New · low-effort |

### 3.1 Dashboard (Home)
Landing screen after the app loads. Contains:
- Greeting + small subtitle ("12 sessions · last one 2 days ago").
- Three headline stat cards: total sessions, average confidence, average nervousness,
  each with a trend delta.
- "Recent sessions" list (most recent 3–4) with role, date, and score pills; links to the
  full report.
- A small "Confidence over time" sparkline (SVG).
- Primary "+ New interview" button.

### 3.2 History / All sessions
- Full-width table: Date, Role, Question count, Attention, Confidence, Nervousness,
  Composure. Scores are color-coded (green good / amber mid / red high-nerves).
- Controls: search box, role filter, sort (newest/oldest/score).
- Each row click opens its report (`#/session/:id`).
- Per-row `⋯` menu: **Rename**, **Export PDF**, **Delete**.
- Reads back the sessions already written to `sessions/`.

### 3.3 Session report (detail)
The existing results content, restyled into Clean Studio and made re-openable by ID:
- Back link to History; header with role, date, duration; "Export PDF" button.
- Four score cards (Attention, Confidence, Nervousness, Composure) with mini bars.
- Category cards (Eye & Gaze, Head Pose, Expression, Posture, Engagement, Integrity).
- Coaching panel (Claude output): score, summary, strengths, improvements.
- **Timeline chart rendered as client-side SVG** (not a Matplotlib PNG).
- Emotion section: MediaPipe track now; DeepFace track when enabled.
- Per-question breakdown.

### 3.4 New interview (setup)
Today's start screen, focused into one launch step:
- Left: live camera preview + device pickers (camera, mic) + live mic-level meter.
- Right: role picker (radio list), readiness checklist (camera connected, mic working,
  face detected & centered), and the "Start interview →" button.

### 3.5 Live interview
Logic unchanged. Restyle the existing webcam canvas, HUD strip, transcript pane, and
signals feed to Clean Studio. Still the most time-sensitive code — **do not change the
MediaPipe/Deepgram loop**, only its surrounding markup/styles.

### 3.6 Settings
Surfaces configuration that lives in environment flags today as visible, editable controls:
- Toggle: DeepFace emotion analysis on/off.
- Toggle: Claude coaching on/off.
- Default camera / microphone device.
- Data location (where `sessions/` is written) — display, optionally editable.
- Status indicators: Deepgram key present, Claude key present.
Persisted to a backend `settings.json` the server reads on startup and per request as
appropriate.

### 3.7 Progress / Insights
Trends across all saved sessions (reads the same list as History):
- Line charts (SVG) of Attention / Confidence / Nervousness / Composure over time.
- Best and worst session highlights; totals; optional per-role breakdown.

### 3.8 Role & question library
- List of interview roles, each with an editable question bank.
- CRUD: add/rename/delete roles; add/edit/reorder/delete questions.
- Backed by a JSON file the backend reads when configuring an interview (the roles that
  are effectively hardcoded today).

### 3.9 Facial Analysis (live instrument)
Standalone live screen — no recording, nothing saved, all in-browser:
- Control rail: **Emotion engine** toggle (MediaPipe ↔ DeepFace), **Detection mode**
  (Face / Pose / Hands), Start/Stop camera, live status (FPS, detections).
- Camera stage with mesh/landmark overlay.
- "Expression Analysis" panel below, in the Clean Studio light-panel style (re-skinned
  from the earlier warm mockup to match the rest of the app): dominant readout + metric bars.
- MediaPipe = continuous, real. DeepFace = **stubbed for now** (same panel, MediaPipe-
  derived data), wired to the existing `/api/emotion` endpoint later; includes a graceful
  "DeepFace not enabled — turn it on in Settings" state.

### 3.10 Audio & Transcript Analysis (live instrument)
The audio twin of Facial Analysis — same layout pattern:
- Control rail: **Transcription engine** toggle (Deepgram ↔ Local), **View** mode
  (Both / Transcript only / Acoustics only), Start/Stop listening, live status (duration,
  words, pace).
- "Stage" is a live waveform visualizer (Web Audio).
- "Speech Analysis" panel: Pace (WPM), Filler words, Volume, Pause ratio, Clarity, Energy,
  with a dominant tone readout.
- Live transcript card with filler words highlighted.
- Deepgram + pace + filler counting = real. "Local" engine and tone/sentiment = **stubbed**,
  same panel, wired later.

---

## 4. Visual System — "Clean Studio"

Chosen over "Warm Editorial" (the current look) and "Pro Instrument" (dark). Crisp,
modern-SaaS, data-forward, while staying calm enough for an anxious candidate.

### Palette
| Token | Hex | Use |
|-------|-----|-----|
| bg | `#f7f8f7` | App background |
| card | `#ffffff` | Cards, panels, nav |
| ink | `#11150f` | Primary text, headings |
| ink-2 | `#3a403c` | Body text |
| ink-3 | `#7c837d` | Labels, secondary |
| line | `#e6e8e6` | Borders |
| line-2 | `#eceeec` | Subtle dividers |
| green | `#157a4c` | Primary accent / actions |
| green-soft | `#eef6f0` | Active nav, soft fills, pills |
| green-deep | `#0f5c39` | Accent text on soft fills |
| amber | `#b4791f` | Mid scores / warnings |
| red | `#c0492f` | High nervousness / destructive |
| blue | `#2f6fb4` | Secondary chart series |

### Typography
- **Inter** for everything (400–700).
- **JetBrains Mono** for numeric metrics (stats, FPS, dB, WPM) for alignment.

### Shared components (build once, reuse)
Sidebar nav (with a "Live tools" group), top bar, stat card, score card + mini bar,
metric/blendshape bar row, data table, chart card, segmented toggle, radio list,
status list, pill/badge.

### Navigation
Left sidebar, grouped:
- Dashboard · History · Progress · New interview
- **Live tools:** Facial Analysis · Audio Analysis
- Settings · Role & question library

---

## 5. Architecture

Guiding principle: **wrap the real-time engine, never rewrite it.** The MediaPipe loop,
Deepgram client, and Web Audio code are the highest-risk, highest-value parts and stay as
vanilla JS.

### 5.1 Frontend
- **Vanilla JS, no build step.** No new toolchain; FastAPI keeps serving static files.
- **Hash-based router** (`#/`, `#/history`, `#/session/:id`, `#/new`, `#/facial`,
  `#/audio`, `#/settings`, `#/progress`, `#/library`). Works with static serving, no
  server route config.
- **Structure:**
  - `router` module — maps hash → screen render function, handles params.
  - `shell` / `layout` module — renders the persistent sidebar + content slot.
  - One **render module per screen** — pure function that builds its DOM into the slot.
  - **Shared UI helpers** — small functions returning elements/strings for the reusable
    components in §4.
  - A thin **data layer** — fetch wrappers for the new backend endpoints.
- The Live interview, Facial Analysis, and Audio Analysis screens mount the existing
  MediaPipe/Deepgram/Web Audio modules into their stage; that code is reused verbatim.

### 5.2 Charts
- Rendered **client-side as SVG** from `summary.json` (data already saved per session).
- Matplotlib is removed from the UI path. The backend may still emit PNGs as optional
  downloadable artifacts, but the app does not embed them.
- **Export PDF** = browser print-to-PDF against a print-styled report; no server rendering.

### 5.3 Backend (FastAPI) — additive endpoints
- `GET /api/sessions` — list saved sessions (read `sessions/`, parse each `summary.json`:
  id, date, role, question count, scores).
- `GET /api/sessions/{id}` — return one session's `summary.json` (+ transcript, chart data,
  coaching, emotion data) for the report screen.
- `DELETE /api/sessions/{id}` — delete a session directory.
- `PATCH /api/sessions/{id}` — rename / set a label.
- `GET`/`PUT /api/settings` — read/write `settings.json`.
- `GET`/`PUT /api/roles` — read/write the roles + question library JSON.
- **Unchanged:** `POST /api/interview/token`, `POST /api/emotion`, `POST /api/session`,
  and the entire recording → analysis → report-generation pipeline.

### 5.4 Data flow
1. App loads → router renders Dashboard → `GET /api/sessions` for stats + recent list.
2. History → `GET /api/sessions` → table.
3. Click a row / Dashboard item → `#/session/:id` → `GET /api/sessions/{id}` → report,
   charts drawn client-side from the returned JSON.
4. New interview → setup → existing token/recording flow → on finish `POST /api/session`
   (unchanged) → redirect to `#/session/:newId`.
5. Facial / Audio analysis → no backend (except stubbed DeepFace via `/api/emotion`).
6. Settings / Library → read/write their JSON via the new endpoints.

---

## 6. Key Decisions & Trade-offs

- **Vanilla + router over a framework.** Accepts more boilerplate to avoid risking the
  timing-sensitive engine and to keep zero-build deployment. Framework migration is the
  documented future escape hatch if scope grows well beyond ten screens.
- **Hash routing over History API.** Simpler; no server catch-all needed. Slightly less
  clean URLs — acceptable for a local single-user tool.
- **Client-side SVG charts over restyled Matplotlib.** Crisp, responsive, on-brand, and
  removes a heavy server dependency from the UI path.
- **Stubbed engines (DeepFace, Local audio, tone/sentiment).** Ship the toggles and panels
  now with real data behind one option; wire the second option later without UI churn.

---

## 7. Suggested Build Order

1. **Foundation** — Clean Studio design tokens + shared components; shell + sidebar; hash
   router; data layer.
2. **Core loop back** — new backend endpoints (list/get/delete/rename); Dashboard;
   History; Report rewire with client-side SVG charts.
3. **Capture path** — New-interview setup; restyle Live interview (no logic change).
4. **Live instruments** — Facial Analysis; Audio & Transcript Analysis (reuse existing
   MediaPipe/Deepgram modules; stub the second engine on each).
5. **Management** — Settings (+ `settings.json`); Progress / Insights; Role & question
   library (+ roles JSON).

---

## 8. Documentation to Update

When implemented, update: `README`, `deploy/DEPLOY.md`, any `docs/features/*` that
describe the report/charts or emotion tracks, and add a short note that Matplotlib PNGs are
no longer the in-app charts.

---

## 9. Design References (local only)

Interactive mockups produced during brainstorming live under
`.superpowers/brainstorm/<session>/content/` (gitignored, local machine):
- `00-current-baseline.html` — the pre-redesign look.
- `01-screen-map.html` — screen inventory.
- `02–03 facial-analysis*.html` — Facial Analysis layout + engine toggle.
- `04-visual-directions.html` — the three directions; **Clean Studio (Dir 2) chosen**.
- `05-clean-studio-screens.html` — History, Report, New-interview in Clean Studio.
- `06-audio-analysis.html` — Audio & Transcript Analysis.
