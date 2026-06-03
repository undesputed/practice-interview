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
