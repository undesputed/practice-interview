# New Interview "Tone" Control — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a four-option **Tone** control (Friendly / Professional / Stern / Intimidating) to the New Interview screen that sets the interviewer's manner (Claude system prompt) and spoken voice (Deepgram Aura-2), separate from the existing Difficulty control.

**Architecture:** `tone` threads through the same path every existing setup field uses: `new.js` form → `interview-config.js` store → `live.js` request → `POST /api/interview/token` (`main.py`) → `deepgram.py` (`build_agent_config` → `build_interviewer_prompt` + voice lookup). Backend is fully TDD'd via `tests/test_deepgram.py`; the frontend has no test harness and is verified manually. Default Professional preserves current behavior (same manner wording, same `aura-2-thalia-en` voice).

**Tech Stack:** Python 3 + pytest + FastAPI/Pydantic (backend), vanilla ES modules (frontend), Deepgram Voice Agent (nova-3 STT, Claude think, Aura-2 TTS).

## Global Constraints

- `tone` is the **last** parameter of `build_interviewer_prompt` and `build_agent_config` (after `questions`), because `backend/main.py` calls `build_agent_config(...)` positionally — inserting earlier would shift args.
- Valid tones: `Friendly`, `Professional`, `Stern`, `Intimidating`. Default and fallback for unknown/missing: `Professional` (manner) + `aura-2-thalia-en` (voice).
- All voices stay `aura-2-*` (the existing `startswith("aura-2")` test must keep passing).
- Run tests with `python3 -m pytest` (this environment has no `python` alias). API-level test files (`tests/test_main.py` etc.) fail to *collect* with `ModuleNotFoundError: No module named 'fastapi'` — a pre-existing environment gap; ignore those collection errors and scope test runs to `tests/test_deepgram.py`.

---

### Task 1: Backend — tone manner + voice

**Files:**
- Modify: `backend/deepgram.py` (`build_interviewer_prompt`, `build_greeting`, `build_agent_config`; add `TONE_GUIDANCE`, `TONE_VOICE`)
- Modify: `backend/main.py:33-38` (`TokenRequest`) and `backend/main.py:96-97` (handler call)
- Test: `tests/test_deepgram.py`

**Interfaces:**
- Produces: `build_interviewer_prompt(role, focus="Mixed", difficulty="Realistic", question_count=5, questions=None, tone="Professional") -> str`; `build_agent_config(role, focus="Mixed", difficulty="Realistic", question_count=5, questions=None, tone="Professional") -> dict`. The agent config's `cfg["agent"]["speak"]["provider"]["model"]` is the tone's Aura-2 voice; `cfg["agent"]["think"]["prompt"]` contains the tone manner line and no longer contains "Judy".

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_deepgram.py` (it already imports `build_agent_config, build_greeting` at the top):

```python
def test_tone_injects_manner_line():
    friendly = build_agent_config("Software Engineer", tone="Friendly")["agent"]["think"]["prompt"].lower()
    assert "encouraging" in friendly
    intimidating = build_agent_config("Software Engineer", tone="Intimidating")["agent"]["think"]["prompt"].lower()
    assert "high-pressure" in intimidating


def test_tone_selects_voice():
    expected = {
        "Friendly": "aura-2-helena-en",
        "Professional": "aura-2-thalia-en",
        "Stern": "aura-2-saturn-en",
        "Intimidating": "aura-2-zeus-en",
    }
    for tone, voice in expected.items():
        cfg = build_agent_config("Software Engineer", tone=tone)
        assert cfg["agent"]["speak"]["provider"]["model"] == voice


def test_unknown_tone_falls_back_to_professional_and_thalia():
    cfg = build_agent_config("Software Engineer", tone="Wacky")
    assert cfg["agent"]["speak"]["provider"]["model"] == "aura-2-thalia-en"
    assert "professional" in cfg["agent"]["think"]["prompt"].lower()


def test_default_tone_is_professional_thalia():
    cfg = build_agent_config("Software Engineer")
    assert cfg["agent"]["speak"]["provider"]["model"] == "aura-2-thalia-en"
    assert "professional" in cfg["agent"]["think"]["prompt"].lower()


def test_no_fixed_persona_name_in_prompt_or_greeting():
    prompt = build_agent_config("Software Engineer")["agent"]["think"]["prompt"]
    assert "Judy" not in prompt
    assert "Judy" not in build_greeting("Software Engineer", has_questions=True)
    assert "Judy" not in build_greeting("Software Engineer", has_questions=False)
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `python3 -m pytest tests/test_deepgram.py -k "tone or persona" -v`
Expected: FAIL — `build_agent_config()` has no `tone` parameter yet (TypeError), and the prompt still contains "Judy".

- [ ] **Step 3: Add the tone dictionaries in `backend/deepgram.py`**

