# backend/storage.py
"""Thin boto3 wrapper for S3-backed session storage."""
from __future__ import annotations
import json
import logging
import os
import re
import boto3
from botocore.exceptions import ClientError

_ID_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{6}\Z")


def _client():
    return boto3.client(
        "s3",
        region_name=os.getenv("AWS_REGION", "us-east-1"),
        aws_access_key_id=os.getenv("AWS_ACCESS_KEY_ID"),
        aws_secret_access_key=os.getenv("AWS_SECRET_ACCESS_KEY"),
    )


def _bucket() -> str:
    b = os.getenv("AWS_S3_BUCKET")
    if not b:
        raise RuntimeError("AWS_S3_BUCKET is not set")
    return b


def put(key: str, body: bytes, content_type: str = "application/octet-stream") -> None:
    _client().put_object(Bucket=_bucket(), Key=key, Body=body, ContentType=content_type)


def get_bytes(key: str) -> bytes | None:
    try:
        return _client().get_object(Bucket=_bucket(), Key=key)["Body"].read()
    except ClientError as e:
        if e.response["Error"]["Code"] in ("NoSuchKey", "404", "NoSuchBucket"):
            return None
        raise


def delete_prefix(prefix: str) -> None:
    client = _client()
    bucket = _bucket()
    paginator = client.get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=bucket, Prefix=prefix):
        for obj in page.get("Contents", []):
            client.delete_object(Bucket=bucket, Key=obj["Key"])


_INDEX_KEY = "sessions/index.json"


def get_index() -> list[dict]:
    """Read the session manifest (1 GET). Returns [] if not yet created."""
    data = get_bytes(_INDEX_KEY)
    if data is None:
        return []
    try:
        return json.loads(data)
    except ValueError:
        return []


def put_index(entries: list[dict]) -> None:
    put(_INDEX_KEY, json.dumps(entries, separators=(",", ":")).encode(), "application/json")


def list_session_ids() -> list[str]:
    """Return all valid session IDs stored under the sessions/ prefix."""
    client = _client()
    paginator = client.get_paginator("list_objects_v2")
    ids: list[str] = []
    try:
        for page in paginator.paginate(Bucket=_bucket(), Prefix="sessions/", Delimiter="/"):
            for p in page.get("CommonPrefixes", []):
                sid = p["Prefix"].rstrip("/").split("/")[-1]
                if _ID_RE.match(sid):
                    ids.append(sid)
    except ClientError as exc:
        logging.warning("S3 list_session_ids failed: %s", exc)
    return ids
