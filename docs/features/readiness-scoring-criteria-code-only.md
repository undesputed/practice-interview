# Readiness Scoring Criteria — Code-Only (No AI Verdict)

A version of the readiness criteria that uses **no Claude / AI call**. Everything is
computed in Python from numbers we already capture.

This is a **design / criteria document only** — not the implementation. It describes the
rules so they can be built later.

> See [`readiness-scoring-criteria.md`](readiness-scoring-criteria.md) for the current
> (AI-assisted) version. The only difference is the **Content** part and the **written
> feedback**: today Claude scores Content and writes the prose. Here, both are replaced by
> code.

---

## What changes vs. the AI version

| Part | AI version | Code-only version |
|---|---|---|
| Delivery (40%) | Code (voice) | **Same** — no change |
| Presence (35%) | Code (face/body) | **Same** — no change |
| Content (25%) | Claude judges the words | **Heuristics from the transcript** |
| Headline / notes / strengths / improvements / next step | Claude writes prose | **Rule-based templates** |

The overall weights, bands, and "reweight-don't-penalize" rule stay the same:

| Part | Weight |
|---|---|
| Delivery | 40% |
| Presence | 35% |
| Content | 25% |

| Band | Score |
|---|---|
| Ready | ≥ 70 |
| Almost | 50 – 69 |
| Needs work | < 50 |

---

## Honest limit (read this first)

Code cannot understand *meaning*. It cannot tell if an answer is **true**, **insightful**,
or **actually good** — only what its *shape* looks like. So a code-only Content score
measures **form, not substance**:

- It can reward: answering every question, addressing the question's topic, organized
  multi-sentence answers, concrete detail (numbers, examples, names).
- It cannot judge: correctness, depth, originality, whether the example really fits.
- It can be **gamed**: keyword-stuffing the question's words, padding length, sprinkling
  "for example" without a real example.

Because of this, the honest framing is that Content here measures **answer structure and
relevance**, not answer quality. Consider renaming it "Answer Structure" in the UI, or
lowering its weight, so the score is not over-trusted. (See *Open decision* at the end.)

---

## Data available (what the rules can use)

All of this is already produced today — no new capture needed:

- **Transcript segments**: a list of `{speaker: "candidate" | "interviewer", text, t (ms)}`
  ([`analysis.py:questions_from_transcript`](../../backend/analysis.py),
  [`transcript_metrics`](../../backend/analysis.py)).
- **Questions asked**: interviewer turns, in order.
- **Per-answer text**: the candidate segments that follow each question.
- **Timing**: response latency per question, speaking-vs-listening split.
- **Voice prosody** (from Deepgram words): word count, words-per-minute, filler rate,
  pause counts ([`voice.py:measure_prosody`](../../backend/voice.py)).

---

## Content score (0–100) — code-only

Content = the weighted blend of four sub-scores, each 0–1, then ×100.

| Sub-score | Weight | Measures | How it is computed (proxy) |
|---|---|---|---|
| **Coverage** | 30% | Did they actually answer each question, with substance? | Share of questions that got a real answer (see Coverage rules) |
| **Relevance** | 30% | Did the answer address the question's topic? | Overlap between the question's key words and the answer's words |
| **Structure** | 20% | Was the answer organized? | Discourse markers + multi-sentence + healthy length |
| **Specificity** | 20% | Concrete detail vs. vague? | Rate of numbers, examples, and proper nouns |

Filler rate, pace, and pauses are **not** counted here — they already live in **Delivery**,
and double-counting would punish the same thing twice.

### Coverage (30%)

Per question, classify the candidate's answer:

| Answer | Credit |
|---|---|
| ≥ 30 words | 1.0 (full answer) |
| 15 – 29 words | 0.6 (thin answer) |
| 1 – 14 words | 0.3 (one-liner) |
| no candidate response | 0.0 (skipped) |

`Coverage = average credit across all questions asked.`

Rationale: rewards answering everything with enough to say; an interview where half the
questions get one-word replies should not read as "ready."

### Relevance (30%)

For each question + its answer:

1. Lowercase and tokenize both. Drop a **stopword** list (the, a, is, and, I, you, …).
2. Take the question's remaining **content words** (the topic words).
3. `relevance_q = (content words from the question that also appear in the answer) ÷ (content words in the question)`, capped at 1.0.

`Relevance = average relevance_q across questions.`