Insert immediately after the `DIFFICULTY_GUIDANCE` dict (after line 26, before `build_interviewer_prompt`):

```python
# How the "Tone" choice shapes the interviewer's manner (not question hardness — that is
# Difficulty's job). Spoken delivery is set separately via TONE_VOICE.
TONE_GUIDANCE = {
    "Friendly": "Adopt a warm, encouraging manner: put the candidate at ease, react "
                "supportively, and acknowledge good answers.",
    "Professional": "Adopt a calm, balanced, professional manner — warm but not effusive.",
    "Stern": "Adopt a cool, no-nonsense manner: minimal warmth, brief acknowledgements, "
             "and steady pressure.",
    "Intimidating": "Adopt a tough, high-pressure manner: be curt and demanding and "
                    "challenge answers directly — but never personal, rude, or demeaning.",
}

# Tone -> Deepgram Aura-2 voice (verified IDs). Falls back to TTS_MODEL.
TONE_VOICE = {
    "Friendly": "aura-2-helena-en",       # Caring, Natural, Friendly
    "Professional": "aura-2-thalia-en",   # current default voice (unchanged)
    "Stern": "aura-2-saturn-en",          # Knowledgeable, Confident, Baritone
    "Intimidating": "aura-2-zeus-en",     # Deep, Trustworthy, Smooth
}
```

- [ ] **Step 4: Thread `tone` through `build_interviewer_prompt` and drop "Judy"**

In `backend/deepgram.py`, change the signature and intro. Replace:

```python
def build_interviewer_prompt(role: str, focus: str = "Mixed", difficulty: str = "Realistic",
                             question_count: int = 5, questions=None) -> str:
    """System prompt for the Claude 'think' provider. In 'bound mode' (a question list is
    given) the interviewer asks those exact questions in order; otherwise it improvises."""
    focus_line = FOCUS_GUIDANCE.get(focus, FOCUS_GUIDANCE["Mixed"])
    difficulty_line = DIFFICULTY_GUIDANCE.get(difficulty, DIFFICULTY_GUIDANCE["Realistic"])
    intro = (f"You are Judy, a warm but professional interviewer conducting a mock job "
             f"interview for a {role} position. {focus_line} {difficulty_line} ")
```

with:

```python
def build_interviewer_prompt(role: str, focus: str = "Mixed", difficulty: str = "Realistic",
                             question_count: int = 5, questions=None,
                             tone: str = "Professional") -> str:
    """System prompt for the Claude 'think' provider. In 'bound mode' (a question list is
    given) the interviewer asks those exact questions in order; otherwise it improvises."""
    focus_line = FOCUS_GUIDANCE.get(focus, FOCUS_GUIDANCE["Mixed"])
    difficulty_line = DIFFICULTY_GUIDANCE.get(difficulty, DIFFICULTY_GUIDANCE["Realistic"])
    tone_line = TONE_GUIDANCE.get(tone, TONE_GUIDANCE["Professional"])
    intro = (f"You are an interviewer conducting a mock job interview for a {role} position. "
             f"{focus_line} {difficulty_line} {tone_line} ")
```

- [ ] **Step 5: Drop "Judy" from the bound-mode greeting**

In `backend/deepgram.py` `build_greeting`, replace:

```python
        return (f"Hi, thanks for joining. I'm Judy, and I'll be interviewing you for the "
                f"{role} role today. Let's get started.")
```

with:

```python
        return (f"Hi, thanks for joining. I'll be interviewing you for the "
                f"{role} role today. Let's get started.")
```

- [ ] **Step 6: Thread `tone` through `build_agent_config` (manner + voice)**

In `backend/deepgram.py`, change the signature, the prompt call, and the speak model. Replace:

```python
def build_agent_config(role: str, focus: str = "Mixed", difficulty: str = "Realistic",
                       question_count: int = 5, questions=None) -> dict:
```
with:
```python
def build_agent_config(role: str, focus: str = "Mixed", difficulty: str = "Realistic",
                       question_count: int = 5, questions=None,
                       tone: str = "Professional") -> dict:
```

Replace:
```python
                "prompt": build_interviewer_prompt(role, focus, difficulty, question_count, questions),
```
with:
```python
                "prompt": build_interviewer_prompt(role, focus, difficulty, question_count, questions, tone),
```

Replace:
```python
            "speak": {"provider": {"type": "deepgram", "model": TTS_MODEL}},
```
with:
```python
            "speak": {"provider": {"type": "deepgram", "model": TONE_VOICE.get(tone, TTS_MODEL)}},
```

- [ ] **Step 7: Add `tone` to the request model and handler in `backend/main.py`**

In `TokenRequest` (lines 33-38), add the `tone` field after `question_count`:

