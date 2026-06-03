// frontend/app.js
import { CONFIG } from "./config.js";
import { startVoiceAgent } from "./deepgram-client.js";
import { pickPose, pickHands, pickObjects } from "./landmarks.js";
import { FaceLandmarker, PoseLandmarker, HandLandmarker, GestureRecognizer, ObjectDetector, FilesetResolver, DrawingUtils }
  from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35";

let landmarker = null;
let poseLandmarker = null;
let gestureRecognizer = null;
let lastHandResult = null;   // cached for smooth every-frame drawing
let objectDetector = null;
let lastObjectResult = null;
let lastBodyTs = 0;
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

// Read an error body safely: prefer JSON {detail}, fall back to raw text/status.
async function errorDetail(res) {
  const body = await res.text().catch(() => "");
  try { return JSON.parse(body).detail || body; } catch (_) { return body || String(res.status); }
}

// Append a non-speaker status/error line to the live transcript.
function systemLine(text) {
  const el = $("transcript");
  if (!el) return;
  const div = document.createElement("div");
  div.className = "line system";
  div.textContent = text;
  el.appendChild(div);
  el.scrollTop = el.scrollHeight;
}

async function initLandmarker() {
  const fileset = await FilesetResolver.forVisionTasks(CONFIG.WASM_BASE);
  landmarker = await FaceLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: CONFIG.MODEL_URL },
    runningMode: "VIDEO",
    numFaces: 2,
    outputFaceBlendshapes: true,
    outputFacialTransformationMatrixes: true,
  });
  poseLandmarker = await PoseLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: CONFIG.POSE_MODEL_URL },
    runningMode: "VIDEO", numPoses: 1,
  });
  gestureRecognizer = await GestureRecognizer.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: CONFIG.GESTURE_MODEL_URL },
    runningMode: "VIDEO", numHands: 2,
  });
  objectDetector = await ObjectDetector.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: CONFIG.OBJECT_MODEL_URL },
    runningMode: "VIDEO", scoreThreshold: 0.4, maxResults: 5,
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

  // Hand skeleton + gesture label, drawn every frame from the throttled cache (no flicker).
  if (lastHandResult && lastHandResult.landmarks) {
    const handed = lastHandResult.handedness || lastHandResult.handednesses || [];
    ctx.fillStyle = "#30FF90";
    ctx.font = "16px sans-serif";
    for (let h = 0; h < lastHandResult.landmarks.length; h++) {
      const lm = lastHandResult.landmarks[h];
      draw.drawConnectors(lm, HandLandmarker.HAND_CONNECTIONS, { color: "#FFFFFFB0", lineWidth: 2 });
      draw.drawLandmarks(lm, { color: "#30FF90", radius: 2 });
      const g = lastHandResult.gestures && lastHandResult.gestures[h] && lastHandResult.gestures[h][0];
      if (g && g.categoryName && g.categoryName !== "None") {
        const handName = handed[h] && handed[h][0] && handed[h][0].categoryName;
        const label = (handName ? handName + ": " : "") + g.categoryName + " " + g.score.toFixed(2);
        const labelY = Math.max(20, lm[0].y * canvas.height - 8);
        ctx.fillText(label, lm[0].x * canvas.width, labelY);
      }
    }
  }

  const bs = pickBlendshapes(hasFace ? result.faceBlendshapes?.[0]?.categories : null);
  const m = hasFace && result.facialTransformationMatrixes?.[0]
    ? Array.from(result.facialTransformationMatrixes[0].data)
    : [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];

  const faceCount = result.faceLandmarks ? result.faceLandmarks.length : 0;
  const frame = { t: now - sessionStart, turn: turnIndex, face: hasFace, face_count: faceCount, bs, m };

  // Pose + hands + objects are heavier — run them throttled and attach only on those frames.
  if (now - lastBodyTs >= CONFIG.POSE_THROTTLE_MS) {
    lastBodyTs = now;
    try {
      frame.pose = pickPose(poseLandmarker.detectForVideo(video, now));
      const hr = gestureRecognizer.recognizeForVideo(video, now);
      lastHandResult = (hr && hr.landmarks && hr.landmarks.length) ? hr : null;
      frame.hands = pickHands(hr);
      const orr = objectDetector.detectForVideo(video, now);
      lastObjectResult = orr;
      frame.objects = pickObjects(orr);
    } catch (e) { console.warn("[interview] body detect skipped:", e.message); }
  }
  frames.push(frame);

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
  lastHandResult = null; lastObjectResult = null; lastBodyTs = 0;
  show("screen-interview");
  console.log("[interview] starting; role=", role);

  mediaStream = await navigator.mediaDevices.getUserMedia({
    video: { width: 1280, height: 720, facingMode: "user" },
    audio: { sampleRate: 48000, channelCount: 1,
             echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  console.log("[interview] getUserMedia OK; audio tracks=%d video tracks=%d",
              mediaStream.getAudioTracks().length, mediaStream.getVideoTracks().length);

  const video = document.createElement("video");
  video.srcObject = mediaStream; video.muted = true; await video.play();

  const canvas = $("cam");
  canvas.width = 1280; canvas.height = 720;
  const ctx = canvas.getContext("2d");
  const draw = new DrawingUtils(ctx);

  if (!landmarker) { console.log("[interview] loading MediaPipe model…"); await initLandmarker(); }
  console.log("[interview] landmarker ready");

  const tokenRes = await fetch("/api/interview/token", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ role }),
  });
  if (!tokenRes.ok) throw new Error("token request failed: " + (await errorDetail(tokenRes)));
  const tokenResp = await tokenRes.json();
  console.log("[interview] token OK; scheme=%s tokenLen=%d", tokenResp.scheme, (tokenResp.token || "").length);

  sessionStart = performance.now();
  running = true;
  renderLoop(video, canvas, ctx, draw);

  agent = startVoiceAgent({
    url: tokenResp.url, token: tokenResp.token, scheme: tokenResp.scheme, config: tokenResp.config,
    micStream: mediaStream, onTranscript,
    onError: (m) => { console.error("[interview]", m); systemLine("⚠ " + m); },
    onClose: () => { if (running) systemLine("Voice connection closed."); },
  });
}

