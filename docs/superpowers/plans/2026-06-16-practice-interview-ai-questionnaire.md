# Practice Interview — AI Question Generator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On the Practice Interview page, generate (and regenerate) an AI-written, role/focus/difficulty-tailored question set inline below "Tune the set", and make that set drive the live interview (the interviewer asks the listed questions in order), falling back to improvise when none are generated.

**Architecture:** A new `backend/questions.py` calls Claude for a JSON array of questions; a `POST /api/questions` endpoint exposes it. The chosen set threads `new.js → interview-config → live.js → POST /api/interview/token → build_agent_config → build_interviewer_prompt`, which gains a "bound mode" (ask these exact questions) alongside the existing "improvise mode".

**Tech Stack:** FastAPI + Anthropic SDK + pytest (backend), vanilla ES modules (frontend, no JS test runner).

Spec: [docs/superpowers/specs/2026-06-16-practice-interview-ai-questionnaire-design.md](2026-06-16-practice-interview-ai-questionnaire-design.md)

---

## File Structure

- **Create** `backend/questions.py` — `generate_questions()` (Claude call) + `parse_questions()`.
- **Modify** `backend/deepgram.py` — `build_interviewer_prompt` / `build_greeting` / `build_agent_config` accept an optional `questions` list (bound vs improvise mode).
- **Modify** `backend/main.py` — `POST /api/questions`; `TokenRequest.questions`; pass questions to `build_agent_config`.
- **Create** `tests/test_questions.py` — parse, prompt-with-questions, greeting, endpoint, config-binding tests.
- **Modify** `frontend/api.js` — `generateQuestions()`.
- **Modify** `frontend/interview-config.js` — `questions: []` field.
- **Modify** `frontend/screens/new.js` — "Your questions" section (generate/regenerate, clear-on-change) + include questions in `saveSettings`.
- **Modify** `frontend/screens/live.js` — pass `questions` in the `interviewToken` call.
- **Modify** `frontend/styles/clean-studio.css` — question-list + section styles.

---

## Task 1: Backend question generator (`questions.py`, TDD)

**Files:**
- Create: `backend/questions.py`
- Test: `tests/test_questions.py`

- [ ] **Step 1: Write the failing parse tests**

Create `tests/test_questions.py` with:
```python
# tests/test_questions.py
"""Tests for AI question generation + binding it into the interview."""
import backend.main as main
from backend.main import app
from backend import questions
from backend.deepgram import build_interviewer_prompt, build_greeting, build_agent_config
from fastapi.testclient import TestClient

client = TestClient(app)


def test_parse_questions_array():
    assert questions.parse_questions('["a","b","c"]') == ["a", "b", "c"]
    assert questions.parse_questions('```json\n["x", "y"]\n```') == ["x", "y"]


def test_parse_questions_bad_input():
    assert questions.parse_questions("not json") == []
    assert questions.parse_questions('{"a":1}') == []
    assert questions.parse_questions('["", "  ", "ok"]') == ["ok"]   # blanks dropped
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd /Users/carrieyu/Desktop/Hipe/mediapipe-test && python -m pytest tests/test_questions.py -q`
Expected: FAIL (`No module named 'backend.questions'`).

- [ ] **Step 3: Implement `backend/questions.py`**

