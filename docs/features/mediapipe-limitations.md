# Features We Cannot Implement via MediaPipe

This project's facial/body analysis is built on **MediaPipe Tasks for Web** (Face Landmarker,
Pose Landmarker, Gesture Recognizer). MediaPipe provides geometric **signals** — landmarks,
blendshape coefficients, and a head transformation matrix — **not** trained classifiers for
identity, emotion, or demographics.

The items below appear on common "AI interview data point" wish-lists (see
`docs/features/data points`) but are **out of scope / not honestly producible** with this
stack. They are intentionally **omitted** from the review page rather than faked.

> Legal note: emotion recognition and biometric identification in hiring are restricted in some
> jurisdictions (e.g., Illinois BIPA, the EU AI Act). Even where technically possible, several
> of these should not be used for candidate scoring.

## Emotion & Expression
| Wanted | Why not | What we do instead |
|--------|---------|--------------------|
| Labeled basic emotions (happy/sad/angry/surprised/fearful/disgusted/neutral/contempt) | MediaPipe outputs blendshape *coefficients*, not a trained emotion classifier. Emotion-from-face is accuracy- and bias-prone and legally restricted in hiring. | Show raw expression signals: smile intensity, eyebrow raise, mouth/eye openness. |
| Emotion confidence scores | No emotion classifier → no class probabilities. | — |
| Micro-expressions | Require specialized high-FPS detection; not provided. | — |
| Facial Action Units (validated FACS) | Blendshapes are ARKit-style coefficients — related to AUs but not validated FACS. | Surface the blendshape signals directly. |

## Eye Tracking & Gaze
| Wanted | Why not | What we do instead |
|--------|---------|--------------------|
| Pupil dilation | Needs high-resolution / IR eye-tracking hardware; not derivable from an RGB webcam. | — |

(Gaze direction, eye-contact %, blink rate, and eye openness **are** implemented.)

## Identity & Integrity (anti-cheating)
| Wanted | Why not | What we do instead |
|--------|---------|--------------------|
| Identity verification (match to an ID photo) | Requires face recognition / embeddings + a matcher — not a MediaPipe Tasks capability (e.g., persolhr used AWS Rekognition). | — |
| Liveness detection (real person vs photo/video) | No MediaPipe liveness model; needs a dedicated anti-spoofing system. | — |
| Multiple-faces detection | Our pipeline runs single-face (`numFaces: 1`) by design. (MediaPipe *can* detect multiple faces, but multi-person handling is not implemented here.) | Face-presence detection (is a face there at all). |

## Demographics
| Wanted | Why not |
|--------|---------|
| Age estimation | Not a MediaPipe Tasks capability. |
| Gender estimation | Not a MediaPipe Tasks capability; also advised against for scoring (bias). |

## Derived / Speculative
| Wanted | Why not | What we do instead |
|--------|---------|--------------------|
| Stress markers | No reliable physiological signal from an RGB webcam; speculative. | A heuristic "Nervousness" indicator from blink rate + looking-away + face-touch + fidget, clearly labeled supplementary. |
| Lip biting / specific nervous habits | No dedicated detector. | Face-touch proximity (hand near face) as a proxy. |
| Authenticity indicator | Not reliably measurable. | — |

---

**Principle:** facial/body data is used as *supplementary* signals, shown transparently, and
never presented as objective emotion/identity ground truth.
