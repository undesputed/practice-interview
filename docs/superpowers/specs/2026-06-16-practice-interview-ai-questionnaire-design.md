# Practice Interview — AI Question Generator — Design

- **Date:** 2026-06-16
- **Status:** Approved (design); pending implementation plan
- **Topic:** On the Practice Interview page, let the user generate (and regenerate) an AI-written set of interview questions tailored to the chosen role, focus, and difficulty. The generated set drives the live interview, giving variety instead of the interviewer improvising similar questions each time.

## 1. Problem & Context

The live interview is conducted by the Deepgram Voice Agent with Claude (the `think` provider) improvising questions from a system prompt shaped by role/focus/difficulty/count ([backend/deepgram.py](../../../backend/deepgram.py) `build_interviewer_prompt`). Because the prompt is the same each session, the questions tend to repeat and the user has no preview or control over them.

The Practice Interview page ([frontend/screens/new.js](../../../frontend/screens/new.js)) has a "Tune the set" section (Focus / Difficulty / Questions count). The choices flow `new.js → interview-config.js → live.js → POST /api/interview/token → build_agent_config → build_interviewer_prompt`.

## 2. Goals

1. Generate a list of interview questions with AI, tailored to the selected **role + focus + difficulty**, with a count matching the Questions stepper.
2. A **Regenerate** button for a fresh, different set (variety, not repetition).
3. The generated set **drives the live interview** — the interviewer asks these questions, in order.
4. Show it **inline** on the Practice Interview page, below "Tune the set" (not a separate page).

## 3. Non-Goals

- No per-question editing — only whole-set regenerate (can be added later).
- No saving/library of question sets (the Role & question library screen is separate, out of scope).
- No change to scoring or the report.

## 4. Decisions (locked during brainstorming)

| # | Decision | Choice |
|---|----------|--------|
| 1 | Do generated questions drive the interview? | **Yes — they become the questionnaire the interviewer asks** |
| 2 | Placement | **Inline on the Practice Interview page**, below "Tune the set" |
| 3 | Generation trigger | **Button-driven** ("Generate questions" → "Regenerate"), not auto on every settings change |
| 4 | Editing | **Whole-set regenerate only** (no per-question edit) |
| 5 | Start without generating | **Falls back to the current improvise behavior** (nothing breaks) |
| 6 | Staleness | If role/focus/difficulty/count change after generating, **clear the list** + hint to (re)generate, so it never mismatches the settings |

## 5. Components & Data Flow

```
[Practice Interview page]
  new.js "Your questions" section: [Generate questions] button + numbered list
    → api.generateQuestions({role, focus, difficulty, question_count})
        → POST /api/questions → backend questions.generate_questions() (Claude) → ["Q1", "Q2", ...]
    → list rendered; button becomes "Regenerate"
  On Start: saveSettings() stores {role, focus, difficulty, questionCount, questions[]} via setInterviewConfig

[Live interview]
  live.js getInterviewConfig() → api.interviewToken({role, focus, difficulty, question_count, questions})
    → POST /api/interview/token → build_agent_config(..., questions)
        → build_interviewer_prompt(..., questions): if questions given, instruct "ask these exact
          questions, in order"; build_greeting adapts; if none, current improvise behavior.
```

## 6. Backend

- **`backend/questions.py` (new):**
  - `generate_questions(api_key, role, focus, difficulty, n) -> list[str]` — one Claude call (reusing the Anthropic SDK like `anthropic_coach.py`), temperature ~0.9 for variety, shaped by the same FOCUS_GUIDANCE / DIFFICULTY_GUIDANCE semantics used for the interviewer. Returns up to `n` concise questions.
  - `parse_questions(raw) -> list[str]` — tolerant JSON-array parse (code-fence safe), like `parse_coaching`. Returns `[]` on failure.
- **`backend/main.py`:**
  - `POST /api/questions` — body `{role, focus, difficulty, question_count}`; returns `{"questions": [...]}`. Graceful: no `ANTHROPIC_API_KEY` or a failure → `{"questions": []}` (the UI shows "couldn't generate; you can still start").
  - `TokenRequest` gains `questions: list[str] = []`; passed into `build_agent_config`.
- **`backend/deepgram.py`:**
  - `build_agent_config(role, focus, difficulty, question_count, questions=None)` threads `questions` to the prompt and greeting.
  - `build_interviewer_prompt(role, focus, difficulty, question_count, questions=None)`:
    - **Bound mode** (questions given): "Ask these specific questions, in order, one at a time: 1) … 2) …. Ask each once (you may add a brief natural follow-up), never add new questions or restart, then thank the candidate and call `end_interview`." (The explicit list also makes looping far less likely.)
    - **Improvise mode** (no questions): current behavior, including the "interview already in progress, the self-introduction is question 1" framing.
  - `build_greeting(role, has_questions=False)`: in bound mode the greeting is neutral ("Hi, thanks for joining — let's get started.") so it doesn't conflict with the first listed question; in improvise mode it keeps asking for the self-introduction (which is question 1).

## 7. Frontend

- **`frontend/api.js`** — `generateQuestions({role, focus, difficulty, question_count})` → POST `/api/questions`; never throws (resolves `{questions: []}` on error).
- **`frontend/interview-config.js`** — add `questions: []` to DEFAULTS and the stored config.
- **`frontend/screens/new.js`** — new "Your questions" `ni-set` block below "Tune the set":
  - A **Generate questions** button (→ "Regenerate" after first generation) with a loading state.
  - A numbered list of the returned questions (escaped). Empty state: "Generate a set tailored to your role, focus, and difficulty — or start without and the interviewer will improvise."
  - Module state holds the current `questions[]`. Changing role/focus/difficulty/count clears it (and resets the button to "Generate questions") so it never mismatches.
  - `saveSettings()` includes `questions` in `setInterviewConfig`.
- **`frontend/screens/live.js`** — pass `questions: cfg.questions` in the `api.interviewToken(...)` call.
- **`frontend/styles/clean-studio.css`** — styles for the question list + button + loading/empty states.

## 8. Error Handling & Edge Cases

- **No Anthropic key / generation fails** → `{questions: []}`; the UI shows a brief "couldn't generate — you can still start (the interviewer will improvise)." Start is never blocked.
- **Fewer/more questions than requested** → use what's returned; the interview asks what's in the list.
- **Start without generating** → `questions` empty → improvise mode (current behavior).
- **Stale list** → cleared on any role/focus/difficulty/count change.
- **Loading** → the Generate/Regenerate button shows a working state and is disabled during the request.

## 9. Testing

- Backend (pytest): `parse_questions` handles a JSON array + bad input; `/api/questions` returns `{questions:[...]}` with the Claude call monkeypatched, and `{questions:[]}` with no key; `build_interviewer_prompt(..., questions=[...])` includes the listed questions and the "ask these in order" instruction; `build_greeting(role, has_questions=True)` does not ask for the self-introduction.
- Frontend: no JS test runner — manual browser verification (generate, regenerate, clear-on-change, start with and without a set; confirm the live interviewer asks the generated questions).

## 10. References

- Current: [new.js](../../../frontend/screens/new.js), [interview-config.js](../../../frontend/interview-config.js), [live.js](../../../frontend/screens/live.js), [deepgram.py](../../../backend/deepgram.py), [anthropic_coach.py](../../../backend/anthropic_coach.py) (Claude client pattern), [main.py](../../../backend/main.py).
