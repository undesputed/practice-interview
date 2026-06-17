# New Interview "Tone" Control — Design

**Date:** 2026-06-17
**Status:** Approved — ready for implementation planning

## Summary

Add a **Tone** control to the New Interview setup screen. It is a separate axis from the
existing **Difficulty** control: Difficulty governs question hardness and follow-up pressure;
Tone governs the interviewer's **manner** (via the Claude system prompt) and the **spoken
voice** (via the Deepgram TTS model). Four options — **Friendly / Professional / Stern /
Intimidating**, default **Professional**. The two controls stack, so combinations like
"Hard + Friendly" or "Warm-up + Intimidating" are possible.

## Motivation

Difficulty already controls how tough the questions are, but not *how the interviewer comes
across*. A separate Tone axis lets a candidate practice against different interviewer
demeanors (and hear a matching voice) without changing the question difficulty.

## Decisions (locked during brainstorming)

| Decision | Choice |
|---|---|
| Relationship to Difficulty | **Separate but combine** — two controls that stack. |
| Options | **Friendly / Professional / Stern / Intimidating** (4 segmented buttons). |
| Default | **Professional** (preserves current behavior + current voice). |
| What Tone changes | Interviewer **manner** (system prompt) **and** **spoken voice** (TTS). |
| Interviewer name | **Drop the fixed name "Judy"** so any voice (incl. baritone) fits the persona. |

## Touch points (end to end)

| Layer | File | Change |
|---|---|---|
| Form | `frontend/screens/new.js` | Add `data-group="tone"` 4-button group; read in `currentSettings()` + `saveSettings()`. |
| Store | `frontend/interview-config.js` | Add `tone: 'Professional'` to `DEFAULTS`; pass through `setInterviewConfig`. |
| Request | `frontend/screens/live.js` | Add `tone: cfg.tone` to the `api.interviewToken({...})` payload in `startAgent()`. |
| API wrapper | `frontend/api.js` | No change (generic passthrough). |
| Request model | `backend/main.py` | Add `tone: str = "Professional"` to `TokenRequest`; pass `tone=req.tone` to `build_agent_config(...)`. |
| Prompt + voice | `backend/deepgram.py` | Add `TONE_GUIDANCE` + `TONE_VOICE`; thread a `tone` param through `build_interviewer_prompt` and `build_agent_config`; drop "Judy". |

## Design detail

### Frontend: the Tone control (`new.js`)

Add a segmented button group matching the existing Focus/Difficulty pattern (`data-group`,
`.on` for the selected button):

```
Tone:  [ Friendly ] [ Professional ] [ Stern ] [ Intimidating ]
                          ^ default .on
```

Read it the same way the others are read (the explorer found `currentSettings()` and
`saveSettings()` already pull `focus`/`difficulty` from `[data-group="..."] button.on`).
Add `tone` to both, defaulting to `'Professional'`.

### Frontend config + request

- `interview-config.js`: `DEFAULTS` gains `tone: 'Professional'`; `setInterviewConfig` /
  `getInterviewConfig` already pass arbitrary fields, so `tone` flows through.
- `live.js` `startAgent()`: add `tone: cfg.tone` to the `interviewToken(...)` payload.
- `api.js`: unchanged.

### Backend request model (`main.py`)

Add to `TokenRequest`:
```python
tone: str = "Professional"
```
Update the call (currently positional at `backend/main.py:97`) to pass tone **by keyword** so
argument order can't drift:
```python
"config": build_agent_config(req.role, req.focus, req.difficulty,
                             req.question_count, req.questions, tone=req.tone)
```

### Backend manner (`deepgram.py`)

Add a `TONE_GUIDANCE` dict (same shape as `FOCUS_GUIDANCE`/`DIFFICULTY_GUIDANCE`):

```python
# How the "Tone" choice shapes the interviewer's manner (not the question hardness —
# that is Difficulty's job). Spoken delivery is set separately via TONE_VOICE.
TONE_GUIDANCE = {
    "Friendly": "Adopt a warm, encouraging manner: put the candidate at ease, react "
                "supportively, and acknowledge good answers.",
    "Professional": "Adopt a calm, balanced, professional manner — warm but not effusive.",
    "Stern": "Adopt a cool, no-nonsense manner: minimal warmth, brief acknowledgements, "
             "and steady pressure.",
    "Intimidating": "Adopt a tough, high-pressure manner: be curt and demanding and "
                    "challenge answers directly — but never personal, rude, or demeaning.",
}
```

The **Professional** wording intentionally preserves today's "warm but professional"
default so behavior is unchanged when nobody picks a tone.

In `build_interviewer_prompt`, look up `tone_line = TONE_GUIDANCE.get(tone, TONE_GUIDANCE["Professional"])`
and inject it into the intro alongside `focus_line` and `difficulty_line`. Replace the
current hard-coded persona:

