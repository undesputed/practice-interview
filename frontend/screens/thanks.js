// frontend/screens/thanks.js
// Two render paths:
//   #/thanks/pending  - shown immediately after the interview ends. Runs voice analysis
//                       then the session POST with animated progress + live detail log.
//   #/thanks/:id      - shown once scoring succeeds; results are ready.
import { api } from "../api.js";
import { takePendingSession, peekPendingSession, setPendingSession } from "../pending-session.js";
import { computeAcousticFeatures } from "../acoustic-features.js";
import { t } from "../i18n.js";

function dims() {
  return [
    { name: t("thanks.dim.voice"), pct: 40, desc: t("thanks.dim.voiceDesc") },
    { name: t("thanks.dim.presence"), pct: 35, desc: t("thanks.dim.presenceDesc") },
    { name: t("thanks.dim.content"), pct: 25, desc: t("thanks.dim.contentDesc") },
  ];
}

function facts() {
  return [0, 1, 2, 3, 4, 5].map(function(i) { return t("thanks.fact." + i); });
}

function steps() {
  return [t("thanks.step.camera"), t("thanks.step.voice"), t("thanks.step.report")];
}

function voiceLog() {
  return [0, 1, 2, 3, 4, 5].map(function(i) { return t("thanks.vlog." + i); });
}