```python
# backend/questions.py
"""Generate a tailored set of interview questions with Claude for the Practice
Interview page. The chosen set drives the live interview (see deepgram.py)."""
import json
import re

from anthropic import Anthropic

from backend.deepgram import FOCUS_GUIDANCE, DIFFICULTY_GUIDANCE, THINK_MODEL

SYSTEM_PROMPT = (
    "You write interview questions for a mock job interview. Given a role, a focus, and a "
    "difficulty, return ONLY a JSON array of concise interview questions (strings) tailored to "
    "them — no preamble, no numbering, no markdown, just the JSON array."
)


def parse_questions(raw: str) -> list:
    """Extract a JSON array of question strings from the model response, tolerating fences."""
    text = raw.strip()
    fenced = re.search(r"```(?:json)?\s*(\[.*\])\s*```", text, re.DOTALL)
    if fenced:
        text = fenced.group(1)
    else:
        bracket = re.search(r"\[.*\]", text, re.DOTALL)
        if bracket:
            text = bracket.group(0)
    try:
        data = json.loads(text)
    except (ValueError, TypeError):
        return []
    if not isinstance(data, list):
        return []
    return [str(q).strip() for q in data if str(q).strip()]


def generate_questions(api_key: str, role: str, focus: str, difficulty: str, n: int) -> list:
    """One Claude call returning up to `n` interview questions for the settings."""
    n = max(1, int(n))
    focus_line = FOCUS_GUIDANCE.get(focus, FOCUS_GUIDANCE["Mixed"])
    difficulty_line = DIFFICULTY_GUIDANCE.get(difficulty, DIFFICULTY_GUIDANCE["Realistic"])
    client = Anthropic(api_key=api_key)
    resp = client.messages.create(
        model=THINK_MODEL,
        max_tokens=1024,
        temperature=0.9,   # variety across regenerations
        system=SYSTEM_PROMPT,
        messages=[{"role": "user", "content": (
            f"Role: {role}\nFocus: {focus} — {focus_line}\n"
            f"Difficulty: {difficulty} — {difficulty_line}\n"
            f"Write exactly {n} interview questions for this candidate as a JSON array of strings."
        )}],
    )
    return parse_questions(resp.content[0].text)[:n]
```

- [ ] **Step 4: Run the parse tests**

Run: `cd /Users/carrieyu/Desktop/Hipe/mediapipe-test && python -m pytest tests/test_questions.py::test_parse_questions_array tests/test_questions.py::test_parse_questions_bad_input -q`
Expected: 2 passed. (The other tests in the file fail until Tasks 2–3 — that's expected; don't run the whole file yet.)

- [ ] **Step 5: Commit**

```bash
git add backend/questions.py tests/test_questions.py
git commit -m "feat(questions): Claude question generator + parser"
```

---

## Task 2: Bind questions into the interview prompt (`deepgram.py`, TDD)

**Files:**
- Modify: `backend/deepgram.py`
- Test: `tests/test_questions.py` (the prompt/greeting/config tests added in Task 1 run now)

- [ ] **Step 1: Append the binding tests to `tests/test_questions.py`**

Append:
```python
def test_prompt_with_questions_lists_them_in_order():
    p = build_interviewer_prompt("Software Engineer",
                                 questions=["What is a closure?", "Describe a hard bug."])
    assert "1) What is a closure?" in p
    assert "2) Describe a hard bug." in p
    assert "these exact questions" in p
    assert "end_interview" in p   # still ends via the function


def test_prompt_without_questions_keeps_improvise_framing():
    p = build_interviewer_prompt("Software Engineer", question_count=5)
    assert "exactly 5 questions" in p
    assert "already in progress" in p


def test_greeting_with_questions_omits_self_intro():
    g = build_greeting("Software Engineer", has_questions=True).lower()
    assert "tell me a little about yourself" not in g
    assert "interview" in g


def test_agent_config_binds_questions():
    cfg = build_agent_config("Software Engineer", questions=["Q one", "Q two"])
    prompt = cfg["agent"]["think"]["prompt"]
    assert "Q one" in prompt and "Q two" in prompt
    assert "tell me a little about yourself" not in cfg["agent"]["greeting"].lower()
```

Run `python -m pytest tests/test_questions.py -q` → these new tests FAIL (questions param not supported yet).

- [ ] **Step 2: Replace `build_interviewer_prompt` in `backend/deepgram.py`**

