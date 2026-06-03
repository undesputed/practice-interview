// frontend/config.js
export const CONFIG = {
  // MediaPipe Face Landmarker assets (pin a version that matches the CDN import in app.js)
  WASM_BASE: "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm",
  MODEL_URL: "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
  // Blendshapes we forward to the backend (keep small)
  BLENDSHAPES: ["mouthSmileLeft", "mouthSmileRight", "eyeBlinkLeft", "eyeBlinkRight", "browInnerUp"],
  ROLES: ["Software Engineer", "Product Manager", "Data Analyst", "Customer Support"],
};