function sessionLog() {
  return [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map(function(i) { return t("thanks.slog." + i); });
}

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

function finishPhaseLog() {
  clearLogTimers();
  const log = document.getElementById("th-log");
  if (!log) return;
  const active = log.querySelector(".th-log-line.active");
  if (active) active.className = "th-log-line done";
}

// ── HTML builders ─────────────────────────────────────────────────────────────

function stepsHTML(activeIdx) {
  return steps().map(function(s, i) {
    const cls = i < activeIdx ? "done" : i === activeIdx ? "active" : "";
    return '<div class="lv-step ' + cls + '" id="th-step-' + i + '">' + s + "</div>";
  }).join("");
}

function statsHTML(stats) {
  if (!stats || !stats.wordCount) return "";
  return (
    '<div class="th-words">' +
    '<span class="th-words-n">' + fmtN(stats.wordCount) + "</span>" +
    '<span class="th-words-l">' + t("thanks.wordsSpoken") + "</span>" +
    "</div>"
  );
}

function formulaHTML() {
  return (
    '<div class="th-section">' +
    '<div class="th-section-label">' + t("thanks.scoreHow") + "</div>" +
    dims().map(function(d) {
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
    '<div class="th-dim-note">' + t("thanks.scoreNote") + "</div>" +
    "</div>"
  );
}

function insightsHTML(stats) {
  const factList = facts();
  return (
    '<div class="th-insights">' +
    statsHTML(stats) +
    formulaHTML() +
    '<div class="th-fact">' +
    '<div class="th-fact-icon">&#128161;</div>' +
    '<div>' +
    '<div class="th-fact-label">' + t("thanks.didYouKnow") + "</div>" +
    '<div class="th-fact-text" id="th-fact-text">' + factList[0] + "</div>" +
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
    '<h1 id="th-title">' + t("thanks.preparing") + "</h1>" +
    '<p class="muted" id="th-sub">' + t("thanks.hangTight") + "</p>" +
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
    ? '<a class="btn btn-green" style="text-decoration:none" href="#/session/' + encodeURIComponent(id) + '">' + t("thanks.viewResults") + "</a>"
    : "";
  return (
    '<div class="screen"><div class="thanks-wrap">' +
    '<div class="thanks-check">✓</div>' +
    "<h1>" + t("thanks.thankYou") + "</h1>" +
    '<p class="muted">' + (id ? t("thanks.completeReady") : t("thanks.complete")) + "</p>" +
    '<div class="thanks-actions">' +
    viewBtn +
    '<a class="btn btn-ghost" style="text-decoration:none" href="#/progress">' + t("thanks.seeProgress") + "</a>" +
    '<a class="btn btn-ghost" style="text-decoration:none" href="#/practice-interview">' + t("thanks.newPractice") + "</a>" +
    "</div></div></div>"
  );
}

function setStepState(idx, state) {
  const el = document.getElementById("th-step-" + idx);
  if (el) el.className = "lv-step" + (state ? " " + state : "");
}

let _factTimer = null;

function startFactRotation() {
  let idx = 0;
  const factList = facts();
  _factTimer = setInterval(function() {
    if (location.hash !== "#/thanks/pending") { clearInterval(_factTimer); return; }
    const el = document.getElementById("th-fact-text");
    if (!el) { clearInterval(_factTimer); return; }
    idx = (idx + 1) % factList.length;
    el.style.opacity = "0";
    setTimeout(function() {
      if (el.isConnected) { el.textContent = factList[idx]; el.style.opacity = "1"; }
    }, 300);
  }, 6000);
}

function animateBars() {
  document.querySelectorAll(".th-dim-fill").forEach(function(el) {
    el.style.width = el.getAttribute("data-w") || "0%";
  });
}

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

async function runPendingSession() {
  const pending = takePendingSession();
  if (!pending) {
    location.replace(location.pathname + location.search + "#/");
    return;
  }

  const { scenario, role, frames, transcript, events, emotion, audioBlob, language } = pending;

  let voice = null;
  if (audioBlob) {
    startPhaseLog(voiceLog(), 900);
    try {
      const acoustic = await computeAcousticFeatures(audioBlob);
      voice = await api.analyzeVoice(audioBlob, acoustic || {});
    } catch (e) {
      voice = null;
    }
  }
  finishPhaseLog();

  setStepState(1, "done");
  setStepState(2, "active");

  startPhaseLog(sessionLog(), 1400);

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

function showError(pending, voice, err) {
  const icon    = document.getElementById("th-icon");
  const title   = document.getElementById("th-title");
  const sub     = document.getElementById("th-sub");
  const stepsEl = document.getElementById("th-steps");
  const log     = document.getElementById("th-log");
  const actions = document.getElementById("th-actions");

  if (icon)  { icon.className = "thanks-check"; icon.style.cssText = "background:#c0392b;box-shadow:0 10px 24px -14px #c0392b"; icon.textContent = "✕"; }
  if (title) title.textContent = t("thanks.errorTitle");
  const detail = err && err.message ? String(err.message) : "";
  if (sub) {
    sub.textContent = detail
      ? t("thanks.errorBodyDetail", { detail: detail })
      : t("thanks.errorBody");
  }
  if (stepsEl) stepsEl.style.display = "none";
  if (log)   log.style.display = "none";
  if (!actions) return;

  actions.innerHTML =
    '<button class="btn btn-green" id="th-retry">' + t("thanks.retry") + "</button>" +
    '<a class="btn btn-ghost" style="text-decoration:none" href="#/">' + t("thanks.goDash") + "</a>";
  actions.style.display = "";

  const btn = document.getElementById("th-retry");
  if (!btn) return;

  btn.addEventListener("click", async function() {
    const stepLabels = steps();
    btn.disabled = true;
    btn.textContent = t("thanks.retrying");
    if (icon)  { icon.className = "th-ring-spin"; icon.style.cssText = ""; icon.textContent = ""; }
    if (title) title.textContent = t("thanks.preparing");
    if (sub)   sub.textContent = t("thanks.hangTight");
    if (stepsEl) {
      stepsEl.innerHTML =
        '<div class="lv-step done" id="th-step-0">' + stepLabels[0] + "</div>" +
        '<div class="lv-step done" id="th-step-1">' + stepLabels[1] + "</div>" +
        '<div class="lv-step active" id="th-step-2">' + stepLabels[2] + "</div>";
      stepsEl.style.display = "flex";
    }
    if (log) { log.innerHTML = ""; log.style.display = ""; }
    actions.style.display = "none";

    startPhaseLog(sessionLog(), 1400);

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
    } catch (retryErr) {
      finishPhaseLog();
      showError(pending, voice, retryErr);
    }
  });
}