Replace the entire current `build_interviewer_prompt` function with:
```python
def build_interviewer_prompt(role: str, focus: str = "Mixed", difficulty: str = "Realistic",
                             question_count: int = 5, questions=None) -> str:
    """System prompt for the Claude 'think' provider. In 'bound mode' (a question list is
    given) the interviewer asks those exact questions in order; otherwise it improvises."""
    focus_line = FOCUS_GUIDANCE.get(focus, FOCUS_GUIDANCE["Mixed"])
    difficulty_line = DIFFICULTY_GUIDANCE.get(difficulty, DIFFICULTY_GUIDANCE["Realistic"])
    intro = (f"You are Judy, a warm but professional interviewer conducting a mock job "
             f"interview for a {role} position. {focus_line} {difficulty_line} ")
    tts = ("Everything you say is read aloud by a text-to-speech voice, so reply in plain, "
           "natural spoken sentences only — no markdown, asterisks, bullet points, headings, "
           "numbered lists, emoji, or labels like 'First Question:'. Just ask the question "
           "conversationally. ")
    if questions:
        items = " ".join(f"{i + 1}) {q}" for i, q in enumerate(questions))
        body = (f"The interview is already in progress. Ask the candidate these exact questions, "
                f"one at a time, in this order: {items} "
                f"Ask each question once (you may add a brief natural follow-up to clarify an "
                f"answer), do not add new questions, and never restart or re-ask a question. ")
    else:
        n = max(1, int(question_count))
        plural = "s" if n != 1 else ""
        body = (f"The interview is already in progress: you have greeted the candidate and asked "
                f"them to tell you about themselves, which counts as question 1 of {n}. The "
                f"candidate's first message is their answer to question 1, so do NOT greet again, "
                f"do NOT ask them to introduce themselves again, and never say things like 'let's "
                f"start' or 'let's begin the real interview' — it has already begun. "
                f"Ask exactly {n} question{plural} total, one at a time, in strict order, keeping a "
                f"private count of which question you are on. After each answer, move directly to "
                f"the next unanswered question. Never restart, repeat, or re-ask a question you "
                f"already asked. ")
    closing = ("Keep your turns short (1-3 sentences). Listen to the candidate's full answer "
               "before asking the next question. Do not give feedback during the interview; just "
               "conduct it naturally. Once the candidate has answered the last question, thank "
               "them, give a brief goodbye, then call the end_interview function to finish. After "
               "that, do not ask anything else.")
    return intro + tts + body + closing
```

- [ ] **Step 3: Replace `build_greeting`**

Replace the current `build_greeting` with:
```python
def build_greeting(role: str, has_questions: bool = False) -> str:
    if has_questions:
        # Bound mode: the first listed question is asked by the model, so the greeting must
        # NOT also ask for a self-introduction (that would duplicate / conflict).
        return (f"Hi, thanks for joining. I'm Judy, and I'll be interviewing you for the "
                f"{role} role today. Let's get started.")
    return (f"Hi, thanks for joining. I'll be interviewing you for the {role} role today. "
            f"Whenever you're ready, tell me a little about yourself.")
```

- [ ] **Step 4: Thread `questions` through `build_agent_config`**

Change the `build_agent_config` signature line:
```python
def build_agent_config(role: str, focus: str = "Mixed",
                       difficulty: str = "Realistic", question_count: int = 5) -> dict:
```
to:
```python
def build_agent_config(role: str, focus: str = "Mixed", difficulty: str = "Realistic",
                       question_count: int = 5, questions=None) -> dict:
```
Change the prompt line inside the `think` block:
```python
                "prompt": build_interviewer_prompt(role, focus, difficulty, question_count),
```
to:
```python
                "prompt": build_interviewer_prompt(role, focus, difficulty, question_count, questions),
```
Change the greeting line:
```python
            "greeting": build_greeting(role),
```
to:
```python
            "greeting": build_greeting(role, bool(questions)),
```

- [ ] **Step 5: Run the question tests + full deepgram tests**