async function endInterview() {
  running = false;
  if (agent) agent.stop();
  if (mediaStream) mediaStream.getTracks().forEach((t) => t.stop());

  const full_text = segments
    .map((s) => (s.speaker === "interviewer" ? "INTERVIEWER: " : "CANDIDATE: ") + s.text)
    .join("\n");

  const r = await fetch("/api/session", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ role, frames, transcript: { full_text, segments } }),
  });
  if (!r.ok) {
    alert("Could not generate report: " + (await errorDetail(r)));
    show("screen-start");
    return;
  }
  const resp = await r.json();

  renderResults(resp);
  show("screen-results");
}

function clearChildren(el) { while (el.firstChild) el.removeChild(el.firstChild); }

function fillList(id, lines) {
  const el = $(id);
  if (!el) return;
  while (el.firstChild) el.removeChild(el.firstChild);
  for (const text of lines) {
    const li = document.createElement("li");
    li.textContent = text;
    el.appendChild(li);
  }
}

function renderResults(data) {
  const s = data.summary, o = s.overall, t = s.timing || {};
  const setChip = (id, v) => { const e = $(id); if (e) e.textContent = (v == null ? "—" : v); };
  setChip("chip-attention", o.attention);
  setChip("chip-confidence", o.confidence);
  setChip("chip-nervousness", o.nervousness);
  setChip("chip-composure", o.composure);

  const gb = o.gaze_breakdown || {};
  const hp = o.head_pose || { pitch: {}, yaw: {}, roll: {} };
  fillList("card-eye", [
    `Eye contact (gaze): ${o.gaze_eye_contact_pct}%`,
    `Gaze — center ${gb.center_pct}% · L ${gb.left_pct}% · R ${gb.right_pct}% · U ${gb.up_pct}% · D ${gb.down_pct}%`,
    `Blinks: ${o.blink_count} (${o.blinks_per_min}/min)`,
    `Eye openness: ${o.eye_openness}`,
  ]);
  fillList("card-head", [
    `Pitch: ${hp.pitch.mean}° (${hp.pitch.min}…${hp.pitch.max})`,
    `Yaw: ${hp.yaw.mean}° (${hp.yaw.min}…${hp.yaw.max})`,
    `Roll: ${hp.roll.mean}° (${hp.roll.min}…${hp.roll.max})`,
    `Head steadiness: ${o.steadiness_score}/100 (movement ${o.head_movement})`,
  ]);
  fillList("card-expression", [
    `Smile: mean ${o.mean_smile}, peak ${o.peak_smile} (${o.pct_smiling}% of time)`,
    `Eyebrow raise: ${o.eyebrow_raise}`,
    `Mouth open: ${o.mouth_open_mean} · speaking ${o.speaking_pct}%`,
  ]);
  fillList("card-posture", [
    `Upright posture: ${o.upright_pct}%`,
    `Lateral lean: ${o.lean}°`,
    `Body steadiness: ${o.body_steadiness}/100`,
    `Hand fidget: ${o.hand_fidget} · face-touches: ${o.face_touch_count}`,
  ]);
  fillList("card-engagement", [
    `Speaking vs listening: ${t.speaking_pct ?? 0}% speaking`,
    `Mean response time: ${t.mean_response_sec ?? 0}s`,
  ]);
  fillList("card-presence", [
    `Face present: ${o.face_presence_pct}%`,
    `No-face: ${s.no_face_pct}%`,
  ]);

  const tb = $("metrics-per-question");
  while (tb.firstChild) tb.removeChild(tb.firstChild);
  const rt = t.per_question_response_sec || [];
  for (const q of s.per_question) {
    const tr = document.createElement("tr");
    for (const cell of [q.question, `${q.metrics.gaze_eye_contact_pct}%`,
                        `${q.metrics.upright_pct}%`, `${q.metrics.composure}`,
                        rt[q.turn] != null ? `${rt[q.turn]}s` : "—",
                        `${q.metrics.face_touch_count}`]) {
      const td = document.createElement("td");
      td.textContent = cell;
      tr.appendChild(td);
    }
    tb.appendChild(tr);
  }

  $("chart-img").src = data.charts_url;
  $("saved-path").textContent = "Saved to sessions/" + data.session_id + "/";

  const co = $("coaching");
  while (co.firstChild) co.removeChild(co.firstChild);
  if (data.coaching) {
    const c = data.coaching;
    const mk = (label, value) => {
      const p = document.createElement("p");
      const b = document.createElement("strong"); b.textContent = label;
      p.appendChild(b); p.appendChild(document.createTextNode(" " + value));
      return p;
    };
    co.appendChild(mk("Score:", `${c.score ?? "—"}/10`));
    const sum = document.createElement("p"); sum.textContent = c.summary || ""; co.appendChild(sum);
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