Rationale: a real answer reuses the question's subject words ("Tell me about a *conflict* on
your *team*" → a relevant answer says "conflict", "team"). Rough, but it catches
off-topic or evasive answers. **Limitation:** it rewards word overlap, not meaning — it
can be gamed by repeating the question.

### Structure (20%)

Per answer, score three signals (average them), then average across answers:

- **Signposting** — contains ≥ 1 discourse marker from a set like
  `{first, second, then, next, finally, because, so, therefore, for example, such as,
  however, although, overall, in summary, my role, the result}` → 1.0 else 0.0.
- **Multi-sentence** — ≥ 2 sentences (count terminal punctuation `.?!`) → 1.0; 1 sentence → 0.5; none → 0.0.
- **Healthy length** — word count in 30–200 → 1.0; falls off to 0 below 10 or above ~350 (rambling).

Rationale: organized answers tend to use connective words, run more than one sentence, and
sit in a sensible length band (not a fragment, not a monologue).

### Specificity (20%)

Per answer, count concrete tokens and turn the rate into a 0–1 score:

- **Numbers** — any digit token (`20%`, `3`, `2024`).
- **Example markers** — `for example`, `such as`, `e.g.`, `for instance`.
- **Proper nouns** — a rough proxy: capitalized words that are not the first word of a
  sentence (tools, companies, names: "Python", "Google", "Jira").

`specificity_rate = concrete tokens ÷ total words`, then map: `0 → 0.0`, `≥ ~0.06 → 1.0`
(linear in between). Average across answers.

Rationale: concrete answers name things and cite numbers; vague answers don't.
**Limitation:** it cannot tell whether the number or name is *relevant* — only that it's
present.

---

## Written feedback — code-only (templates)

No model writes prose, so the report text comes from rules driven by the sub-scores.

Treat every component on a 0–100 scale: **Delivery**, **Presence**, **Content**, and the
named pieces inside them (pace, fillers, pauses, attention, confidence, composure, calm,
coverage, relevance, structure, specificity).

- **Headline** — chosen by band:
  - Ready → "You're interview-ready — strong, steady delivery."
  - Almost → "Almost there — a few tweaks will get you ready."
  - Needs work → "Good practice run — here's where to focus next."
- **Per-part notes** — one templated line each that states the score and names the weakest
  sub-term, e.g. *"Delivery 72/100 — pace and pauses are good; watch filler words."*
- **Strengths (2–3)** — the highest-scoring components above a **good threshold (≥ 75)**,
  each mapped to a canned phrase from a lookup table (component → praise line).
- **Improvements (2–3)** — the lowest-scoring components below a **weak threshold (< 60)**,
  each mapped to a canned tip (component → advice line).
- **Next action** — the single lowest component's tip, surfaced as the one thing to fix
  first.

This needs two small lookup tables (a praise line and a tip line per component). It is
deterministic and free, but the wording is fixed — it will not adapt to the specific answer
the way a model does.

---

## Graceful degradation (unchanged)

- No transcript / no answers → Content is `None`; readiness is reweighted across Delivery +
  Presence only.
- No mic → Delivery `None`; reweight across Presence + Content.
- No camera → Presence `None`; reweight across Delivery + Content.
- All missing → no score.

---

## Trade-offs vs. the AI version

| | Code-only | AI (Claude) |
|---|---|---|
| Cost | Free | Per-interview API cost |
| Needs `ANTHROPIC_API_KEY` | No | Yes |
| Speed | Instant | One API round-trip |
| Deterministic / testable | Yes — same input, same score | No — wording varies |
| Judges meaning / correctness | **No** (form only, gameable) | Yes (clarity, depth, relevance) |
| Feedback wording | Fixed templates | Tailored to the answer |

A reasonable middle path: **always compute the code-only Content score** (so a number
always exists, even offline), and use Claude **only for the written prose** when a key is
present. That keeps the number deterministic and free while still giving tailored wording
when available.

---

## Open decision

The code-only Content score measures structure and relevance, not true answer quality, and
it is gameable. Before shipping it, decide one of:

1. **Keep Content at 25%** but rename it "Answer Structure" in the UI (honest about what it
   measures).
2. **Lower Content's weight** (e.g. 15%) and raise Delivery/Presence, since those code
   signals are more trustworthy.
3. **Hybrid** — code-only number always; Claude prose when a key is available.

This choice is not yet made.
