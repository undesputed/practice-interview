# Live Interview UI Redesign — Design

- **Date:** 2026-06-16
- **Status:** Approved (design); pending implementation plan
- **Topic:** Redesign the `/live` interview screen into an immersive, full-screen, Google-Meet-style experience: the candidate's video fills the window, the conversation appears as captions (with a slide-out transcript), an AI interviewer tile sits in the lower-right, and a bottom control bar offers mute / camera / end.

## 1. Problem & Context

Today's `/live` screen ([frontend/screens/live.js](../../../frontend/screens/live.js)) is a dense dashboard: a thin status rail (State/Voice/Elapsed/Face/FPS/Detections), a 16:9 video in the content area, and two panels below (Conversation + Live actions). It renders inside the app shell ([frontend/shell.js](../../../frontend/shell.js)), so the nav sidebar is always beside it.

The goals (all chosen by the user): **focus the video**, **better conversation**, **visual polish**, and originally "surface live feedback" — but on review the user decided to **remove the live feedback display from the live screen** (the detection still runs for the post-interview report).

## 2. Goals

1. Make the candidate's video the full-screen centerpiece (immersive, distraction-free).
2. Show the conversation as live captions, with the full transcript one tap away.
3. Add Google-Meet-style controls: **mute**, **camera toggle**, **end interview**.
4. Add a small **AI interviewer tile** (lower-right) that animates when the AI speaks.
5. Hide the app sidebar during the interview for a true full-screen feel.
6. Apply clean visual polish (simple line icons, calm overlays).

## 3. Non-Goals

- No change to the scoring backend or the post-interview report (Plans 1–4 of readiness scoring stay as-is).
- The live **feedback/actions panel is removed** from the live screen (MediaPipe actions/emotion still computed in the background and still flow to the report).
- No new emotion/voice models. No change to how the interview is conducted (Deepgram voice agent unchanged).

## 4. Decisions (locked during brainstorming)

| # | Decision | Choice |
|---|----------|--------|
| 1 | Layout direction | **Immersive video + captions** (Option B) — video fills the stage |
| 2 | Live feedback on the live screen | **Removed** (still computed for the report) |
| 3 | Conversation | **Captions** (latest line) + **slide-out transcript** panel |
| 4 | Controls | Bottom-center bar: **mute (mic), camera toggle, End interview** |
| 5 | Control icons | **Simple line icons** (stroked mic + video-cam, slashed when off); 46px circular buttons |
| 6 | AI presence | **Small AI interviewer tile**, lower-right, pulses while the AI speaks |
| 7 | Sidebar during the interview | **Hidden** (full-screen); a small `← Exit` returns to the app |
| 8 | Exit vs End | **Two distinct actions** — Exit = leave without scoring (confirm first); End = finish + score + report |

## 5. Layout & Components

All overlays sit on a single full-bleed video **stage** that fills the viewport (sidebar hidden):

- **Stage** — the candidate's camera, mirrored, `object-fit: cover`, fills the window. When the camera is off, the stage shows a dark "Camera off" panel instead.
- **Top-left cluster:** `← Exit` button · `● LIVE · mm:ss` pill · voice-state pill (`Connecting… / Live / Reconnecting`).
- **Top-right:** `Transcript` toggle button.
- **Captions** (bottom-center, above the controls): the most recent conversation line with an `Interviewer` / `You` label, updating as each line is transcribed (subtitle style). Older lines fade out.
- **AI interviewer tile** (lower-right, above the control bar): a rounded tile with a gradient avatar; a green ring **pulses while the AI is speaking**, calm while listening; a small name label (`Interviewer`) with a status dot.
- **Control bar** (bottom-center): three controls —
  - **Mic** (mute toggle) — line mic icon; slashed + red when muted.
  - **Camera** (toggle) — line video-cam icon; slashed + red when off.
  - **End interview** — red pill button.
- **Transcript panel:** slides over the right ~half (desktop) / full-screen (mobile) with the full scrollable conversation; close with the toggle or ✕.

States reuse the stage: **Loading model… → Connecting… → Live** at start; **Processing… (scoring)** at end; the mic-blocked fallback shows "Mic unavailable — analysis only."

