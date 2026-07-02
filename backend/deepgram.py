# backend/deepgram.py
import httpx

DEEPGRAM_AGENT_URL = "wss://agent.deepgram.com/v1/agent/converse"
THINK_MODEL = "claude-sonnet-4-6"
TTS_MODEL = "aura-2-thalia-en"


# Scenario -> interviewer persona. {role} / {role_ctx} substituted at build time.
# role_ctx is " for the {role} role" when a role was chosen, or "" otherwise.
SCENARIO_INTRO = {
    "job":      "You are an interviewer conducting a mock job interview for a {role} position.",
    "present":  "You are a session evaluator watching the candidate deliver a practice presentation{role_ctx}.",
    "tough":    "You are a conversation partner helping the candidate practise a tough, high-stakes conversation{role_ctx}.",
    "pitch":    "You are a potential investor or client evaluating a practice pitch{role_ctx}.",
    "teach":    "You are a learner or evaluator listening to the candidate teach or explain a topic{role_ctx}.",
    "language": "You are a native-speaker conversation partner helping the candidate practise speaking another language{role_ctx}.",
}

# Scenario -> opening greeting. Non-job scenarios don't use the self-intro-as-Q1 pattern.
SCENARIO_GREETING = {
    "present":  "Hi, thanks for joining. Whenever you're ready, go ahead and start.",
    "tough":    "Hi, thanks for joining. I'll play the other party here — let's begin whenever you're ready.",
    "pitch":    "Hi, thanks for your time. Whenever you're ready, go ahead with your pitch.",
    "teach":    "Hi! I'm ready to learn. Whenever you're ready, please go ahead.",
    "language": "Hi! Let's chat. Whenever you're ready, feel free to start.",
}

SCENARIO_GREETING_JA = {
    "present":  "こんにちは。準備ができましたら、プレゼンテーションを始めてください。",
    "tough":    "こんにちは。私が相手役を担当します。準備ができましたらどうぞ。",
    "pitch":    "こんにちは。お時間をいただきありがとうございます。準備ができましたらピッチをお願いします。",
    "teach":    "こんにちは！準備ができましたら、説明を始めてください。",
    "language": "こんにちは！準備ができましたら、自由に話し始めてください。",
}

# How the Practice Interview "Focus" choice shapes the kinds of questions Claude asks.
FOCUS_GUIDANCE = {
    "Behavioral": "Ask behavioral and situational questions, and encourage STAR-style answers "
                  "(Situation, Task, Action, Result).",
    "Technical": "Ask technical, role-specific questions that probe depth of knowledge and "
                 "problem-solving for this role.",
    "Mixed": "Mix behavioral questions with technical, role-specific ones.",
}

# How the "Difficulty" choice shapes tone and follow-up intensity.
DIFFICULTY_GUIDANCE = {
    "Warm-up": "Keep the questions gentle and supportive, with little pressure and minimal "
               "follow-ups.",
    "Realistic": "Use a realistic interview tone, with occasional follow-up probes to clarify "
                 "answers.",
    "Hard": "Be rigorous and challenging: ask demanding questions and dig in with pointed "
            "follow-ups.",
}

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

# Japanese Aura-2 voices by tone.
TONE_VOICE_JA = {
    "Friendly":     "aura-2-izanami-ja",
    "Professional": "aura-2-fujin-ja",
    "Stern":        "aura-2-ebisu-ja",
    "Intimidating": "aura-2-uzume-ja",
}


def build_interviewer_prompt(role: str, focus: str = "Mixed", difficulty: str = "Realistic",
                             question_count: int = 5, questions=None,
                             tone: str = "Professional", scenario: str = "job",
                             language: str = "en") -> str:
    """System prompt for the Claude 'think' provider. In 'bound mode' (a question list is
    given) the interviewer asks those exact questions in order; otherwise it improvises.
    The `scenario` controls the AI persona and session framing."""
    lang_line = ("Conduct the entire interview in Japanese. Ask all questions in Japanese "
                 "and respond only in Japanese. ") if language == "ja" else ""
    focus_line = FOCUS_GUIDANCE.get(focus, FOCUS_GUIDANCE["Mixed"])
    difficulty_line = DIFFICULTY_GUIDANCE.get(difficulty, DIFFICULTY_GUIDANCE["Realistic"])
    tone_line = TONE_GUIDANCE.get(tone, TONE_GUIDANCE["Professional"])
    role_ctx = f" for the {role} role" if role else ""
    intro_tmpl = SCENARIO_INTRO.get(scenario, SCENARIO_INTRO["job"])
    intro = (f"{lang_line}{intro_tmpl.format(role=role or 'general', role_ctx=role_ctx)} "
             f"{focus_line} {difficulty_line} {tone_line} ")
    tts = ("Everything you say is read aloud by a text-to-speech voice, so reply in plain, "
           "natural spoken sentences only — no markdown, asterisks, bullet points, headings, "
           "numbered lists, emoji, or labels like 'First Question:'. Just speak naturally. ")
    session_word = "interview" if scenario == "job" else "session"
    if questions:
        items = " ".join(f"{i + 1}) {q}" for i, q in enumerate(questions))
        body = (f"The {session_word} is already in progress. Ask the candidate these exact "
                f"questions, one at a time, in this order: {items} "
                f"Ask each question once. A brief clarifying follow-up does not count as a new "
                f"question, but do not add extra questions beyond the list. Never restart or "
                f"re-ask a question. ")
        n = len(questions)
    else:
        n = max(1, int(question_count))
        plural = "s" if n != 1 else ""
        if scenario == "job":
            body = (f"The {session_word} is already in progress: you have greeted the candidate "
                    f"and asked them to tell you about themselves, which counts as question 1 of "
                    f"{n}. The candidate's first message is their answer to question 1, so do NOT "
                    f"greet again, do NOT ask them to introduce themselves again, and never say "
                    f"things like 'let's start' or 'let's begin' — it has already begun. "
                    f"Ask exactly {n} question{plural} total, keeping a private running count. "
                    f"A brief clarifying follow-up does not count as a new question. After each "
                    f"main answer, move directly to the next unanswered question. Never restart "
                    f"or re-ask a question. ")
        else:
            body = (f"The {session_word} is already in progress: you have greeted the candidate "
                    f"and invited them to begin, which counts as prompt 1 of {n}. Do NOT greet "
                    f"again. Ask exactly {n} question{plural} or prompt{plural} total, keeping a "
                    f"private running count. A brief clarifying follow-up does not count as a new "
                    f"prompt. After each main response, move directly to the next prompt. Never "
                    f"restart or re-ask. ")
    conduct = ("Keep your turns short (1-3 sentences). Do not give feedback or coaching during "
               "the session. ")
    # Make the ending rule a clearly labelled, mandatory instruction so Claude doesn't skip it.
    ending_rule = (
        f"ENDING THE SESSION — this is mandatory: after the candidate answers your {n}th and "
        f"final question, say a brief goodbye in one sentence, then IMMEDIATELY call "
        f"end_interview. You MUST call end_interview — the session cannot close without it. "
        f"Do not ask another question. Do not offer feedback. Do not say anything after "
        f"calling end_interview."
    )
    lang_rule = (
        " LANGUAGE RULE — this is mandatory: you MUST speak and respond in Japanese at all "
        "times throughout this session, including your goodbye. Never switch to English."
    ) if language == "ja" else ""
    return intro + tts + body + conduct + ending_rule + lang_rule


