// frontend/screens/thanks.js
// Two render paths:
//   #/thanks/pending  - shown immediately after the interview ends. Runs voice analysis
//                       then the session POST with animated progress + live detail log.
//   #/thanks/:id      - shown once scoring succeeds; results are ready.
import { api } from "../api.js";
import { takePendingSession, peekPendingSession, setPendingSession } from "../pending-session.js";
import { computeAcousticFeatures } from "../acoustic-features.js";

// Scoring dimension weights (mirrors backend/verdict.py WEIGHTS).
const DIMS = [
  { name: "Voice Delivery",   pct: 40, desc: "Speaking pace, filler words, pauses &amp; expressiveness" },
  { name: "Camera Presence",  pct: 35, desc: "Eye contact, posture, composure &amp; confidence" },
  { name: "Content Quality",  pct: 25, desc: "Clarity, structure, specificity &amp; relevance of answers" },
];

const FACTS = [
  "Interviewers form initial impressions within the first 7 seconds of meeting a candidate.",
  "Speaking at 130 to 150 words per minute is considered ideal -- clear, confident, and easy to follow.",
  "Eye contact during 60 to 70 percent of a conversation is associated with higher perceived trustworthiness.",
  "Candidates who use specific examples and numbers in their answers score significantly higher on content.",
  "Posture affects not just how others see you -- sitting upright can also boost your own confidence.",
  "The STAR method (Situation, Task, Action, Result) is the most common structured-answer framework used by interviewers.",
];

const STEPS = [
  "Analyzing camera & presence",
  "Analyzing your voice",
  "Generating your report",
];

// Log messages shown while voice analysis runs (step 1).
const VOICE_LOG = [
  "Processing audio recording...",
  "Transcribing speech to text...",
  "Measuring speaking pace (words per minute)...",
  "Counting filler words (um, uh, like)...",
  "Analyzing pause patterns...",
  "Computing voice delivery score...",
];

// Log messages shown while the session POST runs (step 2).
const SESSION_LOG = [
  "Analyzing captured video frames...",
  "Detecting face and landmark positions...",
  "Calculating eye contact percentage...",
  "Measuring head stability and composure...",
  "Scoring posture and shoulder alignment...",
  "Computing overall presence score...",
  "Reading your full interview transcript...",
  "Evaluating clarity and structure of answers...",
  "Assessing use of examples and specifics...",
  "Generating personalized coaching feedback...",
  "Writing your performance summary...",
  "Computing your readiness score...",
  "Saving your report...",
];

// ── helpers ──────────────────────────────────────────────────────────────────