```python
class TokenRequest(BaseModel):
    role: str = "Software Engineer"
    focus: str = "Mixed"
    difficulty: str = "Realistic"
    question_count: int = 5
    questions: list[str] = []
    tone: str = "Professional"
```

In the handler (lines 96-97), pass `tone` by keyword:

```python
    return {"url": DEEPGRAM_AGENT_URL, "token": token, "scheme": scheme,
            "config": build_agent_config(req.role, req.focus, req.difficulty,
                                         req.question_count, req.questions, tone=req.tone)}
```

- [ ] **Step 8: Run the full deepgram suite to verify pass + no regressions**

Run: `python3 -m pytest tests/test_deepgram.py -v`
Expected: all pass — the 5 new tests plus the existing ones (`test_agent_config_has_required_sections` still passes because every voice is `aura-2-*`; `test_prompt_reflects_focus_and_difficulty` still passes).

- [ ] **Step 9: Commit**

```bash
git add backend/deepgram.py backend/main.py tests/test_deepgram.py
git commit -m "feat(interview): tone control sets interviewer manner + voice

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Frontend — Tone control + config threading

**Files:**
- Modify: `frontend/screens/new.js` (form markup + `saveSettings`)
- Modify: `frontend/interview-config.js:4` (`DEFAULTS`)
- Modify: `frontend/screens/live.js:80-83` (`startAgent` payload)

**Interfaces:**
- Consumes: backend `TokenRequest.tone` (default `"Professional"`) from Task 1.
- Produces: a `tone` string in the in-memory interview config and in the `POST /api/interview/token` body.

- [ ] **Step 1: Add the Tone segmented control to the form markup**

In `frontend/screens/new.js`, inside the "2 · Tune the set" `row-wrap`, add a Tone group between the Difficulty group and the Questions stepper. Replace:

```javascript
            '<div><span class="ql">Difficulty</span><div class="ni-seg" data-group="difficulty">' +
              '<button>Warm-up</button><button class="on">Realistic</button><button>Hard</button></div></div>' +
            '<div><span class="ql">Questions</span><div class="stepper">' +
```

with:

```javascript
            '<div><span class="ql">Difficulty</span><div class="ni-seg" data-group="difficulty">' +
              '<button>Warm-up</button><button class="on">Realistic</button><button>Hard</button></div></div>' +
            '<div><span class="ql">Tone</span><div class="ni-seg" data-group="tone">' +
              '<button>Friendly</button><button class="on">Professional</button><button>Stern</button><button>Intimidating</button></div></div>' +
            '<div><span class="ql">Questions</span><div class="stepper">' +
```

The generic `[data-group]` click handler (lines 185-192) already gives the new group single-select toggle behavior and triggers `clearQuestions()` — no extra JS wiring is needed.

- [ ] **Step 2: Read `tone` in `saveSettings`**

In `frontend/screens/new.js` `saveSettings`, add the `tone` read and pass it to `setInterviewConfig`. Replace:

```javascript
  const focus = onText('[data-group="focus"] button.on', 'Mixed');
  const difficulty = onText('[data-group="difficulty"] button.on', 'Realistic');
  const questionCount = parseInt(root.querySelector('#ni-qval').textContent, 10) || 5;
  setInterviewConfig({ role, focus, difficulty, questionCount, questions: generatedQuestions });
```

with:

```javascript
  const focus = onText('[data-group="focus"] button.on', 'Mixed');
  const difficulty = onText('[data-group="difficulty"] button.on', 'Realistic');
  const tone = onText('[data-group="tone"] button.on', 'Professional');
  const questionCount = parseInt(root.querySelector('#ni-qval').textContent, 10) || 5;
  setInterviewConfig({ role, focus, difficulty, tone, questionCount, questions: generatedQuestions });
```

(Leave `currentSettings()` unchanged — it feeds question generation, which tone does not affect.)

- [ ] **Step 3: Add `tone` to the config defaults**

In `frontend/interview-config.js`, replace line 4:

```javascript
const DEFAULTS = { role: 'Software Engineer', focus: 'Mixed', difficulty: 'Realistic', questionCount: 5, questions: [] };
```

with:

```javascript
const DEFAULTS = { role: 'Software Engineer', focus: 'Mixed', difficulty: 'Realistic', tone: 'Professional', questionCount: 5, questions: [] };
```

- [ ] **Step 4: Send `tone` in the interview-token request**

In `frontend/screens/live.js` `startAgent`, replace:

```javascript
    const tok = await api.interviewToken({
      role: cfg.role, focus: cfg.focus, difficulty: cfg.difficulty, question_count: cfg.questionCount,
      questions: cfg.questions || [],
    });
```

with:

```javascript
    const tok = await api.interviewToken({
      role: cfg.role, focus: cfg.focus, difficulty: cfg.difficulty, question_count: cfg.questionCount,
      questions: cfg.questions || [], tone: cfg.tone,
    });