def build_greeting(role: str, has_questions: bool = False, scenario: str = "job",
                   language: str = "en") -> str:
    if language == "ja":
        if scenario != "job":
            return SCENARIO_GREETING_JA.get(scenario, SCENARIO_GREETING_JA["present"])
        role_ja = role or "一般"
        if has_questions:
            return (f"こんにちは。本日は面接にお越しいただきありがとうございます。"
                    f"{role_ja}のポジションの面接を始めましょう。")
        return (f"こんにちは。本日は面接にお越しいただきありがとうございます。"
                f"{role_ja}のポジションについてお話しします。"
                f"準備ができましたら、まず自己紹介をお願いします。")
    if scenario != "job":
        # Non-job scenarios don't use the self-intro-as-Q1 pattern, so the same
        # greeting works for both bound and improv mode.
        return SCENARIO_GREETING.get(scenario, SCENARIO_GREETING["present"])
    if has_questions:
        # Bound mode: the first listed question is asked by the model, so the greeting must
        # NOT also ask for a self-introduction (that would duplicate / conflict).
        return (f"Hi, thanks for joining. I'll be interviewing you for the "
                f"{role} role today. Let's get started.")
    return (f"Hi, thanks for joining. I'll be interviewing you for the {role} role today. "
            f"Whenever you're ready, tell me a little about yourself.")


def build_agent_config(role: str, focus: str = "Mixed", difficulty: str = "Realistic",
                       question_count: int = 5, questions=None,
                       tone: str = "Professional", scenario: str = "job",
                       language: str = "en") -> dict:
    """Deepgram Voice Agent Settings payload (sent as first WS message)."""
    keyterms = ["STAR", "behavioral", "strengths", "weaknesses"]
    if role:
        keyterms.append(role)
    voice_map = TONE_VOICE_JA if language == "ja" else TONE_VOICE
    speak_model = voice_map.get(tone, "aura-2-fujin-ja" if language == "ja" else TTS_MODEL)
    return {
        "type": "Settings",
        "audio": {
            "input": {"encoding": "linear16", "sample_rate": 48000},
            "output": {"encoding": "linear16", "sample_rate": 24000, "container": "none"},
        },
        "agent": {
            "language": language,
            "listen": {"provider": {"type": "deepgram", "model": "nova-3",
                                    "language": language, "keyterms": keyterms}},
            "think": {
                "provider": {"type": "anthropic", "model": THINK_MODEL},
                "prompt": build_interviewer_prompt(role, focus, difficulty, question_count,
                                                   questions, tone, scenario, language),
                # Client-side function (no server endpoint) the interviewer calls when the
                # session is over. The browser ACKs it and closes the socket, which ends
                # and scores the session. Without this the agent never stops on its own.
                "functions": [{
                    "name": "end_interview",
                    "description": (
                        "End the session. You MUST call this immediately after saying your "
                        "goodbye, once the candidate has answered the final question. "
                        "Do not call it before all questions are done. "
                        "Do not continue speaking after calling it."
                    ),
                    "parameters": {"type": "object", "properties": {}},
                }],
            },
            "speak": {"provider": {"type": "deepgram", "model": speak_model}},
            "greeting": build_greeting(role, bool(questions), scenario, language),
        },
    }


async def grant_ephemeral_token(api_key: str, ttl_seconds: int = 300) -> str:
    """Mint a short-lived Deepgram token; the long-lived key never leaves the server."""
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.post(
            "https://api.deepgram.com/v1/auth/grant",
            headers={"Authorization": f"Token {api_key}"},
            json={"ttl_seconds": ttl_seconds},
        )
        resp.raise_for_status()
        return resp.json()["access_token"]
