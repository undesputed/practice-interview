# MediaPipe vs DeepFace — Feature-by-Feature Comparison

A **standalone reference** for a second, DeepFace-based analysis track. This does **not**
replace the current MediaPipe pipeline. It maps every data point from
[`docs/features/data points`](./data%20points) onto both platforms and shows, per feature:
who has it, who lacks it, and where each is strong.

> Scope note: "MediaPipe" here = **MediaPipe Tasks for Web** as used in this project
> (Face Landmarker, Pose Landmarker, Gesture Recognizer, Object Detector).
> "DeepFace" = the Python [`deepface`](https://github.com/serengil/deepface) library
> (`verify`, `analyze`, `find`, `represent`, `extract_faces`, `stream`).

---

## 1. What each platform fundamentally is

| | MediaPipe Tasks | DeepFace |
|---|---|---|
| **Nature** | Geometric **signal extractor** — landmarks, blendshape coefficients, transform matrices | **Trained classifiers** — recognition embeddings + attribute models |
| **Outputs** | Numbers describing *shape & position* | Labels + probabilities (identity match, emotion class, age, gender, race) |
| **Scope** | Face **+ body + hands + objects** | **Face only** |
| **Runtime** | Browser / edge, WebAssembly, real-time on CPU | Python, TensorFlow/Keras backend, heavier per frame |
| **Where it runs in our stack** | Client-side (already integrated) | Would need **server-side** (FastAPI) — needs raw pixels |
| **Input needed** | Live video stream (in-browser) | Image frames / face crops (pixels must reach the backend) |
| **License/cost** | Apache-2.0, free | MIT, free |

**One-line takeaway:** MediaPipe tells you *how the face/body is shaped and moving*;
DeepFace tells you *who the person is and what category their face falls into*. They overlap
very little — they are complementary, not competing.

---

## 2. Side-by-side by data point

Legend: ✅ native · ⚠️ partial / indirect · ❌ not available

### Emotion & Expression
| Data point | MediaPipe | DeepFace | Notes |
|---|---|---|---|
| Labeled basic emotions | ⚠️ heuristic EMFACS mapping from blendshapes (added — same 7 classes, shown beside DeepFace) | ✅ 7 classes: angry, disgust, fear, happy, sad, surprise, neutral | MediaPipe has no *native* classifier; our mapping is an inference (see `backend/analysis.py:emotion_from_blendshapes`). DeepFace has **no "contempt"** (FER-2013 has 7) |
| Emotion confidence scores | ❌ | ✅ per-class probabilities | DeepFace's headline strength |
| Micro-expressions | ❌ | ❌ | Neither; needs specialized high-FPS detection |
| Facial Action Units (validated FACS) | ⚠️ ARKit-style blendshapes (FACS-*adjacent*, not validated) | ❌ | MediaPipe's 52 blendshapes are the closest either offers |
| Smile intensity | ✅ `mouthSmileLeft/Right` (continuous) | ⚠️ only via "happy" score | MediaPipe is finer-grained here |
| Mouth openness (speaking) | ✅ `jawOpen` | ❌ | MediaPipe only |
| Eyebrow raise / furrow | ✅ `browInnerUp`, `browDown*` | ❌ | MediaPipe only |

### Eye Tracking & Gaze
| Data point | MediaPipe | DeepFace | Notes |
|---|---|---|---|
| Gaze direction | ✅ `eyeLookIn/Out/Up/Down` | ❌ | MediaPipe only — already implemented |
| Eye-contact % with camera | ✅ derived | ❌ | MediaPipe only |
| Blink rate & duration | ✅ `eyeBlinkLeft/Right` | ❌ | MediaPipe only |
| Eye openness | ✅ blendshapes | ❌ | MediaPipe only |
| Pupil dilation | ❌ (needs IR hardware) | ❌ | Neither |

### Head Pose
| Data point | MediaPipe | DeepFace | Notes |
|---|---|---|---|
| Pitch / Yaw / Roll | ✅ transform matrix → Euler | ❌ | MediaPipe only — core of current report |
| Head-movement frequency | ✅ derived from pose over time | ❌ | MediaPipe only |

### Facial Landmarks
| Data point | MediaPipe | DeepFace | Notes |
|---|---|---|---|
| Dense landmarks | ✅ **468** points | ⚠️ only **~5** keypoints (eyes, nose, mouth corners) via RetinaFace/MTCNN | MediaPipe vastly richer |
| Face bounding box | ✅ | ✅ | Both detect the face region |

### Engagement & Attention (derived)
| Data point | MediaPipe | DeepFace | Notes |
|---|---|---|---|
| Attention score (gaze+pose) | ✅ derivable | ❌ | Needs gaze/pose → MediaPipe only |
| Confidence (posture+expression) | ✅ derivable (uses body pose) | ⚠️ emotion half only | MediaPipe has the posture half |
| Nervousness indicators | ✅ blink + look-away + face-touch heuristic | ⚠️ could add "fear/sad" emotion signal | Complementary — DeepFace adds an emotion input |
| Stress markers | ⚠️ heuristic only | ⚠️ emotion-derived proxy | Both speculative from RGB |

### Identity & Integrity (anti-cheating)
| Data point | MediaPipe | DeepFace | Notes |
|---|---|---|---|
| Face presence detection | ✅ | ✅ | Both |
| **Identity verification** (match ID photo) | ❌ no recognition model | ✅ `verify()` / `find()` w/ ArcFace, FaceNet, VGG-Face | **DeepFace's biggest unique win** |
| Multiple-faces detection | ✅ `numFaces > 1` (we set it to 1) | ✅ `extract_faces` returns all | Both — config, not a limit |
| **Liveness / anti-spoofing** | ❌ | ✅ `anti_spoofing=True` (Silent-Face/FasNet) | DeepFace only |

### Demographics (use with caution)
| Data point | MediaPipe | DeepFace | Notes |
|---|---|---|---|
| Age estimation | ❌ | ✅ `analyze(actions=['age'])` | DeepFace only |
| Gender estimation | ❌ | ✅ | DeepFace only — **bias risk, avoid for scoring** |
| Race/ethnicity | ❌ | ✅ | DeepFace only — **high ethics/legal risk, do not use for hiring** |

### Body / Hands / Objects (beyond the face)
| Data point | MediaPipe | DeepFace | Notes |
|---|---|---|---|
| Body posture (upright, shoulder tilt) | ✅ Pose Landmarker | ❌ | MediaPipe only |
| Hand landmarks / gestures | ✅ Gesture Recognizer | ❌ | MediaPipe only |
| Object detection (phone, notes) | ✅ Object Detector | ❌ | MediaPipe only |

---

## 3. Strengths — what each is genuinely best at

**MediaPipe is strong at:**
- Real-time, in-browser, no server, no pixels leaving the client (privacy-friendly)
- **Geometry**: 468 face landmarks, head pose, gaze, blink, 52 blendshapes
- **Whole body**: posture, hands/gestures, objects — DeepFace can't see any of this
- Continuous, fine-grained signals you can threshold and chart over time

**DeepFace is strong at:**
- **Identity** — face verification/recognition against a reference photo (anti-impersonation)
- **Liveness / anti-spoofing** — real person vs photo/video replay
- **Labeled emotion** — named classes with confidence (vs raw blendshapes)
- **Demographic estimates** — age/gender/race (technically; ethically loaded)
- Plug-and-play trained models — no need to train a classifier yourself

---

## 4. Gaps — what each is missing

**MediaPipe cannot do (DeepFace fills):**
- Identity verification · liveness detection · labeled emotion classes · age/gender/race

**DeepFace cannot do (MediaPipe already does):**
- Head pose · gaze · blink/eye-openness · dense landmarks · body posture · hands/gestures ·
  object detection · fine-grained smile/brow/mouth signals

The two gap lists are almost mirror images — which is exactly why a DeepFace track *adds*
rather than *duplicates*.

---

## 5. So what would a DeepFace track actually contribute?

Only the **non-overlapping** column is worth integrating. Realistically that's **three** things:

1. **Labeled emotion timeline** — "looked anxious during Q3," charted beside the existing
   smile/head/posture/gaze panels. (The current report intentionally shows raw blendshapes
   instead; DeepFace would add the *labeled* layer the wish-list asked for.)
2. **Identity verification** — confirm the candidate matches an ID/reference photo.
3. **Liveness / anti-spoofing** — flag a photo/video held to the camera.

Everything else DeepFace offers is either redundant with MediaPipe or demographic
(age/gender/race) and should stay off for hiring use.

### The cost of that contribution (architecture)
All three require **pixels reaching the Python backend** — today the backend only receives
landmark/blendshape JSON, never video. A DeepFace track therefore implies:
- streaming face crops to FastAPI (bandwidth + latency),
- adding the TensorFlow/`deepface` dependency,
- and a **privacy/consent** step (raw face frames leave the client) — note the BIPA / EU AI Act
  cautions already flagged in [`mediapipe-limitations.md`](./mediapipe-limitations.md).

A browser-only alternative exists for **emotion** alone (TF.js / MediaPipe FER), but **identity
and liveness genuinely need DeepFace (or an equivalent recognition stack) server-side.**

---

### Status — live emotion implemented (2026-06-10)

The **labeled-emotion** contribution (#1 above) is now wired into the live **Facial Analysis**
screen: selecting the **DeepFace** engine snapshots a face crop ~every 2s to
`POST /api/emotion/frame` and shows the trained-model emotion **beside** the per-frame MediaPipe
heuristic — so e.g. *fear* (which the heuristic confuses with *surprise*) is actually detected.
It requires the optional `backend/requirements-emotion.txt` install and `EMOTION_ANALYSIS=1`, and
degrades to a clear "off" message otherwise. The post-interview batch track (`POST /api/emotion`)
and the report's emotion chart already existed. Identity verification and liveness (#2, #3)
remain unbuilt.

---

## 6. Bottom line

| Question | Answer |
|---|---|
| Do they overlap? | Barely — face detection + a coarse "happy" signal. ~10% overlap. |
| Should DeepFace replace MediaPipe? | **No.** MediaPipe covers far more (body, gaze, pose, hands). |
| Should DeepFace augment it? | **Yes, for 3 features:** labeled emotion, identity verification, liveness. |
| Main blocker? | DeepFace needs face pixels server-side → bandwidth, dependency, consent. |
| Main risk? | Emotion/demographic accuracy & bias; legal restrictions in hiring. |

---

*Drafted 2026-06-04. MediaPipe column verified against the project's existing
[`mediapipe-limitations.md`](./mediapipe-limitations.md). **DeepFace column compiled from the
`deepface` library's documented API (knowledge cutoff Jan 2026) and should be re-verified
against the current [DeepFace GitHub README](https://github.com/serengil/deepface)** before
any implementation — pin the exact `deepface` version, available detector backends, and the
`anti_spoofing` capability.*
