import json
import os
from backend import sessions_store


def _make_session(root, sid, role="Software Engineer", scores=None, questions=2, label=None):
    d = os.path.join(root, sid)
    os.makedirs(d, exist_ok=True)
    scores = scores or {"attention": 70, "confidence": 65, "nervousness": 30, "composure": 80}
    summary = {
        "role": role,
        "duration_sec": 52.4,
        "overall": scores,
        "per_question": [{"turn": i} for i in range(questions)],
    }
    if label is not None:
        summary["label"] = label
    with open(os.path.join(d, "summary.json"), "w") as fh:
        json.dump(summary, fh)
    return d


def test_list_sessions_newest_first(tmp_path):
    root = str(tmp_path)
    _make_session(root, "2026-06-01T100000", role="A")
    _make_session(root, "2026-06-03T100000", role="B")
    rows = sessions_store.list_sessions(root)
    assert [r["id"] for r in rows] == ["2026-06-03T100000", "2026-06-01T100000"]
    assert rows[0]["role"] == "B"
    assert rows[0]["question_count"] == 2
    assert rows[0]["scores"]["attention"] == 70
    assert rows[0]["created_at"] == "2026-06-03T10:00:00"


def test_list_skips_non_session_dirs_and_bad_json(tmp_path):
    root = str(tmp_path)
    _make_session(root, "2026-06-01T100000")
    os.makedirs(os.path.join(root, "not-a-session"), exist_ok=True)        # wrong name
    bad = os.path.join(root, "2026-06-02T100000")
    os.makedirs(bad, exist_ok=True)
    with open(os.path.join(bad, "summary.json"), "w") as fh:
        fh.write("{ broken json")
    rows = sessions_store.list_sessions(root)
    assert [r["id"] for r in rows] == ["2026-06-01T100000"]


def test_list_missing_root_returns_empty(tmp_path):
    assert sessions_store.list_sessions(str(tmp_path / "nope")) == []


def test_load_session_returns_full_summary(tmp_path):
    root = str(tmp_path)
    _make_session(root, "2026-06-01T100000", role="A")
    data = sessions_store.load_session(root, "2026-06-01T100000")
    assert data["role"] == "A"
    assert data["id"] == "2026-06-01T100000"
    assert data["overall"]["confidence"] == 65


def test_load_missing_returns_none(tmp_path):
    assert sessions_store.load_session(str(tmp_path), "2026-06-01T100000") is None


def test_invalid_id_is_rejected_path_traversal(tmp_path):
    # An id that isn't a clean timestamp must never resolve to a path.
    for bad in ("../secret", "..", "foo/bar", "2026-06-01T100000/../x", "",
                "2026-06-01T100000\n"):  # trailing newline must not pass the guard
        assert sessions_store.load_session(str(tmp_path), bad) is None
        assert sessions_store.delete_session(str(tmp_path), bad) is False


def test_delete_session(tmp_path):
    root = str(tmp_path)
    _make_session(root, "2026-06-01T100000")
    assert sessions_store.delete_session(root, "2026-06-01T100000") is True
    assert not os.path.exists(os.path.join(root, "2026-06-01T100000"))
    assert sessions_store.delete_session(root, "2026-06-01T100000") is False


def test_set_label_persists(tmp_path):
    root = str(tmp_path)
    _make_session(root, "2026-06-01T100000")
    updated = sessions_store.set_label(root, "2026-06-01T100000", "Mock #1")
    assert updated["label"] == "Mock #1"
    reread = sessions_store.load_session(root, "2026-06-01T100000")
    assert reread["label"] == "Mock #1"


def test_set_label_missing_returns_none(tmp_path):
    assert sessions_store.set_label(str(tmp_path), "2026-06-01T100000", "x") is None