Run: `cd /Users/carrieyu/Desktop/Hipe/mediapipe-test && python -m pytest tests/test_questions.py tests/test_deepgram.py -q`
Expected: all pass (the existing deepgram tests still pass because they call with no `questions`, hitting improvise mode).

- [ ] **Step 6: Commit**

```bash
git add backend/deepgram.py tests/test_questions.py
git commit -m "feat(questions): bind a generated question set into the interviewer prompt"
```

---

## Task 3: `/api/questions` endpoint + token pass-through (`main.py`, TDD)

**Files:**
- Modify: `backend/main.py`
- Test: `tests/test_questions.py` (endpoint tests)

- [ ] **Step 1: Append the endpoint tests**

Append to `tests/test_questions.py`:
```python
def test_questions_endpoint_returns_list(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    monkeypatch.setattr(main, "generate_questions",
                        lambda key, role, focus, difficulty, n: ["Q1", "Q2"])
    res = client.post("/api/questions", json={"role": "Software Engineer", "focus": "Mixed",
                                              "difficulty": "Realistic", "question_count": 2})
    assert res.status_code == 200
    assert res.json()["questions"] == ["Q1", "Q2"]


def test_questions_endpoint_no_key(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    res = client.post("/api/questions", json={"role": "Software Engineer"})
    assert res.status_code == 200
    assert res.json() == {"questions": []}


def test_questions_endpoint_degrades_on_error(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    def _boom(*a, **k): raise RuntimeError("anthropic down")
    monkeypatch.setattr(main, "generate_questions", _boom)
    res = client.post("/api/questions", json={"role": "Software Engineer"})
    assert res.status_code == 200
    assert res.json() == {"questions": []}
```

Run `python -m pytest tests/test_questions.py -q` → the 3 endpoint tests FAIL (no `/api/questions` route).

- [ ] **Step 2: Wire `main.py`**

(a) Add the import next to the other backend imports (after `from backend.anthropic_coach import ...`):
```python
from backend.questions import generate_questions
```

(b) Add a request model next to `TokenRequest` (after the `TokenRequest` class):
```python
class QuestionsRequest(BaseModel):
    role: str = "Software Engineer"
    focus: str = "Mixed"
    difficulty: str = "Realistic"
    question_count: int = 5
```

(c) Add `questions` to `TokenRequest` (after its `question_count` field):
```python
    question_count: int = 5
    questions: list[str] = []
```

(d) In `interview_token`, change the returned config build:
```python
            "config": build_agent_config(req.role, req.focus, req.difficulty, req.question_count)}
```
to:
```python
            "config": build_agent_config(req.role, req.focus, req.difficulty, req.question_count, req.questions)}
```

(e) Add the endpoint immediately after the `interview_token` function:
```python
@app.post("/api/questions")
def questions_endpoint(req: QuestionsRequest):
    """Generate a tailored interview question set for the Practice Interview page.
    Graceful: returns {"questions": []} when no ANTHROPIC_API_KEY or generation fails."""
    api_key = os.getenv("ANTHROPIC_API_KEY")
    if not api_key:
        return {"questions": []}
    try:
        qs = generate_questions(api_key, req.role, req.focus, req.difficulty, req.question_count)
    except Exception as exc:  # network / model failure -> degrade
        logging.warning("question generation unavailable: %s", exc)
        return {"questions": []}
    return {"questions": qs}
```

- [ ] **Step 3: Run the endpoint tests + full suite**

Run: `cd /Users/carrieyu/Desktop/Hipe/mediapipe-test && python -m pytest tests/test_questions.py -q && python -m pytest -q`
Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add backend/main.py tests/test_questions.py
git commit -m "feat(questions): /api/questions endpoint + bind questions in interview token"
```

---

## Task 4: Frontend API helper + config field

**Files:**
- Modify: `frontend/api.js`
- Modify: `frontend/interview-config.js`

- [ ] **Step 1: Add `generateQuestions` to `frontend/api.js`**

Inside the `api` object, after the `createSession` entry, add:
```javascript
  // Generate a tailored question set for the Practice Interview page. Never throws;
  // resolves to {questions:[]} when the server can't generate.
  generateQuestions: (s) => request('POST', '/api/questions', s).catch(() => ({ questions: [] })),
