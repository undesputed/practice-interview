// frontend/app.js
import { CONFIG } from "./config.js";
import { startVoiceAgent } from "./deepgram-client.js";
import { FaceLandmarker, FilesetResolver, DrawingUtils }
  from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35";

let landmarker = null;
let frames = [];
let segments = [];
let turnIndex = -1;       // -1 until the first interviewer line
let sessionStart = 0;
let agent = null;
let mediaStream = null;
let running = false;
let role = CONFIG.ROLES[0];

const $ = (id) => document.getElementById(id);
function show(screen) {
  for (const s of ["screen-start", "screen-interview", "screen-results"])
    $(s).style.display = (s === screen) ? "" : "none";
}

async function initLandmarker() {
  const fileset = await FilesetResolver.forVisionTasks(CONFIG.WASM_BASE);
  landmarker = await FaceLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: CONFIG.MODEL_URL },
    runningMode: "VIDEO",
    numFaces: 1,
    outputFaceBlendshapes: true,
    outputFacialTransformationMatrixes: true,
  });
}

function pickBlendshapes(categories) {
  const out = {};
  for (const k of CONFIG.BLENDSHAPES) out[k] = 0;
  if (categories) for (const c of categories)
    if (CONFIG.BLENDSHAPES.includes(c.categoryName)) out[c.categoryName] = c.score;
  return out;
}

function renderLoop(video, canvas, ctx, draw) {
  if (!running) return;
  const now = performance.now();
  const result = landmarker.detectForVideo(video, now);
  const hasFace = result.faceLandmarks && result.faceLandmarks.length > 0;

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  if (hasFace) {
    draw.drawConnectors(result.faceLandmarks[0],
      FaceLandmarker.FACE_LANDMARKS_TESSELATION, { color: "#30FF9080", lineWidth: 0.5 });
  }

  const bs = pickBlendshapes(hasFace ? result.faceBlendshapes?.[0]?.categories : null);
  const m = hasFace && result.facialTransformationMatrixes?.[0]
    ? Array.from(result.facialTransformationMatrixes[0].data)
    : [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];

  frames.push({ t: now - sessionStart, turn: turnIndex, face: hasFace, bs, m });

  $("hud-time").textContent = ((now - sessionStart) / 1000).toFixed(0) + "s";
  $("hud-question").textContent = "Q" + (turnIndex + 1);
  $("hud-face").textContent = hasFace ? "face ✓" : "face ✗";

  requestAnimationFrame(() => renderLoop(video, canvas, ctx, draw));
}

function onTranscript({ speaker, text }) {
  if (speaker === "interviewer") turnIndex += 1;  // matches questions_from_transcript indexing
  segments.push({ speaker, text, t: performance.now() - sessionStart });
  const li = document.createElement("div");
  li.className = "line " + speaker;
  li.textContent = (speaker === "interviewer" ? "Interviewer: " : "You: ") + text;
  $("transcript").appendChild(li);
  $("transcript").scrollTop = $("transcript").scrollHeight;
}

async function startInterview() {
  role = $("role-select").value || CONFIG.ROLES[0];
  frames = []; segments = []; turnIndex = -1;
  show("screen-interview");

  mediaStream = await navigator.mediaDevices.getUserMedia({
    video: { width: 1280, height: 720, facingMode: "user" },
    audio: { sampleRate: 48000, channelCount: 1,
             echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });

  const video = document.createElement("video");
  video.srcObject = mediaStream; video.muted = true; await video.play();

  const canvas = $("cam");
  canvas.width = 1280; canvas.height = 720;
  const ctx = canvas.getContext("2d");
  const draw = new DrawingUtils(ctx);

  if (!landmarker) await initLandmarker();

  const tokenResp = await fetch("/api/interview/token", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ role }),
  }).then((r) => r.json());

  sessionStart = performance.now();
  running = true;
  renderLoop(video, canvas, ctx, draw);

  agent = startVoiceAgent({
    url: tokenResp.url, token: tokenResp.token, config: tokenResp.config,
    micStream: mediaStream, onTranscript, onClose: () => {},
  });
}

async function endInterview() {
  running = false;
  if (agent) agent.stop();
  if (mediaStream) mediaStream.getTracks().forEach((t) => t.stop());

  const full_text = segments
    .map((s) => (s.speaker === "interviewer" ? "INTERVIEWER: " : "CANDIDATE: ") + s.text)
    .join("\n");

  const resp = await fetch("/api/session", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ role, frames, transcript: { full_text, segments } }),
  }).then((r) => r.json());

  renderResults(resp);
  show("screen-results");
}

function clearChildren(el) { while (el.firstChild) el.removeChild(el.firstChild); }

function renderResults(data) {
  const o = data.summary.overall;
  const ov = $("metrics-overall");
  clearChildren(ov);
  for (const text of [
    `Eye contact: ${o.eye_contact_pct}%`,
    `Steadiness: ${o.steadiness_score}/100`,
    `Smiling: ${o.pct_smiling}% (peak ${o.peak_smile})`,
    `Blinks: ${o.blink_count} (${o.blinks_per_min}/min)`,
    `No-face: ${data.summary.no_face_pct}%`,
  ]) {
    const li = document.createElement("li");
    li.textContent = text;
    ov.appendChild(li);
  }

  const tb = $("metrics-per-question");
  clearChildren(tb);
  for (const q of data.summary.per_question) {
    const tr = document.createElement("tr");
    for (const cell of [q.question, `${q.metrics.eye_contact_pct}%`,
                        `${q.metrics.steadiness_score}`, `${q.metrics.pct_smiling}%`,
                        `${q.metrics.blink_count}`]) {
      const td = document.createElement("td");
      td.textContent = cell;
      tr.appendChild(td);
    }
    tb.appendChild(tr);
  }

  $("chart-img").src = data.charts_url;

  const co = $("coaching");
  clearChildren(co);
  if (data.coaching) {
    const c = data.coaching;
    const mk = (label, value) => {
      const p = document.createElement("p");
      const strong = document.createElement("strong");
      strong.textContent = label;
      p.appendChild(strong);
      p.appendChild(document.createTextNode(" " + value));
      return p;
    };
    co.appendChild(mk("Score:", `${c.score ?? "—"}/10`));
    const summary = document.createElement("p");
    summary.textContent = c.summary || "";
    co.appendChild(summary);
    co.appendChild(mk("Strengths:", (c.strengths || []).join("; ")));
    co.appendChild(mk("Improve:", (c.improvements || []).join("; ")));
  } else {
    co.textContent = "Coaching not available (no Anthropic key or empty transcript).";
  }
}

window.addEventListener("DOMContentLoaded", () => {
  const sel = $("role-select");
  for (const r of CONFIG.ROLES) {
    const opt = document.createElement("option"); opt.value = r; opt.textContent = r;
    sel.appendChild(opt);
  }
  $("start-btn").addEventListener("click", () => startInterview().catch((e) => {
    alert("Could not start: " + e.message); show("screen-start");
  }));
  $("end-btn").addEventListener("click", () => endInterview().catch((e) => alert(e.message)));
  $("newsession-btn").addEventListener("click", () => show("screen-start"));
  show("screen-start");
});
