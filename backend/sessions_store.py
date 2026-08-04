"""Read-back access to saved interview sessions on S3.

Sessions are indexed in sessions/index.json — listing costs one S3 GET instead
of N+1. The index is updated on every save / delete / rename. If the index is
missing (first run or migration), list_sessions falls back to scanning all
session prefixes and rebuilds it automatically.
"""
from __future__ import annotations
import json
import re
from datetime import datetime
from backend import storage

_ID_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{6}\Z")


def _created_at(session_id: str) -> str | None:
    try:
        return datetime.strptime(session_id, "%Y-%m-%dT%H%M%S").isoformat()
    except ValueError:
        return None


def _valid_id(session_id: str) -> bool:
    return bool(session_id and _ID_RE.match(session_id))


def _read_summary(session_id: str) -> dict | None:
    data = storage.get_bytes(f"sessions/{session_id}/summary.json")
    if data is None:
        return None
    try:
        return json.loads(data)
    except ValueError:
        return None


def _scan_all() -> list[dict]:
    """Full N+1 S3 scan — used only when the index is missing."""
    rows = []
    for sid in storage.list_session_ids():
        summary = _read_summary(sid)
        if summary is None:
            continue
        rows.append(_compact(sid, summary))
    rows.sort(key=lambda r: r["id"], reverse=True)
    return rows


def _compact(session_id: str, summary: dict) -> dict:
    overall = summary.get("overall") or {}
    verdict = summary.get("verdict") or {}
    return {
        "id": session_id,
        "created_at": _created_at(session_id),
        "role": summary.get("role"),
        "label": summary.get("label"),
        "duration_sec": summary.get("duration_sec"),
        "question_count": len(summary.get("per_question") or []),
        "scores": {
            "attention":   overall.get("attention"),
            "confidence":  overall.get("confidence"),
            "nervousness": overall.get("nervousness"),
            "composure":   overall.get("composure"),
        },
        "readiness": {
            "score": verdict.get("readiness_score"),
            "band":  verdict.get("band"),
        },
    }


def list_sessions(_sessions_dir=None) -> list[dict]:
    """All sessions newest-first — reads index.json (1 GET) or scans if missing."""
    index = storage.get_index()
    if index:
        return sorted(index, key=lambda r: r["id"], reverse=True)
    # Index missing — scan S3 and build it for next time.
    rows = _scan_all()
    if rows:
        storage.put_index(rows)
    return rows


def load_session(_sessions_dir, session_id: str) -> dict | None:
    """Full summary for one session, or None if not found / invalid id."""
    if not _valid_id(session_id):
        return None
    summary = _read_summary(session_id)
    if summary is None:
        return None
    summary.setdefault("id", session_id)
    summary.setdefault("created_at", _created_at(session_id))
    return summary


def delete_session(_sessions_dir, session_id: str) -> bool:
    """Delete all S3 objects for a session and remove it from the index."""
    if not _valid_id(session_id):
        return False
    if _read_summary(session_id) is None:
        return False
    storage.delete_prefix(f"sessions/{session_id}/")
    index = [e for e in storage.get_index() if e.get("id") != session_id]
    storage.put_index(index)
    return True


def set_label(_sessions_dir, session_id: str, label: str) -> dict | None:
    """Persist a friendly label. Returns updated summary, or None if not found."""
    if not _valid_id(session_id):
        return None
    summary = _read_summary(session_id)
    if summary is None:
        return None
    summary["label"] = label
    storage.put(
        f"sessions/{session_id}/summary.json",
        json.dumps(summary, indent=2).encode(),
        "application/json",
    )
    # Update the label in the index too.
    index = storage.get_index()
    for entry in index:
        if entry.get("id") == session_id:
            entry["label"] = label
            break
    storage.put_index(index)
    return summary


def update_summary(_sessions_dir, session_id: str, patch: dict) -> dict | None:
    """Merge `patch` into the saved summary.json and return the updated summary."""
    if not _valid_id(session_id):
        return None
    summary = _read_summary(session_id)
    if summary is None:
        return None
    summary.update(patch)
    storage.put(
        f"sessions/{session_id}/summary.json",
        json.dumps(summary, indent=2, ensure_ascii=False).encode(),
        "application/json",
    )
    return summary


def add_to_index(session_id: str, summary: dict) -> None:
    """Prepend a new session to the index. Called by report.save_session."""
    entry = _compact(session_id, summary)
    index = storage.get_index()
    index = [e for e in index if e.get("id") != session_id]  # dedupe
    index.insert(0, entry)
    storage.put_index(index)