```

- [ ] **Step 2: Add the `questions` field to `frontend/interview-config.js`**

Change the `DEFAULTS` line:
```javascript
const DEFAULTS = { role: 'Software Engineer', focus: 'Mixed', difficulty: 'Realistic', questionCount: 5 };
```
to:
```javascript
const DEFAULTS = { role: 'Software Engineer', focus: 'Mixed', difficulty: 'Realistic', questionCount: 5, questions: [] };
```

- [ ] **Step 3: Verify both parse + commit**

Run: `cd /Users/carrieyu/Desktop/Hipe/mediapipe-test && node --input-type=module --check < frontend/api.js && node --input-type=module --check < frontend/interview-config.js && echo SYNTAX_OK`
Expected: `SYNTAX_OK`
```bash
git add frontend/api.js frontend/interview-config.js
git commit -m "feat(questions): api.generateQuestions + config questions field"
```

---

## Task 5: "Your questions" section on the Practice Interview page

**Files:**
- Modify: `frontend/screens/new.js`

- [ ] **Step 1: Import `api`**

Change the top of `frontend/screens/new.js`:
```javascript
import { esc } from '../util.js';
import { setInterviewConfig } from '../interview-config.js';
```
to:
```javascript
import { esc } from '../util.js';
import { setInterviewConfig } from '../interview-config.js';
import { api } from '../api.js';
```

- [ ] **Step 2: Add module state + helpers**

After the line `let media = { stream: null, ctx: null, raf: 0 };`, add:
```javascript
let generatedQuestions = [];   // current AI-generated set for the live interview

// Read the current role/focus/difficulty/count without storing (for generation).
function currentSettings(root){
  const onText = (sel, fb) => { const el = root.querySelector(sel); return el ? el.textContent.trim() : fb; };
  const rc = root.querySelector('.role-card.on');
  return {
    role: rc ? rc.querySelector('.rt').textContent.trim() : 'Software Engineer',
    focus: onText('[data-group="focus"] button.on', 'Mixed'),
    difficulty: onText('[data-group="difficulty"] button.on', 'Realistic'),
    question_count: parseInt(root.querySelector('#ni-qval').textContent, 10) || 5,
  };
}

function renderQuestions(){
  const list = document.getElementById('ni-qlist'); if (!list) return;
  list.innerHTML = generatedQuestions.length
    ? '<ol class="qol">' + generatedQuestions.map((q) => '<li>' + esc(q) + '</li>').join('') + '</ol>'
    : '<div class="fa-note">No questions generated yet — generate a set, or start without and the interviewer will improvise.</div>';
}

// Settings changed → the current set no longer matches; clear it.
function clearQuestions(){
  generatedQuestions = [];
  renderQuestions();
  const btn = document.getElementById('ni-gen'); if (btn) btn.textContent = 'Generate questions';
}

async function generate(root){
  const btn = document.getElementById('ni-gen'); if (!btn) return;
  const list = document.getElementById('ni-qlist');
  btn.disabled = true; btn.textContent = 'Generating…';
  if (list) list.innerHTML = '<div class="fa-note">Generating…</div>';
  const res = await api.generateQuestions(currentSettings(root));
  generatedQuestions = (res && res.questions) || [];
  if (generatedQuestions.length){
    renderQuestions();
    btn.textContent = 'Regenerate';
  } else {
    if (list) list.innerHTML = '<div class="fa-note">Couldn’t generate — you can still start; the interviewer will improvise.</div>';
    btn.textContent = 'Generate questions';
  }
  btn.disabled = false;
}
```

- [ ] **Step 3: Include questions in `saveSettings`**

Change the last line of `saveSettings`:
```javascript
  setInterviewConfig({ role, focus, difficulty, questionCount });