- **From:** `"You are Judy, a warm but professional interviewer conducting a mock job interview for a {role} position. {focus_line} {difficulty_line} "`
- **To:** `"You are an interviewer conducting a mock job interview for a {role} position. {focus_line} {difficulty_line} {tone_line} "`

### Backend voice (`deepgram.py`)

Add a verified Aura-2 mapping and use it instead of the hard-coded `TTS_MODEL`:

```python
# Tone -> Deepgram Aura-2 voice (verified IDs). Falls back to TTS_MODEL.
TONE_VOICE = {
    "Friendly": "aura-2-helena-en",       # Caring, Natural, Friendly
    "Professional": "aura-2-thalia-en",   # current default voice (unchanged)
    "Stern": "aura-2-saturn-en",          # Knowledgeable, Confident, Baritone
    "Intimidating": "aura-2-zeus-en",     # Deep, Trustworthy, Smooth
}
```

In `build_agent_config`, set the speak model to `TONE_VOICE.get(tone, TTS_MODEL)` instead of
the bare `TTS_MODEL`. `TTS_MODEL` stays as the fallback constant.

### Drop the "Judy" name

Three references; all become name-free:
- `build_interviewer_prompt` intro (line 35) — replaced above.
- `build_greeting` bound-mode greeting (line 71): change `"Hi, thanks for joining. I'm Judy, and I'll be interviewing you for the {role} role today. Let's get started."` to `"Hi, thanks for joining. I'll be interviewing you for the {role} role today. Let's get started."`
- `backend/.env` line 3 comment mentions "Judy" — update the comment to not name her (cosmetic, keep docs honest).

Greeting wording stays the same across tones (only the voice changes) — YAGNI; the manner
shows in the interview body.

### Signatures (avoid the positional-arg trap)

Add `tone` as the **last** parameter of both functions, so existing positional callers and
the existing tests keep working:

```python
def build_interviewer_prompt(role, focus="Mixed", difficulty="Realistic",
                             question_count=5, questions=None, tone="Professional") -> str: ...

def build_agent_config(role, focus="Mixed", difficulty="Realistic",
                       question_count=5, questions=None, tone="Professional") -> dict: ...
```

`build_agent_config` passes `tone` into `build_interviewer_prompt(...)` and into the
`TONE_VOICE` lookup.

### Fallback & errors

- Missing `tone` field → Pydantic default `"Professional"`.
- Unknown tone string → `TONE_GUIDANCE.get(tone, ...Professional)` and
  `TONE_VOICE.get(tone, TTS_MODEL)` both fall back safely; no exception.

## Tests (backend, follow `tests/test_deepgram.py` style)

New cases in `tests/test_deepgram.py`:
1. Each tone injects its manner line — e.g. `build_agent_config("SWE", tone="Intimidating")`
   prompt contains "high-pressure" (and "Friendly" → "encouraging", etc.).
2. Each tone selects its voice — `cfg["agent"]["speak"]["provider"]["model"]` equals the
   mapped Aura-2 id (Friendly→helena, Professional→thalia, Stern→saturn, Intimidating→zeus).
3. Unknown tone falls back to Professional manner + `aura-2-thalia-en`.
4. Default (no tone arg) keeps `aura-2-thalia-en` and professional manner — i.e. the
   existing `startswith("aura-2")` assertion and current behavior still hold.
5. The prompt no longer contains "Judy".

Frontend has no test harness → the new control is verified manually.

## Docs to update

- `docs/superpowers/specs/2026-06-15-live-interview-voice-agent-design.md` — add the Tone
  control, the tone→manner mapping, and the tone→voice mapping; note the persona is no
  longer named.
- Any New-Interview setup-screen doc that lists the existing controls (Role/Focus/
  Difficulty/Questions) — add Tone. (Confirm during planning whether such a doc exists.)

## Acceptance criteria

1. The setup screen shows a 4-option Tone control (default Professional) that threads through
   to `POST /api/interview/token` as a `tone` field.
2. `build_interviewer_prompt` injects the correct manner line per tone and contains no
   "Judy".
3. `build_agent_config` returns the correct Aura-2 voice per tone, falling back to
   `aura-2-thalia-en` for unknown/missing tone.
4. Default behavior (no tone chosen) is unchanged: professional manner + thalia voice.
5. All existing `tests/test_deepgram.py` tests still pass; new tone tests pass.
6. The voice-agent spec doc reflects the new control.

## Out of scope

- Per-tone greeting wording or per-tone question changes (Difficulty owns hardness).
- Frontend automated tests (no harness exists).
- Adding new voices beyond the four mapped Aura-2 ids.
