"""Read-back access to saved interview sessions on disk.

Each session is a directory under a sessions root, named with its creation
timestamp ("%Y-%m-%dT%H%M%S") and containing a summary.json.
"""
import json
import os
import re
import shutil
from datetime import datetime

# Session ids are timestamps like "2026-06-09T114547". Matching this regex both
# parses the date and blocks path traversal — no slashes, dots, or "..". \Z (not
# $) anchors the very end, so a trailing newline can't sneak through the guard.
_ID_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{6}\Z")


def _created_at(session_id):
    """ISO-8601 creation time parsed from the id, or None if unparseable."""
    try:
        return datetime.strptime(session_id, "%Y-%m-%dT%H%M%S").isoformat()
    except ValueError:
        return None


def _safe_dir(sessions_dir, session_id):
    """Absolute path to a session dir, or None if the id is invalid or absent.
    Rejecting anything that isn't a plain session id prevents path traversal."""
    if not session_id or not _ID_RE.match(session_id):
        return None
    path = os.path.join(sessions_dir, session_id)
    return path if os.path.isdir(path) else None


def _read_summary(path):
    try:
        with open(os.path.join(path, "summary.json"), encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return None


def list_sessions(sessions_dir):
    """All sessions as compact rows, newest first. Skips unreadable dirs."""
    rows = []
    if not os.path.isdir(sessions_dir):
        return rows
    for name in os.listdir(sessions_dir):
        if not _ID_RE.match(name):
            continue
        summary = _read_summary(os.path.join(sessions_dir, name))
        if summary is None:
            continue
        overall = summary.get("overall") or {}
        rows.append({
            "id": name,
            "created_at": _created_at(name),
            "role": summary.get("role"),
            "label": summary.get("label"),
            "duration_sec": summary.get("duration_sec"),
            "question_count": len(summary.get("per_question") or []),
            "scores": {
                "attention": overall.get("attention"),
                "confidence": overall.get("confidence"),
                "nervousness": overall.get("nervousness"),
                "composure": overall.get("composure"),
            },
        })
    rows.sort(key=lambda r: r["id"], reverse=True)
    return rows


def load_session(sessions_dir, session_id):
    """Full summary.json for one session (plus derived id/created_at), or None."""
    path = _safe_dir(sessions_dir, session_id)
    if path is None:
        return None
    summary = _read_summary(path)
    if summary is None:
        return None
    summary.setdefault("id", session_id)
    summary.setdefault("created_at", _created_at(session_id))
    return summary


def delete_session(sessions_dir, session_id):
    """Delete a session dir. True if removed, False if id invalid or absent."""
    path = _safe_dir(sessions_dir, session_id)
    if path is None:
        return False
    shutil.rmtree(path)
    return True


def set_label(sessions_dir, session_id, label):
    """Persist a friendly label into summary.json. Returns updated summary, or
    None if the session does not exist."""
    path = _safe_dir(sessions_dir, session_id)
    if path is None:
        return None
    summary = _read_summary(path)
    if summary is None:
        return None
    summary["label"] = label
    with open(os.path.join(path, "summary.json"), "w", encoding="utf-8") as fh:
        json.dump(summary, fh, indent=2)
    return summary