```
to:
```javascript
  setInterviewConfig({ role, focus, difficulty, questionCount, questions: generatedQuestions });
```

- [ ] **Step 4: Reset state on mount, clear on settings change, wire the button**

In `newInterview()`, at the very top of the function body (before `stopMedia();`), add:
```javascript
  generatedQuestions = [];
```
In the `queueMicrotask` block, the single-select group handler currently ends after toggling. Change it to clear the set on change:
```javascript
    root.querySelectorAll('[data-group]').forEach((group) => {
      group.addEventListener('click', (e) => {
        const btn = e.target.closest('button, .role-card');
        if (!btn || !group.contains(btn)) return;
        group.querySelectorAll('button, .role-card').forEach((b) => b.classList.toggle('on', b === btn));
        clearQuestions();
      });
    });
```
The stepper handler — change it to clear on change too:
```javascript
    root.querySelectorAll('[data-step]').forEach((b) => b.addEventListener('click', () => {
      const cur = parseInt(val.textContent, 10) || 6;
      const next = Math.max(3, Math.min(12, cur + parseInt(b.getAttribute('data-step'), 10)));
      val.textContent = next;
      clearQuestions();
    }));
```
After the `ni-test` listener line, wire the generate button:
```javascript
    document.getElementById('ni-gen').addEventListener('click', () => generate(root));
```

- [ ] **Step 5: Add the "Your questions" section markup + renumber Device check**

In the returned template, after the "Tune the set" `ni-set` block (the one ending with the Questions stepper `'</div></div></div>' +` for the `row-wrap`), and still inside the left-column `<div>`, add this new block right before that left column's closing `'</div>' +`:
```javascript
        '<div class="ni-set"><div class="ni-fl">3 · Your questions</div>' +
          '<div class="ni-q-head">' +
            '<span class="muted" style="font-size:12px">AI-written for your role, focus &amp; difficulty.</span>' +
            '<button class="btn btn-ghost" id="ni-gen" type="button">Generate questions</button>' +
          '</div>' +
          '<div class="ni-qlist" id="ni-qlist"><div class="fa-note">No questions generated yet — generate a set, or start without and the interviewer will improvise.</div></div>' +
        '</div>' +
```
Then change the Device check heading from:
```javascript
      '<div class="devcheck"><div class="ni-fl">3 · Device check</div>' +
```
to:
```javascript
      '<div class="devcheck"><div class="ni-fl">4 · Device check</div>' +
```

- [ ] **Step 6: Verify + commit**

Run: `cd /Users/carrieyu/Desktop/Hipe/mediapipe-test && node --input-type=module --check < frontend/screens/new.js && echo SYNTAX_OK`
Expected: `SYNTAX_OK`
```bash
git add frontend/screens/new.js
git commit -m "feat(questions): Your questions section (generate/regenerate) on Practice Interview"
```

---

## Task 6: Pass the questions into the live interview

**Files:**
- Modify: `frontend/screens/live.js`

- [ ] **Step 1: Include `questions` in the token request**

In `startAgent`, change:
```javascript
    const tok = await api.interviewToken({
      role: cfg.role, focus: cfg.focus, difficulty: cfg.difficulty, question_count: cfg.questionCount,
    });
```
to:
```javascript
    const tok = await api.interviewToken({
      role: cfg.role, focus: cfg.focus, difficulty: cfg.difficulty, question_count: cfg.questionCount,
      questions: cfg.questions || [],
    });
