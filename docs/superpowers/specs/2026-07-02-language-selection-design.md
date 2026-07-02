# Language Selection for Practice Interview

**Date:** 2026-07-02
**Status:** Approved

## Overview

Add a language selector (English / Japanese) to the Practice Interview setup screen. When Japanese is chosen, the Deepgram Voice Agent speaks Japanese, listens in Japanese, pre-generated questions are written in Japanese, and the live transcript is in Japanese. The post-session report and coaching feedback remain in English.

## Scope

Two supported languages only: English (`en`) and Japanese (`ja`). No third language is in scope.

## UI Changes — `frontend/screens/practice-interview.js`

A new **Language** segmented control is added to section "2 · Tune the session", alongside Focus / Difficulty / Tone / Questions:

- Options: `English` (default, selected) · `日本語`
- Selecting Japanese clears any pre-generated questions (they must be regenerated in Japanese)
- `currentSettings()` reads the selected value and includes `language` in the object passed to `api.generateQuestions()`
- `saveSettings()` writes `language` into `interview-config.js`

## Config Plumbing

`frontend/interview-config.js` — add `language: 'en'` to `DEFAULTS`.

`frontend/screens/live.js` — `startAgent()` already passes config fields to `api.interviewToken()`; add `language: cfg.language`.

`backend/main.py`:
- `TokenRequest` — add `language: str = "en"`
- `QuestionsRequest` — add `language: str = "en"`
- `build_agent_config(...)` call in `/api/interview/token` — pass `language=req.language`
- `generate_questions(...)` call in `/api/questions` — pass `language=req.language`

## Deepgram Voice Agent Config — `backend/deepgram.py`

`build_agent_config` gains `language: str = "en"`.

### STT (listen)
```python
"listen": {
    "provider": {
        "type": "deepgram",
        "model": "nova-3",
        "language": language,   # "en" or "ja"
        "keyterms": keyterms,
    }
}
```

### TTS (speak)
Add `TONE_VOICE_JA` dict mapping each tone to an Aura-2 Japanese voice:
```python
TONE_VOICE_JA = {
    "Friendly":     "aura-2-izanami-ja",
    "Professional": "aura-2-fujin-ja",
    "Stern":        "aura-2-ebisu-ja",
    "Intimidating": "aura-2-uzume-ja",
}
```
Selection logic:
```python
voice_map = TONE_VOICE_JA if language == "ja" else TONE_VOICE
speak_model = voice_map.get(tone, "aura-2-fujin-ja" if language == "ja" else TTS_MODEL)
```

### Agent-level language field
```python
"agent": {
    "language": language,   # was hardcoded "en"
    ...
}
```

### Claude system prompt (`build_interviewer_prompt`)
`build_interviewer_prompt` gains `language: str = "en"`. When `language == "ja"`, prepend:
```
"Conduct the entire interview in Japanese. Ask all questions in Japanese and respond only in Japanese. "
```
All other prompt logic is unchanged.

## Question Generation — `backend/questions.py`

`generate_questions` gains `language: str = "en"`. When `language == "ja"`, append to the system prompt:
```
" Write all questions in Japanese."
```
This causes Claude to generate Japanese-language questions for the pre-session list.

## Report / Coaching

No changes. `anthropic_coach.py` and `verdict.py` receive the Japanese transcript and produce English coaching prose. The scoring pipeline is language-agnostic — it operates on numeric presence/voice metrics, not transcript text (Claude reads the transcript for content scoring but is not instructed to mirror the language).

## Error Handling / Degradation

- If Deepgram rejects `language: "ja"` on the listen model, the Voice Agent will fall back to English STT — no crash, just degraded transcription.
- If question generation produces empty results in Japanese, the existing fallback ("interviewer will improvise") applies unchanged.
- The language field defaults to `"en"` everywhere, so no existing behaviour changes unless the user explicitly selects Japanese.

## Files Changed

| File | Change |
|------|--------|
| `backend/deepgram.py` | Add `TONE_VOICE_JA`, `language` param to `build_agent_config` and `build_interviewer_prompt` |
| `backend/main.py` | Add `language` to `TokenRequest` and `QuestionsRequest`; pass through to config/questions |
| `backend/questions.py` | Add `language` param; append Japanese instruction when `language == "ja"` |
| `frontend/interview-config.js` | Add `language: 'en'` to `DEFAULTS` |
| `frontend/screens/practice-interview.js` | Add Language segmented control; include in `currentSettings()` and `saveSettings()` |
| `frontend/screens/live.js` | Pass `language: cfg.language` in `api.interviewToken()` call |
