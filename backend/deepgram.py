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
    "negotiate": "You are the other party in a negotiation helping the candidate practise{role_ctx}.",
    "case":     "You are a case interviewer evaluating the candidate's structured thinking and problem-solving{role_ctx}.",
}

# Reactive-mode body text per non-job scenario.
# All non-job scenarios put the AI in listener/participant mode: it responds to what the
# candidate actually says rather than working through a preset question list.
SCENARIO_REACTIVE_BODY = {
    "present": (
        "The session has already started. The candidate is about to deliver their presentation. "
        "Your job is to listen attentively. Do NOT interrupt with pre-planned questions. "
        "Only speak when the candidate pauses naturally between sections — ask one brief "
        "question that is directly about the specific content they just presented "
        "(e.g. 'Could you say more about X?', 'What did you mean by Y?'). "
        "Never ask generic questions unrelated to what was just said. "
        "Keep your turns to 1-2 sentences. "
        "When the candidate signals they have finished "
        "(e.g. 'that's the end', 'any questions?', or clearly wraps up their conclusion), "
        "give one brief acknowledgement sentence, then immediately call end_interview. "
    ),
    "negotiate": (
        "The session has already started. You are the other party in a negotiation — "
        "play this role realistically. React to exactly what the candidate just said: "
        "push back on requests that seem too aggressive, ask them to justify their position, "
        "offer counter-proposals, and hold firm on key points a real counterpart would defend. "
        "Do NOT follow a script or ignore what they said. "
        "Keep your turns to 2-3 sentences. "
        "When the negotiation reaches an agreement or the candidate signals they are done, "
        "give one brief closing statement, then call end_interview. "
    ),
    "pitch": (
        "The session has already started. The candidate is about to deliver their pitch. "
        "Your job is to listen as a potential investor or client. Do NOT ask pre-planned questions. "
        "Only speak when the candidate pauses — ask one brief question grounded in specific "
        "details they just mentioned (e.g. 'You mentioned X — what is the market size there?', "
        "'How do you differentiate from the competitor you described?'). "
        "Never ask generic investor questions disconnected from what was just pitched. "
        "Keep your turns to 1-2 sentences. "
        "When the candidate finishes their pitch or signals they are done, "
        "give one brief response, then call end_interview. "
    ),
    "tough": (
        "The session has already started. You are role-playing as the other party in a "
        "tough, high-stakes conversation. React authentically to exactly what the candidate "
        "just said — push back, ask for clarification, or express concern as a real person "
        "in this situation would. Do NOT follow a pre-set script or ignore what the candidate said. "
        "Respond directly to the substance of their last statement. "
        "Keep your turns to 2-3 sentences. "
        "When the conversation reaches a natural close or the candidate clearly signals they "
        "are done, give one brief closing sentence, then call end_interview. "
    ),
    "case": (
        "The session has just started. Open immediately by presenting a realistic business case "
        "problem in 2-3 sentences (e.g. 'A retail chain's profits dropped 20% year-on-year — "
        "the CEO wants to know why and what to do about it'). Make the case relevant to the "
        "role if one was given. Then listen as the candidate structures their answer. "
        "React to exactly what they say: probe their reasoning, ask what data they would need, "
        "challenge weak assumptions, and redirect if they go off track. "
        "Never ask generic questions disconnected from their last statement. "
        "Keep your turns to 1-3 sentences. "
        "When the candidate has worked through the case or signals they are done, "
        "give one brief closing statement, then call end_interview. "
    ),
}

# Human-readable description of each scenario's ending condition (used in the ending_rule prompt).
SCENARIO_ENDING_DESC = {
    "present": "presentation or clearly signals they are done",
    "negotiate": "negotiation or clearly signals they are done",
    "pitch":   "pitch or clearly signals they are done",
    "tough":   "conversation or clearly signals they are done",
    "case":     "case or clearly signals they are done",
}

# Scenario -> opening greeting. Non-job scenarios don't use the self-intro-as-Q1 pattern.
SCENARIO_GREETING = {
    "present":  "Hi, thanks for joining. Whenever you're ready, go ahead and start.",
    "tough":    "Hi, thanks for joining. I'll play the other party here — let's begin whenever you're ready.",
    "pitch":    "Hi, thanks for your time. Whenever you're ready, go ahead with your pitch.",
    "negotiate": "Hi, I'm ready when you are. Go ahead and make your opening statement.",
    "case":     "Hi, thanks for joining. I'll be presenting you with a business case today. Ready when you are.",
}

SCENARIO_GREETING_JA = {
    "present":  "こんにちは。準備ができましたら、プレゼンテーションを始めてください。",
    "tough":    "こんにちは。私が相手役を担当します。準備ができましたらどうぞ。",
    "pitch":    "こんにちは。お時間をいただきありがとうございます。準備ができましたらピッチをお願いします。",
    "negotiate": "こんにちは。準備ができましたら、交渉を始めてください。",
    "case":     "こんにちは。本日はケース面接を行います。準備ができましたら始めましょう。",
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
    "Friendly":     "aura-2-amalthea-en",  # female, warm
    "Professional": "aura-2-thalia-en",    # female, balanced
    "Stern":        "aura-2-hera-en",      # female, authoritative
    "Intimidating": "aura-2-athena-en",    # female, commanding
}