```

- [ ] **Step 2: Verify + commit**

Run: `cd /Users/carrieyu/Desktop/Hipe/mediapipe-test && node --input-type=module --check < frontend/screens/live.js && echo SYNTAX_OK`
Expected: `SYNTAX_OK`
```bash
git add frontend/screens/live.js
git commit -m "feat(questions): send the chosen question set into the interview token"
```

---

## Task 7: Styles

**Files:**
- Modify: `frontend/styles/clean-studio.css`

- [ ] **Step 1: Append the styles**

Append to `frontend/styles/clean-studio.css`:
```css

/* Practice Interview — "Your questions" section */
.ni-q-head{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:10px;flex-wrap:wrap}
.ni-q-head .btn{flex:none}
.ni-qlist .qol{margin:0;padding-left:20px;display:flex;flex-direction:column;gap:7px;font-size:13px;line-height:1.4;color:var(--ink-2)}
.ni-qlist .fa-note{font-size:12px;color:var(--ink-3);padding:6px 0}
```

- [ ] **Step 2: Verify braces + commit**

Run: `cd /Users/carrieyu/Desktop/Hipe/mediapipe-test && awk '{o+=gsub(/{/,"{"); c+=gsub(/}/,"}")} END{print "open="o" close="c}' frontend/styles/clean-studio.css`
Expected: `open` equals `close`.
```bash
git add frontend/styles/clean-studio.css
git commit -m "style(questions): Practice Interview question-list styles"
```

---

## Task 8: Verification

- [ ] **Step 1: Full backend suite**

Run: `cd /Users/carrieyu/Desktop/Hipe/mediapipe-test && python -m pytest -q`
Expected: all pass (existing + new question tests).

- [ ] **Step 2: Manual browser test (needs ANTHROPIC_API_KEY)**

- Practice Interview → choose role/focus/difficulty/count → "3 · Your questions" → click **Generate questions** → a numbered list appears tailored to the settings; the button becomes **Regenerate**; clicking it yields a different set.
- Change the role/focus/difficulty/count → the list **clears** and the button resets to "Generate questions".
- **Start with a generated set** → the live interviewer asks those exact questions, in order, then ends.
- **Start without generating** → the interview improvises as before (and still ends properly).
- With no `ANTHROPIC_API_KEY` → Generate shows "Couldn't generate — you can still start."

---

## Self-Review

**Spec coverage:**
- Generate tailored questions (role/focus/difficulty/count) → Task 1 (`generate_questions`) + Task 3 (endpoint). ✓
- Regenerate for variety → temperature 0.9 (Task 1) + Regenerate button (Task 5). ✓
- Drives the interview → Task 2 (bound-mode prompt) + Task 6 (token carries questions) + Task 3 (token passes to config). ✓
- Inline below "Tune the set" → Task 5 markup. ✓
- Button-driven, whole-set, clear-on-change → Task 5. ✓
- Fallback to improvise → Task 2 (no questions → improvise branch). ✓
- Graceful (no key / failure) → Task 3 endpoint + Task 4 `generateQuestions` catch + Task 5 UI message. ✓

**Placeholder scan:** every code step is complete; commands have expected output. ✓

**Type/name consistency:** `generate_questions(api_key, role, focus, difficulty, n)` defined (Task 1) and called in `main.py` (Task 3) and monkeypatched in tests with the same 5-arg signature; `parse_questions` (Task 1); `build_interviewer_prompt(..., questions)` / `build_greeting(role, has_questions)` / `build_agent_config(..., questions)` (Task 2) called from `main.py` (Task 3); `api.generateQuestions(s)` (Task 4) returns `{questions:[]}` consumed by `generate()` (Task 5); `interview-config` `questions` field (Task 4) read in `saveSettings`/`live.js` (Tasks 5, 6); DOM ids `ni-gen`, `ni-qlist`, `ni-qval` consistent. ✓

---

## Execution Handoff

After implementation, run the Task 8 manual pass with a real `ANTHROPIC_API_KEY`. Then use `superpowers:finishing-a-development-branch` to integrate.
