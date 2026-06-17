# Readiness Scoring Criteria

How a finished practice interview is judged. This is **practice / self-improvement
feedback — never a hiring decision.** The number is a readiness signal, not a verdict on
the person.

The score comes from three parts fused into one **Readiness** number. The numeric rubric
is authoritative; the Claude call only writes the explanation prose and the Content score.

The result page surfaces this as a **"How you're scored"** card
([`frontend/screens/report.js`](../../frontend/screens/report.js) `scoringBreakdown`): each
pillar shows its weight and score, and drills into every sub-criterion below with a
Good / OK / Low rating and the target it is judged against.

| Source file | What it owns |
|---|---|
| [`backend/verdict.py`](../../backend/verdict.py) | The fused readiness score, the band, the weights |
| [`backend/voice.py`](../../backend/voice.py) | The Delivery (voice) score |
| [`backend/analysis.py`](../../backend/analysis.py) | The Presence composites (face/body) |
| [`backend/anthropic_coach.py`](../../backend/anthropic_coach.py) | The Content score + all written feedback |

---

## Overall verdict

Readiness score (0–100) is a weighted blend of three sub-scores:

| Part | Weight | Measures |
|---|---|---|
| **Delivery** | **40%** | How they sounded (voice) |
| **Presence** | **35%** | How they looked on camera (face + body) |
| **Content** | **25%** | What they actually said (answers) |

**Bands:**

| Band | Score |
|---|---|
| Ready | ≥ 70 |
| Almost | 50 – 69 |
| Needs work | < 50 |

**Missing signals are reweighted, never penalized.** If a part is absent (e.g. no
microphone, so no Delivery), its weight is dropped and the remaining weights are
renormalized to sum to 1.0. A partial result is a fair blend of what was captured.

---

## 1. Delivery — 40% (voice)

Five terms, each scored 0–1 against absolute target bands, then weighted. Pace, fillers,
and pauses come from Deepgram word timings (exact, unaffected by mic auto-gain). Pitch and
energy come from the browser audio analysis.

| Term | Weight | "Good" band (full score) | Drops to zero at |
|---|---|---|---|
| **Pace** (words per minute) | 30% | 110 – 160 wpm | < 60 or > 220 |
| **Fillers** (um/uh per 100 words) | 25% | ≤ 3 | ≥ 15 |
| **Long pauses** (gaps ≥ 1.5s, count) | 15% | ≤ 2 | ≥ 10 |
| **Pitch variation** (std dev, Hz) | 20% | ≥ 25 (varied, not monotone) | ≤ 5 |
| **Energy** (loudness) | 10% | ≥ 0.02 | ≤ 0.002 |

Notes:
- A **pause** is any gap ≥ 300 ms between words; a **long pause** is ≥ 1.5 s.
- Pace scores full inside the band and falls off linearly on either side (too slow OR too
  fast both lose points).
- Fillers and long pauses only penalize when high (a calm, filler-free delivery scores full).
- Pitch and energy only penalize when low (monotone / too quiet); they reward variation
  and presence.
- **Energy is weighted lowest (10%)** because microphone auto-gain and noise suppression
  make absolute loudness the least trustworthy signal.
- If the browser cannot produce pitch/energy features, those two terms are dropped and the
  remaining three (pace, fillers, pauses) are renormalized.

---

## 2. Presence — 35% (face / body)

Presence is the **average of four 0–100 indicators**, derived mostly from MediaPipe
geometric signals (gaze direction, head pose, posture, blink rate, hand position) — plus
one low-weight facial-tension exception (see below):

| Indicator | How it is built |
|---|---|
| **Attention** | 0.5 × eye contact + 0.3 × head steadiness + 0.2 × face-on-screen |
| **Confidence** | 0.5 × upright posture + 0.5 × body steadiness |
| **Composure** | average of head steadiness + body steadiness |
| **Calm** (= 100 − Nervousness) | Nervousness = 0.25 × blink rate + 0.25 × (low eye contact) + 0.2 × face-touching + 0.15 × hand fidgeting + 0.15 × facial tension |

So `Presence = mean(Attention, Confidence, Composure, 100 − Nervousness)`.

These composites are heuristic and supplementary. Presence is built almost entirely from
**geometric** signals (gaze, head/body steadiness, posture, blink, hands). The one
exception is **facial tension** — a FACS-derived signal (brow lower + lid tighten + lip
press) that is 15% of the Nervousness term, so it reaches the score through Calm at roughly
1.3% of the total. The **emotion-classification** track (happy, sad, contempt, etc.) is a
different thing: it is shown on the report for insight but is **never** part of the score.

---

## 3. Content — 25% (answers)

Claude reads the transcript and scores **Content (0–100)** on four things:

- **Clarity** — is the answer easy to follow?
- **Structure** — is it organized (e.g. a clear beginning, point, and close)?
- **Specificity** — concrete examples and detail vs. vague generalities?
- **Relevance** — does it actually answer the question for this role?

Claude is given the already-computed Delivery and Presence numbers as context, but it
**only judges the words** — it does not re-score voice or presence. Alongside the Content
number, Claude writes the human-facing feedback:

- a warm one-sentence **headline**,
- one-line **delivery / presence / content notes**,
- 2–3 **strengths**,
- 2–3 **improvements**,
- one concrete **next action**.

The rubric owns the readiness number and band; Claude owns the Content score and the prose.

---

## Honesty caveats

- **Practice, not hiring.** The framing is self-improvement. The score must never be used
  as a hiring decision.
- **Presence is geometric, plus one low-weight FACS term.** Emotion *classification* (the
  MediaPipe + FACS track, including Contempt and compound emotions) is supplementary,
  accuracy/bias-prone, and excluded from scoring. The only FACS signal that touches the
  score is **facial tension** (brow lower / lid tighten / lip press), weighted at 15% of
  Nervousness — a deliberate ~1.3% nudge, not a driver. See
  [`mediapipe-limitations.md`](mediapipe-limitations.md).
- **Voice bands are absolute and untuned to this mic.** The pitch/energy bands were ported,
  not calibrated to this app's microphone (which runs auto-gain + noise suppression). Energy
  is the least reliable term and is weighted accordingly.
- **Graceful degradation.** Any missing signal (no mic, no camera, transcription failed)
  drops out and the remaining weights are renormalized — the result reflects what was
  captured, not a penalty for what was not.