## 6. Behavior

- **Sidebar hiding:** entering `/live` adds a body/shell class (e.g. `live-immersive`) that hides `.sidebar` and removes content padding; leaving `/live` removes it (restoring the normal app chrome). The existing `hashchange` teardown in `live()` is the natural place to remove it.
- **Captions:** `onTranscript` updates a caption element with the latest line (in addition to the transcript buffer used for scoring). Speaker label + fade.
- **Transcript toggle:** shows/hides the slide-over; the conversation list lives there.
- **Mute:** stops sending mic audio to the voice agent (the AI won't hear/respond) **and pauses the audio recording**, so muted silence doesn't drag down the Delivery score. Unmute resumes both. Requires a mute hook on the voice-agent client and pause/resume on the recorder.
- **Camera toggle:** turns the camera off — hides the canvas, shows the "Camera off" panel, and **pauses MediaPipe frame capture** (the report notes the camera was off for that stretch rather than scoring absence). Turning it back on resumes. The audio interview continues throughout.
- **AI speaking state:** the voice-agent client exposes when TTS audio is playing; the AI tile shows speaking (pulse) vs listening.
- **Exit (← top-left):** confirms "Leave without scoring?"; on confirm, tears down (no session created), removes the immersive class, returns to the app (e.g. dashboard).
- **End interview:** the existing finish path — stop, score, "Processing…", open the report.
- **Responsive:** stage is full-width on mobile; the transcript panel becomes a full-screen overlay; controls stay bottom-center.

## 7. Affected Components

- [frontend/screens/live.js](../../../frontend/screens/live.js) — rewrite the screen markup (full-bleed stage + overlays) and wire the new controls, captions, transcript toggle, exit/end, and immersive class. (Keep the existing capture/finish/scoring logic from the readiness-scoring work intact.)
- [frontend/styles/clean-studio.css](../../../frontend/styles/clean-studio.css) — new immersive styles (stage, overlay pills, caption, control bar + icons, AI tile + pulse, transcript slide-over, `live-immersive` sidebar hiding, responsive rules). Retire the old `.fa-grid`/`.live-cols` live-screen rules.
- [frontend/shell.js](../../../frontend/shell.js) or its CSS — support hiding the sidebar via the `live-immersive` class.
- [frontend/deepgram-client.js](../../../frontend/deepgram-client.js) — add a **mute** control (stop/resume sending mic PCM) and an **AI-speaking** callback (TTS playing → speaking).
- [frontend/interview-engine.js](../../../frontend/interview-engine.js) — add **pause/resume of frame capture** for the camera toggle (and skip drawing while off).
- `frontend/audio-recorder.js` — **pause/resume** on mute (MediaRecorder `pause()`/`resume()`).

## 8. Edge Cases

- **Mic blocked at start** → vision-only fallback; mute control disabled or hidden (nothing to mute); voice state shows "analysis only."
- **Camera off at End** → finish still works; the report degrades facial metrics for the off stretch (Plan 1 already tolerates missing pose/face frames).
- **Exit mid-interview** → no session is created (matches today's navigate-away); confirm dialog prevents accidental loss.
- **Transcript open when the interview ends** → close it and proceed to Processing/report.
- **AI-speaking signal unavailable** → the tile defaults to the calm/listening state (never blocks).

## 9. Testing

No JS test runner exists for the frontend, so this is verified manually in the browser (the readiness-scoring backend tests are unaffected). Manual checks: full-screen with no sidebar; captions update; transcript slides; mute stops the AI hearing you + pauses recording; camera toggle blanks video + resumes; AI tile pulses while it talks; Exit leaves without a report; End scores and opens the report; mobile layout.

## 10. References

- Approved mockups (visual companion): `.superpowers/brainstorm/59536-1781586349/content/option-b-final.html` (and the iterations beside it).
- Current implementation: [live.js](../../../frontend/screens/live.js), [shell.js](../../../frontend/shell.js), [clean-studio.css](../../../frontend/styles/clean-studio.css), [deepgram-client.js](../../../frontend/deepgram-client.js), [interview-engine.js](../../../frontend/interview-engine.js).
