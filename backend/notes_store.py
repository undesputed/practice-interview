# backend/notes_store.py
"""S3-backed single master notebook. One notebook per deployment, persists
across all interview sessions. Same storage.py pattern as sessions_store.py.

  notes/master.json  — the one notebook (title + pages list)
"""
from __future__ import annotations
import json
import logging
from datetime import datetime

from backend import storage

MASTER_KEY = "notes/master.json"
PAGE_COUNT  = 10  # free-tier page cap


def _empty() -> dict:
    return {
        "title":      "My Notebook",
        "pages":      [[] for _ in range(PAGE_COUNT)],
        "note_count": 0,
        "updated_at": None,
    }


def load_master() -> dict:
    """Load the master notebook, or return a fresh empty one."""
    data = storage.get_bytes(MASTER_KEY)
    if data is None:
        return _empty()
    try:
        nb = json.loads(data)
        # Pad pages to PAGE_COUNT in case stored data is shorter
        pages = nb.get("pages") or []
        while len(pages) < PAGE_COUNT:
            pages.append([])
        nb["pages"] = pages
        return nb
    except ValueError:
        return _empty()


def save_master(title: str, pages: list) -> None:
    """Overwrite the master notebook with the supplied pages."""
    # Clamp to PAGE_COUNT pages (future: lift this for paid tiers)
    pages = list(pages[:PAGE_COUNT])
    while len(pages) < PAGE_COUNT:
        pages.append([])
    doc = {
        "title":      title or "My Notebook",
        "pages":      pages,
        "note_count": sum(len(p) for p in pages if p),
        "updated_at": datetime.utcnow().isoformat(),
    }
    storage.put(
        MASTER_KEY,
        json.dumps(doc, ensure_ascii=False).encode("utf-8"),
        "application/json",
    )
    logging.info("notes: master saved (%d notes)", doc["note_count"])


def clear_master() -> None:
    """Reset to an empty notebook (used for testing / manual clear)."""
    save_master("My Notebook", [[] for _ in range(PAGE_COUNT)])
