// frontend/app.js
import { CONFIG } from "./config.js";
import { startVoiceAgent } from "./deepgram-client.js";
import { pickPose, pickHands, pickObjects } from "./landmarks.js";
import { createActionDetector } from "./actions.js";
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
let emotionShots = [];
let lastEmotionTs = 0;
const cropCanvas = document.createElement("canvas");
let events = [];
let actionDetector = null;
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

function fmtTime(ms) {
  const mm = String(Math.floor(ms / 60000)).padStart(2, "0");
  const ss = String(Math.floor((ms % 60000) / 1000)).padStart(2, "0");
  return `${mm}:${ss}`;
}

// Derive a padded pixel bounding box around the face from normalized landmarks.
function faceBox(landmarks, w, h, pad = 0.2) {
  let minX = 1, minY = 1, maxX = 0, maxY = 0;
  for (const p of landmarks) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  const bw = maxX - minX, bh = maxY - minY;
  minX -= bw * pad; maxX += bw * pad; minY -= bh * pad; maxY += bh * pad;
  const sx = Math.max(0, minX * w), sy = Math.max(0, minY * h);
  const sw = Math.min(w, maxX * w) - sx, sh = Math.min(h, maxY * h) - sy;
  return { sx, sy, sw, sh };
}

function appendAction(ev) {
  const el = $("actions");
  if (!el) return;
  const div = document.createElement("div");
  div.className = "action-line";
  div.textContent = `${fmtTime(ev.t)} · ${ev.icon} ${ev.label}`;
  el.appendChild(div);
  el.scrollTop = el.scrollHeight;
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
    for (const fl of result.faceLandmarks) {
      draw.drawConnectors(fl, FaceLandmarker.FACE_LANDMARKS_TESSELATION,
        { color: "#30FF9080", lineWidth: 0.5 });
    }
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

  // Object detection boxes (from the throttled cache).
  if (lastObjectResult && lastObjectResult.detections) {
    ctx.strokeStyle = "#FFD23F"; ctx.lineWidth = 2; ctx.fillStyle = "#FFD23F"; ctx.font = "14px sans-serif";
    for (const d of lastObjectResult.detections) {
      const b = d.boundingBox; const c = d.categories && d.categories[0];
      if (!b || !c) continue;
      ctx.strokeRect(b.originX, b.originY, b.width, b.height);
      ctx.fillText(`${c.categoryName} ${c.score.toFixed(2)}`, b.originX, Math.max(14, b.originY - 4));
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

  // Emotion: throttled face crop buffered for batch DeepFace analysis at end.
  if (hasFace && now - lastEmotionTs >= CONFIG.EMOTION_THROTTLE_MS
      && emotionShots.length < CONFIG.EMOTION_MAX_SHOTS) {
    lastEmotionTs = now;
    const box = faceBox(result.faceLandmarks[0], video.videoWidth, video.videoHeight);
    if (box.sw > 4 && box.sh > 4) {
      cropCanvas.width = CONFIG.EMOTION_CROP_PX;
      cropCanvas.height = CONFIG.EMOTION_CROP_PX;
      const cctx = cropCanvas.getContext("2d");
      cctx.drawImage(video, box.sx, box.sy, box.sw, box.sh,
                     0, 0, CONFIG.EMOTION_CROP_PX, CONFIG.EMOTION_CROP_PX);
      const capturedT = frame.t, capturedTurn = turnIndex;
      cropCanvas.toBlob((blob) => {
        if (blob) emotionShots.push({ t: capturedT, turn: capturedTurn, blob });
      }, "image/jpeg", 0.8);
    }
  }

  if (actionDetector) {
    const gestureNames = (lastHandResult && lastHandResult.gestures)
      ? lastHandResult.gestures.map((g) => g && g[0] && g[0].categoryName)
      : [];
    for (const ev of actionDetector.feed({ t: frame.t, turn: turnIndex, bs, gestures: gestureNames, m, face: hasFace })) {
      events.push(ev);
      appendAction(ev);
    }
  }

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
  frames = []; segments = []; turnIndex = -1; events = [];
  emotionShots = []; lastEmotionTs = 0;
  actionDetector = createActionDetector();
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

  let emotion = null;
  if (emotionShots.length) {
    try {
      const fd = new FormData();
      fd.append("meta", JSON.stringify(emotionShots.map((s) => ({ t: s.t, turn: s.turn }))));
      for (const s of emotionShots) fd.append("images", s.blob, "crop.jpg");
      const er = await fetch("/api/emotion", { method: "POST", body: fd });
      if (er.ok) emotion = await er.json();
    } catch (e) {
      console.warn("[interview] emotion upload failed:", e.message);
    }
  }

  const r = await fetch("/api/session", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ role, frames, transcript: { full_text, segments }, events, emotion }),
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
    `Facial tension: ${o.facial_tension}/100`,
    `Tension signals — squint ${o.eye_squint} · lip-press ${o.lip_press} · brow-down ${o.brow_down} · jaw ${o.jaw_shift}`,
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
  const ig = s.integrity || {};
  fillList("card-presence", [
    `Face present: ${o.face_presence_pct}%`,
    `Another person detected: ${ig.another_person_detected ? "yes" : "no"} (${ig.multi_face_pct ?? 0}% of frames)`,
    `Device in frame: ${ig.device_detected ? "yes" : "no"} (${ig.device_in_frame_pct ?? 0}%)`,
    `Objects seen: ${(ig.objects_seen || []).map((x) => x.label + " " + x.pct + "%").join(", ") || "none"}`,
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

  const act = data.summary.actions || { counts: {}, events: [] };
  fillList("card-actions", Object.entries(act.counts).map(([k, v]) => `${k} ×${v}`));
  const tl = $("actions-timeline");
  if (tl) {
    while (tl.firstChild) tl.removeChild(tl.firstChild);
    for (const ev of (act.events || [])) {
      const li = document.createElement("li");
      li.textContent = `${fmtTime(ev.t)} · ${ev.icon} ${ev.label}`;
      tl.appendChild(li);
    }
  }

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