```

- [ ] **Step 5: Static sanity check (no JS test harness exists)**

Run:
```bash
grep -n 'data-group="tone"' frontend/screens/new.js
grep -n "tone: 'Professional'" frontend/interview-config.js
grep -n "tone: cfg.tone" frontend/screens/live.js
grep -n "tone," frontend/screens/new.js
```
Expected: one hit each — the Tone button group, the default, the request field, and the `setInterviewConfig({... tone, ...})` call.

- [ ] **Step 6: Manual verification (browser)**

If a dev server is available, load the New Interview screen and confirm: a **Tone** control shows four buttons with **Professional** selected by default; selecting another tone and starting an interview sends `tone` in the `POST /api/interview/token` body (Network tab) and the interviewer's voice/manner changes. If no server is available in this session, record that the change is code-verified and browser-pending. Do not claim browser verification you did not perform.

- [ ] **Step 7: Commit**

```bash
git add frontend/screens/new.js frontend/interview-config.js frontend/screens/live.js
git commit -m "feat(interview): Tone control on the New Interview screen

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Docs — update the voice-agent spec

**Files:**
- Modify: `docs/superpowers/specs/2026-06-15-live-interview-voice-agent-design.md`

- [ ] **Step 1: Document the Tone control in the Settings-flow section**

In `docs/superpowers/specs/2026-06-15-live-interview-voice-agent-design.md`, in the bulleted list under item 5 ("The prompt reflects:"), insert a **Tone** bullet between the existing **Difficulty** bullet and the **Question count** bullet. Find:

```
   - **Difficulty** → tone + follow-up intensity: Warm-up (gentle, few follow-ups),
     Realistic (occasional probes), Hard (rigorous, pointed follow-ups).
   - **Question count** → "Ask exactly N questions… once the candidate has answered all N,
```

and insert the new bullet so it becomes:

```
   - **Difficulty** → question hardness + follow-up intensity: Warm-up (gentle, few follow-ups),
     Realistic (occasional probes), Hard (rigorous, pointed follow-ups).
   - **Tone** → interviewer *manner* (separate axis from Difficulty's question hardness):
     Friendly (warm, encouraging), Professional (calm, balanced — default), Stern (cool,
     no-nonsense), Intimidating (tough, high-pressure but never demeaning). Tone also selects
     the spoken Aura-2 voice — Friendly→helena, Professional→thalia (the default), Stern→saturn,
     Intimidating→zeus — falling back to thalia for unknown/missing tone. The interviewer
     persona is no longer given a fixed name, so any voice fits.
   - **Question count** → "Ask exactly N questions… once the candidate has answered all N,
```

(Note the Difficulty bullet's lead-in changed from "tone + follow-up intensity" to "question hardness + follow-up intensity" to avoid the word "tone" now meaning a separate control.)

- [ ] **Step 2: Verify the edit**

Run: `grep -n "Tone\|helena\|no longer given a fixed name" docs/superpowers/specs/2026-06-15-live-interview-voice-agent-design.md`
Expected: the new Tone bullet, the voice mapping, and the persona-name note are present.

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-06-15-live-interview-voice-agent-design.md
git commit -m "docs(interview): document the Tone control in the voice-agent spec

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- Tone control UI (4 options, default Professional) → Task 2 Steps 1-2. ✓
- Config threading (interview-config, live.js, api passthrough) → Task 2 Steps 3-4 (api.js unchanged, correct). ✓
- `TokenRequest.tone` + handler → Task 1 Step 7. ✓
- `TONE_GUIDANCE` manner + injection → Task 1 Steps 3-4. ✓
- `TONE_VOICE` mapping + fallback → Task 1 Steps 3, 6. ✓
- Drop "Judy" (prompt + greeting) → Task 1 Steps 4-5. ✓
- Signature placement (tone last, positional-safe) → Global Constraints + Task 1 Steps 4, 6, 7. ✓
- Fallback for unknown/missing tone → Task 1 Steps 6-7 + tests Step 1. ✓
- Tests (manner, voice, fallback, default, no-Judy) → Task 1 Step 1. ✓
- Voice-agent spec doc → Task 3. ✓
- Spec's `backend/.env` comment item → intentionally **excluded**: `backend/.env` is gitignored (local only), not repo documentation, so editing it would not persist for others.

**Placeholder scan:** No TBD/TODO; every code step shows full before/after; manual-verification step is explicit about not over-claiming. ✓

**Type/name consistency:** `tone` param is last everywhere; tone strings (`Friendly`/`Professional`/`Stern`/`Intimidating`), voice ids (helena/thalia/saturn/zeus), and the `TONE_GUIDANCE`/`TONE_VOICE` names match across Task 1 code, tests, Task 2 frontend, and Task 3 docs. ✓