function fmtN(n) {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function getStats(peek) {
  if (!peek) return null;
  const segs = (peek.transcript && peek.transcript.segments) ? peek.transcript.segments : [];
  const wordCount = segs
    .filter(function(s) { return s.speaker !== "interviewer"; })
    .reduce(function(acc, s) {
      return acc + (s.text ? s.text.trim().split(/\s+/).filter(Boolean).length : 0);
    }, 0);
  return { wordCount: wordCount };
}

// ── log engine ────────────────────────────────────────────────────────────────

let _logTimers = [];

function clearLogTimers() {
  _logTimers.forEach(clearTimeout);
  _logTimers = [];
}

function addLogLine(text, state) {
  const log = document.getElementById("th-log");
  if (!log) return;
  const line = document.createElement("div");
  line.className = "th-log-line" + (state ? " " + state : "");
  line.textContent = text;
  log.appendChild(line);
  log.scrollTop = log.scrollHeight;
}

// Schedule a sequence of log messages at `intervalMs` apart.
// Each new message marks the previous active one as done.
function startPhaseLog(messages, intervalMs) {
  clearLogTimers();
  messages.forEach(function(msg, i) {
    _logTimers.push(setTimeout(function() {
      const log = document.getElementById("th-log");
      if (!log) return;
      const prev = log.querySelector(".th-log-line.active");
      if (prev) prev.className = "th-log-line done";
      addLogLine(msg, "active");
    }, i * intervalMs));
  });
}

// Mark whatever is currently "active" as done and stop all pending timers.
function finishPhaseLog() {
  clearLogTimers();
  const log = document.getElementById("th-log");
  if (!log) return;
  const active = log.querySelector(".th-log-line.active");
  if (active) active.className = "th-log-line done";
}

// ── HTML builders ─────────────────────────────────────────────────────────────

function stepsHTML(activeIdx) {
  return STEPS.map(function(s, i) {
    const cls = i < activeIdx ? "done" : i === activeIdx ? "active" : "";
    return '<div class="lv-step ' + cls + '" id="th-step-' + i + '">' + s + "</div>";
  }).join("");
}

function statsHTML(stats) {
  if (!stats || !stats.wordCount) return "";
  return (
    '<div class="th-words">' +
    '<span class="th-words-n">' + fmtN(stats.wordCount) + "</span>" +
    '<span class="th-words-l">words spoken in this interview</span>' +
    "</div>"
  );
}

function formulaHTML() {
  return (
    '<div class="th-section">' +
    '<div class="th-section-label">How your readiness score is calculated</div>' +
    DIMS.map(function(d) {
      return (
        '<div class="th-dim">' +
        '<div class="th-dim-head">' +
        '<span class="th-dim-name">' + d.name + "</span>" +
        '<span class="th-dim-pct">' + d.pct + "%</span>" +
        "</div>" +
        '<div class="th-dim-bar-wrap"><div class="th-dim-fill" data-w="' + d.pct + '%"></div></div>' +
        '<div class="th-dim-desc">' + d.desc + "</div>" +
        "</div>"
      );
    }).join("") +
    '<div class="th-dim-note">Missing signals are dropped and remaining weights are renormalized -- partial results are never penalized.</div>' +
    "</div>"
  );
}

function insightsHTML(stats) {
  return (
    '<div class="th-insights">' +
    statsHTML(stats) +
    formulaHTML() +
    '<div class="th-fact">' +
    '<div class="th-fact-icon">&#128161;</div>' +
    '<div>' +
    '<div class="th-fact-label">Did you know?</div>' +
    '<div class="th-fact-text" id="th-fact-text">' + FACTS[0] + "</div>" +
    "</div>" +
    "</div>" +
    "</div>"
  );
}

function pendingHTML(peek) {
  const stats = getStats(peek);
  return (
    '<div class="screen">' +
    '<div class="thanks-wrap">' +
    '<div id="th-icon" class="th-ring-spin"></div>' +
    '<h1 id="th-title">Preparing your report...</h1>' +
    '<p class="muted" id="th-sub">Hang tight, this usually takes about 20 seconds.</p>' +
    '<div class="lv-steps" id="th-steps">' + stepsHTML(1) + "</div>" +
    '<div class="th-log" id="th-log"></div>' +
    '<div class="thanks-actions" id="th-actions" style="display:none"></div>' +
    "</div>" +
    insightsHTML(stats) +
    "</div>"
  );
}

function readyHTML(id) {
  const viewBtn = id
    ? '<a class="btn btn-green" style="text-decoration:none" href="#/session/' + encodeURIComponent(id) + '">View results</a>'
    : "";
  return (
    '<div class="screen"><div class="thanks-wrap">' +
    '<div class="thanks-check">✓</div>' +
    "<h1>Thank you!</h1>" +
    '<p class="muted">Your interview is complete' + (id ? " and your results are ready." : ".") + "</p>" +
    '<div class="thanks-actions">' +
    viewBtn +
    '<a class="btn btn-ghost" style="text-decoration:none" href="#/progress">See your progress</a>' +
    '<a class="btn btn-ghost" style="text-decoration:none" href="#/practice-interview">New practice interview</a>' +
    "</div></div></div>"
  );
}

// ── step helpers ──────────────────────────────────────────────────────────────

function setStepState(idx, state) {
  const el = document.getElementById("th-step-" + idx);
  if (el) el.className = "lv-step" + (state ? " " + state : "");
}

// ── fact rotation ─────────────────────────────────────────────────────────────

let _factTimer = null;

function startFactRotation() {
  let idx = 0;
  _factTimer = setInterval(function() {
    if (location.hash !== "#/thanks/pending") { clearInterval(_factTimer); return; }
    const el = document.getElementById("th-fact-text");
    if (!el) { clearInterval(_factTimer); return; }
    idx = (idx + 1) % FACTS.length;
    el.style.opacity = "0";
    setTimeout(function() {
      if (el.isConnected) { el.textContent = FACTS[idx]; el.style.opacity = "1"; }
    }, 300);
  }, 6000);
}

// ── bar animation ─────────────────────────────────────────────────────────────

function animateBars() {
  document.querySelectorAll(".th-dim-fill").forEach(function(el) {
    el.style.width = el.getAttribute("data-w") || "0%";
  });
}

// ── main export ───────────────────────────────────────────────────────────────

export function thanks(params) {
  const id = params && params.id;
  if (id === "pending") {
    const peek = peekPendingSession();
    queueMicrotask(function() {
      animateBars();
      startFactRotation();
      runPendingSession();
    });
    return pendingHTML(peek);
  }
  return readyHTML(id);
}

// ── scoring pipeline ──────────────────────────────────────────────────────────

async function runPendingSession() {
  const pending = takePendingSession();
  if (!pending) {
    location.replace(location.pathname + location.search + "#/");
    return;
  }

  const { scenario, role, frames, transcript, events, emotion, audioBlob, language } = pending;

  // Step 1: voice analysis (Deepgram, 2-5s)
  let voice = null;
  if (audioBlob) {
    startPhaseLog(VOICE_LOG, 900);
    try {
      const acoustic = await computeAcousticFeatures(audioBlob);
      voice = await api.analyzeVoice(audioBlob, acoustic || {});
    } catch (e) {
      voice = null;
    }
  }
  finishPhaseLog();

  // Step 2: session POST (presence analysis + Claude, 10-20s)
  setStepState(1, "done");
  setStepState(2, "active");

  startPhaseLog(SESSION_LOG, 1400);

  try {
    const resp = await api.createSession({
      scenario, role, frames, transcript, events, emotion, voice,
      language: language === 'ja' ? 'ja' : 'en',
    });
    finishPhaseLog();
    if (location.hash === "#/thanks/pending") {
      location.replace(location.pathname + location.search + "#/thanks/" + resp.session_id);
    }
  } catch (e) {
    finishPhaseLog();
    if (location.hash !== "#/thanks/pending") return;
    showError(pending, voice, e);
  }
}

// ── error state ───────────────────────────────────────────────────────────────

function showError(pending, voice, err) {
  const icon    = document.getElementById("th-icon");
  const title   = document.getElementById("th-title");
  const sub     = document.getElementById("th-sub");
  const steps   = document.getElementById("th-steps");
  const log     = document.getElementById("th-log");
  const actions = document.getElementById("th-actions");

  if (icon)  { icon.className = "thanks-check"; icon.style.cssText = "background:#c0392b;box-shadow:0 10px 24px -14px #c0392b"; icon.textContent = "✕"; }
  if (title) title.textContent = "Something went wrong";
  const detail = err && err.message ? String(err.message) : "";
  if (sub) {
    sub.textContent = detail
      ? ("We could not score your interview (" + detail + "). You can retry or go to the dashboard.")
      : "We could not score your interview. You can retry or go to the dashboard.";
  }
  if (steps) steps.style.display = "none";
  if (log)   log.style.display = "none";
  if (!actions) return;

  // All innerHTML values are hardcoded constants -- no user data interpolated.
  actions.innerHTML =
    '<button class="btn btn-green" id="th-retry">Retry scoring</button>' +
    '<a class="btn btn-ghost" style="text-decoration:none" href="#/">Go to dashboard</a>';
  actions.style.display = "";

  const btn = document.getElementById("th-retry");
  if (!btn) return;

  btn.addEventListener("click", async function() {
    btn.disabled = true;
    btn.textContent = "Retrying...";
    if (icon)  { icon.className = "th-ring-spin"; icon.style.cssText = ""; icon.textContent = ""; }
    if (title) title.textContent = "Preparing your report...";
    if (sub)   sub.textContent = "Hang tight, this usually takes about 20 seconds.";
    if (steps) {
      steps.innerHTML =
        '<div class="lv-step done" id="th-step-0">' + STEPS[0] + "</div>" +
        '<div class="lv-step done" id="th-step-1">' + STEPS[1] + "</div>" +
        '<div class="lv-step active" id="th-step-2">' + STEPS[2] + "</div>";
      steps.style.display = "flex";
    }
    if (log) { log.innerHTML = ""; log.style.display = ""; }
    actions.style.display = "none";

    startPhaseLog(SESSION_LOG, 1400);

    try {
      const resp = await api.createSession({
        scenario: pending.scenario, role: pending.role, frames: pending.frames,
        transcript: pending.transcript, events: pending.events,
        emotion: pending.emotion, voice: voice,
        language: pending.language === 'ja' ? 'ja' : 'en',
      });
      finishPhaseLog();
      if (location.hash === "#/thanks/pending") {
        location.replace(location.pathname + location.search + "#/thanks/" + resp.session_id);
      }
    } catch (err) {
      finishPhaseLog();
      showError(pending, voice, err);
    }
  });
}
