"""
Simple in-memory job store for background LLM processing tasks.
Jobs expire after 10 minutes; eviction runs on each create_job() call.
"""
import uuid
from datetime import datetime, timezone, timedelta
from typing import Any

_jobs: dict[str, dict[str, Any]] = {}
_TTL = timedelta(minutes=10)


def create_job() -> str:
    """Register a new pending job and return its ID."""
    job_id = str(uuid.uuid4())
    _jobs[job_id] = {
        "status": "pending",
        "result": None,
        "error": None,
        "ts": datetime.now(timezone.utc),
    }
    _evict()
    return job_id


def complete_job(job_id: str, result: Any) -> None:
    if job_id in _jobs:
        _jobs[job_id].update(status="complete", result=result)


def fail_job(job_id: str, error: str) -> None:
    if job_id in _jobs:
        _jobs[job_id].update(status="error", error=error)


def get_job(job_id: str) -> dict[str, Any] | None:
    job = _jobs.get(job_id)
    if job is None:
        return None
    if datetime.now(timezone.utc) - job["ts"] > _TTL:
        del _jobs[job_id]
        return None
    return job


def _evict() -> None:
    cutoff = datetime.now(timezone.utc) - _TTL
    stale = [k for k, v in _jobs.items() if v["ts"] < cutoff]
    for k in stale:
        del _jobs[k]
