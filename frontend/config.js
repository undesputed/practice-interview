// frontend/config.js
export const CONFIG = {
  WASM_BASE: "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm",
  MODEL_URL: "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
  POSE_MODEL_URL: "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task",
  GESTURE_MODEL_URL: "https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task",
  OBJECT_MODEL_URL: "https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/float16/1/efficientdet_lite0.tflite",
  POSE_THROTTLE_MS: 120,  // run pose + hands ~8x/sec
  EMOTION_THROTTLE_MS: 3000,  // capture ~1 face crop per 3s for the interview emotion track
  EMOTION_CROP_PX: 112,       // square crop size sent to the backend (interview batch path)
  EMOTION_MAX_SHOTS: 200,     // hard cap on buffered crops per interview
  EMOTION_LIVE_MS: 2000,      // live Facial screen: snapshot for the emotion model every ~2s
  EMOTION_LIVE_CROP_PX: 256,  // square face-crop size sent to the live emotion model
  // Blendshapes forwarded to the backend (smile, blink, brow, and 8 eyeLook* for gaze)
  BLENDSHAPES: ["mouthSmileLeft", "mouthSmileRight", "eyeBlinkLeft", "eyeBlinkRight", "browInnerUp",
    "eyeLookInLeft", "eyeLookInRight", "eyeLookOutLeft", "eyeLookOutRight",
    "eyeLookUpLeft", "eyeLookUpRight", "eyeLookDownLeft", "eyeLookDownRight",
    "jawOpen", "browOuterUpLeft", "browOuterUpRight",
    "eyeSquintLeft", "eyeSquintRight", "mouthPressLeft", "mouthPressRight",
    "browDownLeft", "browDownRight", "jawLeft", "jawRight",
    "noseSneerLeft", "noseSneerRight", "mouthFrownLeft", "mouthFrownRight",
    // emotion-relevant (added for the MediaPipe emotion track)
    "cheekSquintLeft", "cheekSquintRight", "mouthUpperUpLeft", "mouthUpperUpRight",
    "eyeWideLeft", "eyeWideRight", "mouthStretchLeft", "mouthStretchRight"],
  ROLES: ["Software Engineer", "Product Manager", "Data Analyst", "Customer Support"],
};
