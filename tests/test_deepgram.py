from backend.deepgram import build_agent_config, build_greeting

def test_agent_config_has_required_sections():
    cfg = build_agent_config("Software Engineer")
    assert cfg["type"] == "Settings"
    assert cfg["agent"]["listen"]["provider"]["model"] == "nova-3"
    assert cfg["agent"]["think"]["provider"]["type"] == "anthropic"
    assert cfg["agent"]["speak"]["provider"]["model"].startswith("aura-2")
    # the role must appear in the interviewer system prompt
    assert "Software Engineer" in cfg["agent"]["think"]["prompt"]

def test_greeting_mentions_interview():
    assert "interview" in build_greeting("Software Engineer").lower()

def test_agent_config_includes_keyterms_with_role():
    cfg = build_agent_config("Data Analyst")
    kt = cfg["agent"]["listen"]["provider"].get("keyterms")
    assert isinstance(kt, list)
    assert "Data Analyst" in kt        # role is boosted
    assert "STAR" in kt                # generic interview term


def test_prompt_reflects_question_count_exactly():
    prompt = build_agent_config("Software Engineer", question_count=8)["agent"]["think"]["prompt"]
    assert "exactly 8 questions" in prompt


def test_prompt_reflects_focus_and_difficulty():
    prompt = build_agent_config("Software Engineer", focus="Technical", difficulty="Hard",
                                question_count=4)["agent"]["think"]["prompt"]
    assert "technical" in prompt.lower()    # Technical focus guidance
    assert "rigorous" in prompt.lower()     # Hard difficulty guidance
    assert "exactly 4 questions" in prompt


def test_defaults_keep_single_arg_call_working():
    # Direct /live visits and old callers pass only the role; defaults must fill the rest.
    prompt = build_agent_config("Product Manager")["agent"]["think"]["prompt"]
    assert "Product Manager" in prompt
    assert "exactly 5 questions" in prompt  # default question_count


def test_agent_config_defines_end_interview_function():
    # The interviewer must have a client-side end_interview function to call when done,
    # so the browser can close the socket and route to the report (otherwise it loops).
    cfg = build_agent_config("Software Engineer")
    fns = cfg["agent"]["think"].get("functions")
    assert isinstance(fns, list) and fns, "think.functions must be defined"
    end = next((f for f in fns if f.get("name") == "end_interview"), None)
    assert end is not None, "end_interview function must be defined"
    assert end["parameters"]["type"] == "object"


def test_prompt_instructs_calling_end_interview():
    prompt = build_agent_config("Software Engineer")["agent"]["think"]["prompt"]
    assert "end_interview" in prompt