# Japanese Aura-2 voices by tone.
TONE_VOICE_JA = {
    "Friendly":     "aura-2-ama-ja",   # female
    "Professional": "aura-2-izanami-ja",        # female
    "Stern":        "aura-2-uzume-ja",      # female
    "Intimidating": "aura-2-uzume-ja",      # female
}


def build_interviewer_prompt(role: str, focus: str = "Mixed", difficulty: str = "Realistic",
                             question_count: int = 5, questions=None,
                             tone: str = "Professional", scenario: str = "job",
                             language: str = "en") -> str:
    """System prompt for the Claude 'think' provider. In 'bound mode' (a question list is
    given) the interviewer asks those exact questions in order; otherwise it improvises.
    The `scenario` controls the AI persona and session framing. Non-job scenarios use
    reactive mode: the AI responds to what the candidate says rather than a preset list."""
    # Non-job scenarios: AI listens and responds to content, never uses a preset question list.
    reactive_mode = scenario != "job"
    lang_line = ("Conduct the entire interview in Japanese. Ask all questions in Japanese "
                 "and respond only in Japanese — even if the candidate speaks English or "
                 "any other language, always reply in Japanese. Never switch to English. ") if language == "ja" else ""
    if reactive_mode:
        # Focus/difficulty concepts don't apply the same way; behavioral guidance lives in body.
        focus_line = ""
        difficulty_line = ""
    else:
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
    if reactive_mode:
        body = SCENARIO_REACTIVE_BODY.get(scenario, SCENARIO_REACTIVE_BODY["present"])
        ending_desc = SCENARIO_ENDING_DESC.get(scenario, "session or clearly signals they are done")
        n = None
    elif questions:
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
        body = (f"The {session_word} is already in progress: you have greeted the candidate "
                f"and asked them to tell you about themselves, which counts as question 1 of "
                f"{n}. The candidate's first message is their answer to question 1, so do NOT "
                f"greet again, do NOT ask them to introduce themselves again, and never say "
                f"things like 'let's start' or 'let's begin' — it has already begun. "
                f"Ask exactly {n} question{plural} total, keeping a private running count. "
                f"A brief clarifying follow-up does not count as a new question. After each "
                f"main answer, move directly to the next unanswered question. Never restart "
                f"or re-ask a question. ")
    conduct = ("Keep your turns short (1-3 sentences). Do not give feedback or coaching during "
               "the session. "
               "If the candidate says 'note this', 'write this down', 'remember this', or "
               "asks you to take a note, call take_note with the key content before replying. "
               "If the candidate specifies a page number (e.g. 'note this on page 2'), "
               "include that number in the page field of take_note. ")
    # Make the ending rule a clearly labelled, mandatory instruction so Claude doesn't skip it.
    if reactive_mode:
        ending_rule = (
            f"ENDING THE SESSION — this is mandatory: once the candidate finishes their "
            f"{ending_desc}, say one brief farewell sentence, "
            f"then IMMEDIATELY call end_interview. You MUST call end_interview — the session "
            f"cannot close without it. Do not ask another question after they finish. "
            f"Do not say anything after calling end_interview."
        )
    else:
        ending_rule = (
            f"ENDING THE SESSION — this is mandatory: after the candidate answers your {n}th and "
            f"final question, say a brief goodbye in one sentence, then IMMEDIATELY call "
            f"end_interview. You MUST call end_interview — the session cannot close without it. "
            f"Do not ask another question. Do not offer feedback. Do not say anything after "
            f"calling end_interview."
        )
    lang_rule = (
        " LANGUAGE RULE — this is mandatory: you MUST respond in Japanese at all times, "
        "including your goodbye. If the candidate speaks English or any other language, "
        "you still reply in Japanese only. Never switch to or use English under any "
        "circumstances."
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
    speak_model = voice_map.get(tone, "aura-2-izanami-ja" if language == "ja" else TTS_MODEL)
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
                "functions": [
                    {
                        "name": "end_interview",
                        "description": (
                            "End the session. You MUST call this immediately after saying your "
                            "goodbye, once the candidate has answered the final question. "
                            "Do not call it before all questions are done. "
                            "Do not continue speaking after calling it."
                        ),
                        "parameters": {"type": "object", "properties": {}},
                    },
                    {
                        "name": "take_note",
                        "description": (
                            "Add a note to the candidate's in-session notebook. Call this when "
                            "the candidate explicitly asks you to note, write down, or remember "
                            "something. Extract only the key content they want recorded."
                        ),
                        "parameters": {
                            "type": "object",
                            "properties": {
                                "content": {
                                    "type": "string",
                                    "description": "The note content to add to the notebook.",
                                },
                                "page": {
                                    "type": "integer",
                                    "description": "Page number 1-10 to write the note on. Only set when the candidate explicitly says a page number.",
                                },
                            },
                            "required": ["content"],
                        },
                    },
                ],
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
