"""
Activities endpoints (HubSpot tasks with cache).
List, get, create, update, delete, complete, force-sync, process-notes, submit.
"""

import hashlib
import logging
import re
from datetime import datetime, timezone, timedelta
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, status

from app.core.security import get_current_user_id
from app.schemas.activity import (
    ActivityCreate,
    ActivityListResponse,
    ActivityResponse,
    ActivitySortOption,
    ActivitySubmitRequest,
    ActivityUpdate,
    CommunicationSummaryResponse,
    CompanyInfo,
    ContactInfo,
    CreateAndSubmitResponse,
    DraftOut,
    ExtractedMetadataOut,
    GenerateEmailDraftsRequest,
    GenerateEmailDraftsResponse,
    ProcessDraftRequest,
    ProcessNotesRequest,
    ProcessNotesResponse,
    RecognisedDateOut,
    RecommendedTouchDateOut,
    RegenerateDraftRequest,
    SyncStatusResponse,
    _hubspot_priority,
    _response_priority,
)
from app.schemas.common import MessageResponse
from app.services.claude_agents import (
    extract_metadata,
    extract_recognised_date,
    generate_communication_summary,
    generate_drafts,
    generate_email_drafts,
    recommend_touch_date,
    regenerate_single_draft,
    summarize_communication_history,
)
from app.services.gmail_service import get_gmail_user_display_name
from app.services.hubspot_service import HubSpotService, HubSpotServiceError, get_hubspot_service
from app.services.supabase_service import SupabaseService, get_supabase_service

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/activities", tags=["activities"])

# Cache considered fresh if last_synced_at within this many seconds
CACHE_FRESH_SECONDS = 300  # 5 minutes

# HubSpot task property names
HS_SUBJECT = "hs_task_subject"
HS_BODY = "hs_task_body"
HS_TIMESTAMP = "hs_timestamp"
HS_STATUS = "hs_task_status"
HS_PRIORITY = "hs_task_priority"
HS_TYPE = "hs_task_type"


def _normalize_notes_body(body: str) -> str:
    """Ensure each note (date - ...) is separated by a blank line for readability."""
    if not body or not body.strip():
        return body.strip() if body else ""
    # Split before date prefixes (MM/DD/YY or M/D/YY etc.); require not after a digit so we don't split "02" into "0" and "2"
    parts = re.split(r"(?<!\d)(?=\d{1,2}/\d{1,2}/\d{2,4} - )", body)
    parts = [p.strip() for p in parts if p.strip()]
    return "\n\n".join(parts)


def _parse_ts(value: str | int | None) -> datetime | None:
    """Parse HubSpot timestamp: milliseconds since epoch or ISO 8601 string."""
    if value is None:
        return None
    try:
        if isinstance(value, str):
            value = value.strip()
            if not value:
                return None
            # ISO 8601 (e.g. "2026-02-11T19:00:00.000Z")
            if value[0:1].isdigit() and ("T" in value or "-" in value):
                dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
                return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
            # Milliseconds as string
            ms = int(value)
        else:
            ms = int(value)
        return datetime.fromtimestamp(ms / 1000.0, tz=timezone.utc)
    except (ValueError, TypeError):
        return None


def _hubspot_task_to_activity(task: dict[str, Any]) -> dict[str, Any]:
    """Transform a HubSpot task object to our activity format.
    due_date = task due date (hs_timestamp).
    updated_at = last modified / last touch (HubSpot updatedAt or hs_lastmodifieddate).
    """
    tid = task.get("id") or ""
    props = task.get("properties") or {}
    due = _parse_ts(props.get(HS_TIMESTAMP))
    # Last touch = last modified: root updatedAt or property hs_lastmodifieddate
    updated = _parse_ts(task.get("updatedAt")) or _parse_ts(props.get("hs_lastmodifieddate"))
    created = _parse_ts(task.get("createdAt")) or _parse_ts(props.get("hs_createdate"))
    status_val = (props.get(HS_STATUS) or "").upper()
    completed = status_val == "COMPLETED"
    # Contact/company IDs from associations if present
    contact_ids: list[str] = []
    company_ids: list[str] = []
    assoc = task.get("associations")
    if assoc:
        contact_ids = [str(a.get("id")) for a in assoc.get("contacts", {}).get("results", []) if a.get("id")]
        company_ids = [str(a.get("id")) for a in assoc.get("companies", {}).get("results", []) if a.get("id")]
    # [CONTACT_DEBUG] Log when task has no contact_ids from associations (helps trace "Unknown" contact on dashboard)
    if not contact_ids and task.get("id"):
        assoc_info = list(assoc.keys()) if isinstance(assoc, dict) else (type(assoc).__name__ if assoc is not None else "None")
        logger.info(
            "[contact_debug] task %s has no contact_ids from associations; associations=%s",
            task.get("id"),
            assoc_info,
        )

    raw_body = (props.get(HS_BODY) or "").strip()
    body = _normalize_notes_body(raw_body) if raw_body else None
    return {
        "id": tid,
        "hubspot_id": tid,
        "type": props.get(HS_TYPE) or None,
        "subject": props.get(HS_SUBJECT) or None,
        "body": body,
        "due_date": due,
        "completed": completed,
        "contact_ids": contact_ids,
        "company_ids": company_ids,
        "created_at": created,
        "updated_at": updated,
        "contacts": [],
        "companies": [],
        "_priority": props.get(HS_PRIORITY) or "",
        "_raw": task,
    }


def _apply_filters(
    activities: list[dict[str, Any]],
    date: str | None,
    relationship_status: list[str] | None,
    processing_status: list[str] | None,
    date_from: str | None,
    date_to: str | None,
) -> list[dict[str, Any]]:
    """Filter activities by query params. date is YYYY-MM-DD."""
    out = activities
    if date:
        try:
            target = datetime.strptime(date, "%Y-%m-%d").date()
            out = [
                a for a in out
                if a.get("due_date") and a["due_date"].date() == target
            ]
        except ValueError:
            pass
    if date_from:
        try:
            start = datetime.strptime(date_from, "%Y-%m-%d").replace(tzinfo=timezone.utc)
            out = [a for a in out if a.get("due_date") and a["due_date"] >= start]
        except ValueError:
            pass
    if date_to:
        try:
            end = datetime.strptime(date_to, "%Y-%m-%d").replace(hour=23, minute=59, second=59, tzinfo=timezone.utc)
            out = [a for a in out if a.get("due_date") and a["due_date"] <= end]
        except ValueError:
            pass
    if relationship_status:
        # If we had a relationship_status field we'd filter; placeholder.
        pass
    if processing_status:
        # If we had processing_status we'd filter; placeholder.
        pass
    return out


def _apply_sort(activities: list[dict[str, Any]], sort: ActivitySortOption) -> list[dict[str, Any]]:
    """Sort activities by sort option (due date, last touch, or priority)."""
    key_priority = {"HIGH": 3, "MEDIUM": 2, "LOW": 1, "": 0}
    min_ts = datetime.min.replace(tzinfo=timezone.utc).timestamp()
    max_ts = datetime.max.replace(tzinfo=timezone.utc).timestamp()

    def _ts(d: Any) -> float:
        if d is None:
            return min_ts
        return d.timestamp() if hasattr(d, "timestamp") else min_ts

    def sort_key(a: dict[str, Any]):
        if sort == "due_date_newest":
            d = a.get("due_date")
            return (d is None, -(d.timestamp() if hasattr(d, "timestamp") else max_ts))
        if sort == "due_date_oldest":
            d = a.get("due_date")
            return (d is None, _ts(d))
        if sort == "last_touch_newest":
            u = a.get("updated_at") or a.get("created_at")
            return (-_ts(u), a.get("id", ""))
        if sort == "last_touch_oldest":
            u = a.get("updated_at") or a.get("created_at")
            return (_ts(u), a.get("id", ""))
        if sort == "priority_high_low":
            p = key_priority.get((a.get("_priority") or "").upper(), 0)
            return (-p, _ts(a.get("due_date")))
        if sort == "priority_low_high":
            p = key_priority.get((a.get("_priority") or "").upper(), 0)
            return (p, _ts(a.get("due_date")))
        return (0, a.get("id", ""))

    return sorted(activities, key=sort_key)


def _hubspot_companies_to_activity_companies(
    companies: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Convert HubSpot company batch results to activity dict 'companies' format."""
    out: list[dict[str, Any]] = []
    for co in companies:
        cid = co.get("id")
        if cid is None:
            continue
        sid = str(cid)
        props = co.get("properties") or {}
        out.append({
            "id": sid,
            "name": props.get("name"),
            "domain": props.get("domain"),
            "hubspot_id": sid,
        })
    return out


def _contact_dict_to_info(
    c: dict[str, Any],
    company_name: str | None = None,
) -> ContactInfo:
    """Build ContactInfo from HubSpot contact dict (properties may be nested)."""
    props = c.get("properties") or c
    return ContactInfo(
        id=str(c.get("id", "")),
        email=props.get("email"),
        first_name=props.get("firstname"),
        last_name=props.get("lastname"),
        hubspot_id=str(c.get("id", "")),
        phone=props.get("phone"),
        mobile_phone=props.get("mobilephone"),
        company_name=company_name,
    )


def _activity_dict_to_response(a: dict[str, Any]) -> ActivityResponse:
    """Build ActivityResponse from our internal activity dict (strip _raw, _priority)."""
    company_names = a.get("contact_company_names") or {}
    contacts: list[ContactInfo] = []
    for c in a.get("contacts") or []:
        if isinstance(c, dict) and (c.get("id") or c.get("properties")):
            cid = str(c.get("id", ""))
            contacts.append(_contact_dict_to_info(c, company_name=company_names.get(cid)))
    companies: list[CompanyInfo] = []
    for c in a.get("companies") or []:
        if isinstance(c, dict) and c.get("id"):
            companies.append(CompanyInfo(
                id=c["id"],
                name=c.get("name"),
                domain=c.get("domain"),
                hubspot_id=c.get("hubspot_id"),
            ))
    return ActivityResponse(
        id=a["id"],
        hubspot_id=a.get("hubspot_id"),
        type=a.get("type"),
        subject=a.get("subject"),
        body=a.get("body"),
        due_date=a.get("due_date"),
        completed=a.get("completed", False),
        contact_ids=a.get("contact_ids", []),
        company_ids=a.get("company_ids", []),
        created_at=a.get("created_at"),
        updated_at=a.get("updated_at"),
        priority=_response_priority(a.get("_priority")),
        contacts=contacts,
        companies=companies,
    )


def _today_yyyymmdd() -> str:
    """Return today's date as YYYY-MM-DD in UTC."""
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


def _date_to_hubspot_ms(date_str: str, end_of_day: bool = False) -> int | None:
    """Convert YYYY-MM-DD to HubSpot hs_timestamp (milliseconds since epoch). UTC."""
    if not date_str or not date_str.strip():
        return None
    try:
        dt = datetime.strptime(date_str.strip()[:10], "%Y-%m-%d").replace(tzinfo=timezone.utc)
        if end_of_day:
            dt = dt.replace(hour=23, minute=59, second=59, microsecond=999)
        return int(dt.timestamp() * 1000)
    except ValueError:
        return None


@router.get(
    "",
    response_model=ActivityListResponse,
    summary="List activities",
    description="List activities with optional filters and sort. Uses cache if fresh (5 min), else syncs from HubSpot. Default date filter is today.",
)
async def list_activities(
    user_id: str = Depends(get_current_user_id),
    date: str | None = Query(None, description="Filter by date (YYYY-MM-DD); default today"),
    relationship_status: list[str] | None = Query(None, description="Filter by relationship status"),
    processing_status: list[str] | None = Query(None, description="Filter by processing status"),
    date_from: str | None = Query(None, description="Start date for range (YYYY-MM-DD)"),
    date_to: str | None = Query(None, description="End date for range (YYYY-MM-DD)"),
    sort: ActivitySortOption = Query("due_date_oldest", description="Sort option"),
    search: str | None = Query(None, description="Search by keyword (subject, contact, company); fetches from HubSpot; returns completed and not completed"),
    supabase: SupabaseService = Depends(get_supabase_service),
    hubspot: HubSpotService = Depends(get_hubspot_service),
) -> ActivityListResponse:
    """GET /api/v1/activities — list activities with cache and filters. Default: tasks due today. Use search= to query HubSpot by keyword (all statuses)."""
    # Default date filter to today when no range specified (dashboard "today's tasks" view)
    effective_date = date
    if effective_date is None and date_from is None and date_to is None:
        effective_date = _today_yyyymmdd()
    # When user sets a date range (date_from/date_to), query HubSpot directly for that range
    if date_from or date_to:
        effective_date = None

    try:
        activities: list[dict[str, Any]] = []

        if search and search.strip():
            # Keyword search: fetch from HubSpot (all statuses, completed + not completed)
            search_results: list[dict[str, Any]] = []
            after: str | None = None
            while True:
                resp = hubspot.search_tasks(
                    query=search.strip(),
                    limit=100,
                    after=after,
                )
                results = resp.get("results") or []
                search_results.extend(results)
                paging = resp.get("paging") or {}
                next_p = paging.get("next") or {}
                after = next_p.get("after")
                if not after or not results:
                    break

            task_ids = [r.get("id") for r in search_results if r.get("id")]
            for i in range(0, len(task_ids), 100):
                chunk = task_ids[i : i + 100]
                try:
                    full_tasks = hubspot.batch_read_tasks(
                        chunk,
                        associations=["contacts", "companies"],
                    )
                    for t in full_tasks:
                        activities.append(_hubspot_task_to_activity(t))
                except HubSpotServiceError:
                    for r in search_results:
                        if r.get("id") in chunk:
                            activities.append(_hubspot_task_to_activity(r))

            task_to_contacts: dict[str, list[str]] = {}
            task_to_companies: dict[str, list[str]] = {}
            for j in range(0, len(task_ids), 100):
                chunk = task_ids[j : j + 100]
                try:
                    task_to_contacts.update(
                        hubspot.batch_read_task_associations(chunk, "contacts")
                    )
                    task_to_companies.update(
                        hubspot.batch_read_task_associations(chunk, "companies")
                    )
                except HubSpotServiceError:
                    pass
            for a in activities:
                tid = a.get("id")
                if not tid:
                    continue
                tid_str = str(tid)
                if tid_str in task_to_contacts:
                    a["contact_ids"] = task_to_contacts[tid_str]
                if tid_str in task_to_companies:
                    a["company_ids"] = task_to_companies[tid_str]
                elif not a.get("contact_ids") and task_to_contacts:
                    # [CONTACT_DEBUG] task id might be int vs str mismatch
                    logger.info(
                        "[contact_debug] search path: task %s (type=%s) not in task_to_contacts; keys sample=%s",
                        tid,
                        type(tid).__name__,
                        list(task_to_contacts.keys())[:3] if task_to_contacts else [],
                    )

            # No date/status filter: return all matching tasks (completed + not completed)
        elif date_from or date_to:
            # Query HubSpot directly for tasks in the date range (search_tasks)
            from_ms = _date_to_hubspot_ms(date_from or "", end_of_day=False)
            to_ms = _date_to_hubspot_ms(date_to or "", end_of_day=True) if date_to else None
            if date_from and from_ms is None:
                from_ms = _date_to_hubspot_ms("1970-01-01", end_of_day=False)
            if date_to and to_ms is None:
                to_ms = _date_to_hubspot_ms("2099-12-31", end_of_day=True)

            search_results: list[dict[str, Any]] = []
            after: str | None = None
            while True:
                resp = hubspot.search_tasks(
                    due_date_from_ms=from_ms,
                    due_date_to_ms=to_ms,
                    limit=100,
                    after=after,
                )
                results = resp.get("results") or []
                search_results.extend(results)
                paging = resp.get("paging") or {}
                next_p = paging.get("next") or {}
                after = next_p.get("after")
                if not after or not results:
                    break

            # Enrich with associations: batch read tasks then fetch task-contact and task-company associations
            task_ids = [r.get("id") for r in search_results if r.get("id")]
            for i in range(0, len(task_ids), 100):
                chunk = task_ids[i : i + 100]
                try:
                    full_tasks = hubspot.batch_read_tasks(
                        chunk,
                        associations=["contacts", "companies"],
                    )
                    for t in full_tasks:
                        activities.append(_hubspot_task_to_activity(t))
                except HubSpotServiceError:
                    for r in search_results:
                        if r.get("id") in chunk:
                            activities.append(_hubspot_task_to_activity(r))

            # Ensure contact_ids and company_ids are set (batch_read_tasks may not return associations)
            task_to_contacts: dict[str, list[str]] = {}
            task_to_companies: dict[str, list[str]] = {}
            for j in range(0, len(task_ids), 100):
                chunk = task_ids[j : j + 100]
                try:
                    task_to_contacts.update(
                        hubspot.batch_read_task_associations(chunk, "contacts")
                    )
                    task_to_companies.update(
                        hubspot.batch_read_task_associations(chunk, "companies")
                    )
                except HubSpotServiceError:
                    pass
            for a in activities:
                tid = a.get("id")
                if not tid:
                    continue
                tid_str = str(tid)
                if tid_str in task_to_contacts:
                    a["contact_ids"] = task_to_contacts[tid_str]
                if tid_str in task_to_companies:
                    a["company_ids"] = task_to_companies[tid_str]
                elif not a.get("contact_ids") and task_to_contacts:
                    logger.info(
                        "[contact_debug] date range path: task %s (type=%s) not in task_to_contacts; keys sample=%s",
                        tid,
                        type(tid).__name__,
                        list(task_to_contacts.keys())[:3] if task_to_contacts else [],
                    )

            # Apply only relationship/processing filters (date already applied by HubSpot search)
            activities = _apply_filters(
                activities,
                date=None,
                relationship_status=relationship_status,
                processing_status=processing_status,
                date_from=None,
                date_to=None,
            )
        else:
            # a) Check cache freshness
            last_synced = await supabase.get_tasks_cache_freshness(user_id)
            now = datetime.now(timezone.utc)
            fresh = False
            if last_synced:
                try:
                    if last_synced.endswith("Z"):
                        synced_dt = datetime.fromisoformat(last_synced.replace("Z", "+00:00"))
                    else:
                        synced_dt = datetime.fromisoformat(last_synced)
                    if synced_dt.tzinfo is None:
                        synced_dt = synced_dt.replace(tzinfo=timezone.utc)
                    fresh = (now - synced_dt).total_seconds() < CACHE_FRESH_SECONDS
                except (ValueError, TypeError):
                    pass

            # b) If stale, fetch from HubSpot with associations and replace cache (so deleted tasks disappear)
            if not fresh:
                all_tasks: list[dict[str, Any]] = []
                after = None
                while True:
                    resp = hubspot.get_tasks(
                        limit=100,
                        after=after,
                        associations=["contacts", "companies"],
                    )
                    results = resp.get("results") or []
                    all_tasks.extend(results)
                    paging = resp.get("paging") or {}
                    next_p = paging.get("next") or {}
                    after = next_p.get("after")
                    if not after or not results:
                        break
                await supabase.delete_tasks_cache_for_user(user_id)
                if all_tasks:
                    await supabase.upsert_tasks_cache_bulk(user_id, all_tasks)

            # c) Read from cache and transform
            cached = await supabase.get_tasks_cache(user_id)
            for row in cached:
                data = row.get("data") or {}
                activities.append(_hubspot_task_to_activity(data))

            # d) Apply filters (with default today)
            activities = _apply_filters(
                activities,
                date=effective_date,
                relationship_status=relationship_status,
                processing_status=processing_status,
                date_from=None,
                date_to=None,
            )

        # e) Enrich with contact details (phone, mobile_phone, company_name) for contact_ids
        all_contact_ids = list({cid for a in activities for cid in (a.get("contact_ids") or [])})
        logger.info(
            "[contact_debug] enrichment: total activities=%s, unique contact_ids=%s, sample contact_id types=%s",
            len(activities),
            len(all_contact_ids),
            [type(cid).__name__ for cid in all_contact_ids[:5]],
        )
        contact_id_to_company_name: dict[str, str] = {}
        if all_contact_ids:
            try:
                # HubSpot batch read limit is 100; fetch contacts in chunks so all IDs are resolved
                contact_list: list[dict[str, Any]] = []
                for i in range(0, len(all_contact_ids), 100):
                    chunk = all_contact_ids[i : i + 100]
                    contact_list.extend(
                        hubspot.get_contacts_batch(
                            chunk,
                            properties=["firstname", "lastname", "email", "phone", "mobilephone"],
                        )
                    )
                contact_map = {str(c.get("id", "")): c for c in contact_list if c.get("id")}
                logger.info(
                    "[contact_debug] get_contacts_batch returned %s contacts; contact_map keys (sample)=%s",
                    len(contact_list),
                    list(contact_map.keys())[:5],
                )
                try:
                    # Fetch contact->company associations in chunks (HubSpot limit 100 per request)
                    contact_to_company: dict[str, str] = {}
                    for i in range(0, len(all_contact_ids), 100):
                        chunk = all_contact_ids[i : i + 100]
                        contact_to_company.update(hubspot.batch_read_contact_company_ids(chunk))
                    unique_company_ids = list(dict.fromkeys(contact_to_company.values()))
                    if unique_company_ids:
                        companies = []
                        for j in range(0, len(unique_company_ids), 100):
                            companies.extend(
                                hubspot.get_companies_batch(
                                    unique_company_ids[j : j + 100], properties=["name"]
                                )
                            )
                        company_name_by_id = {}
                        for co in companies:
                            cid = str(co.get("id", ""))
                            props = co.get("properties") or {}
                            company_name_by_id[cid] = props.get("name")
                        for cid, co_id in contact_to_company.items():
                            contact_id_to_company_name[cid] = company_name_by_id.get(co_id) or ""
                except HubSpotServiceError:
                    pass
                for a in activities:
                    cids = a.get("contact_ids") or []
                    # Normalize to string for lookup (HubSpot/cache may return int or str)
                    a["contacts"] = [
                        contact_map[str(cid)] for cid in cids if str(cid) in contact_map
                    ]
                    missing = [cid for cid in cids if str(cid) not in contact_map]
                    if missing:
                        logger.info(
                            "[contact_debug] task %s: contact_ids=%s -> resolved %s contacts; missing (not in contact_map)=%s; cid types=%s",
                            a.get("id"),
                            cids,
                            len(a["contacts"]),
                            missing,
                            [type(c).__name__ for c in missing],
                        )
                    a["contact_company_names"] = {
                        str(cid): contact_id_to_company_name.get(str(cid), "")
                        for cid in (a.get("contact_ids") or [])
                    }
                    # Use contact's company for company_ids when task has none (so dashboard passes company_id and Activity page account is always populated)
                    if not (a.get("company_ids")):
                        cids = a.get("contact_ids") or []
                        if cids:
                            co_id = contact_to_company.get(cids[0])
                            if co_id:
                                a["company_ids"] = [co_id]
            except HubSpotServiceError:
                pass  # keep contacts empty if batch fails

        # f) Sort
        activities = _apply_sort(activities, sort)

        # g) Build response
        return ActivityListResponse(
            activities=[_activity_dict_to_response(a) for a in activities],
        )
    except HubSpotServiceError as e:
        logger.warning("HubSpot error listing activities: %s", e.message)
        # Return from cache only if HubSpot failed
        cached = await supabase.get_tasks_cache(user_id)
        activities = [_hubspot_task_to_activity(row.get("data") or {}) for row in cached]
        activities = _apply_filters(activities, effective_date, relationship_status, processing_status, date_from, date_to)
        activities = _apply_sort(activities, sort)
        return ActivityListResponse(activities=[_activity_dict_to_response(a) for a in activities])
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("List activities error: %s", e)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to list activities",
        )


@router.post(
    "/sync",
    response_model=SyncStatusResponse,
    summary="Force sync from HubSpot",
)
async def sync_activities(
    user_id: str = Depends(get_current_user_id),
    supabase: SupabaseService = Depends(get_supabase_service),
    hubspot: HubSpotService = Depends(get_hubspot_service),
) -> SyncStatusResponse:
    """POST /api/v1/activities/sync — bypass cache and sync all tasks from HubSpot. Records sync log."""
    started_at = datetime.now(timezone.utc)
    try:
        all_tasks: list[dict[str, Any]] = []
        after: str | None = None
        while True:
            resp = hubspot.get_tasks(
                limit=100,
                after=after,
                associations=["contacts", "companies"],
            )
            results = resp.get("results") or []
            all_tasks.extend(results)
            paging = resp.get("paging") or {}
            after = (paging.get("next") or {}).get("after")
            if not after or not results:
                break
        await supabase.delete_tasks_cache_for_user(user_id)
        if all_tasks:
            await supabase.upsert_tasks_cache_bulk(user_id, all_tasks)
        finished_at = datetime.now(timezone.utc)
        duration_ms = int((finished_at - started_at).total_seconds() * 1000)
        await supabase.insert_sync_log(
            user_id=user_id,
            source="hubspot",
            action="Activities sync",
            status="success",
            started_at=started_at,
            finished_at=finished_at,
            duration_ms=duration_ms,
            details=None,
            metadata={"tasks_count": len(all_tasks)},
        )
        return SyncStatusResponse(
            synced=True,
            message="Sync completed successfully",
            tasks_count=len(all_tasks),
        )
    except HubSpotServiceError as e:
        logger.warning("HubSpot sync error: %s", e.message)
        finished_at = datetime.now(timezone.utc)
        duration_ms = int((finished_at - started_at).total_seconds() * 1000)
        await supabase.insert_sync_log(
            user_id=user_id,
            source="hubspot",
            action="Activities sync",
            status="error",
            started_at=started_at,
            finished_at=finished_at,
            duration_ms=duration_ms,
            details=e.message or "HubSpot error during sync",
            metadata={"tasks_count": 0},
        )
        return SyncStatusResponse(
            synced=False,
            message=e.message or "HubSpot error during sync",
            tasks_count=0,
        )
    except Exception as e:
        logger.exception("Sync activities error: %s", e)
        finished_at = datetime.now(timezone.utc)
        duration_ms = int((finished_at - started_at).total_seconds() * 1000)
        await supabase.insert_sync_log(
            user_id=user_id,
            source="hubspot",
            action="Activities sync",
            status="error",
            started_at=started_at,
            finished_at=finished_at,
            duration_ms=duration_ms,
            details="Failed to sync activities",
            metadata={},
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to sync activities",
        )


@router.get(
    "/{activity_id}",
    response_model=ActivityResponse,
    summary="Get single activity",
)
async def get_activity(
    activity_id: str,
    user_id: str = Depends(get_current_user_id),
    supabase: SupabaseService = Depends(get_supabase_service),
    hubspot: HubSpotService = Depends(get_hubspot_service),
) -> ActivityResponse:
    """GET /api/v1/activities/{activity_id} — fetch from cache or HubSpot. Returns task with contact summary and notes (communication history)."""
    try:
        cached = await supabase.get_tasks_cache(user_id)
        for row in cached:
            if (row.get("hubspot_task_id") or row.get("data", {}).get("id")) == activity_id:
                data = row.get("data") or {}
                a = _hubspot_task_to_activity(data)
                contact_ids = a.get("contact_ids") or []
                company_ids_from_task = a.get("company_ids") or []
                if contact_ids:
                    try:
                        contact_list = hubspot.get_contacts_batch(contact_ids)
                        a["contacts"] = contact_list
                        try:
                            contact_to_company = hubspot.batch_read_contact_company_ids(contact_ids)
                            unique_company_ids = list(dict.fromkeys(contact_to_company.values()))
                            if unique_company_ids:
                                companies = hubspot.get_companies_batch(unique_company_ids, properties=["name"])
                                company_name_by_id = {str(co.get("id", "")): (co.get("properties") or {}).get("name") for co in companies}
                                a["contact_company_names"] = {
                                    cid: company_name_by_id.get(contact_to_company.get(cid, ""), "") or ""
                                    for cid in contact_ids
                                }
                                a["companies"] = _hubspot_companies_to_activity_companies(companies)
                            else:
                                a["contact_company_names"] = {cid: "" for cid in contact_ids}
                        except HubSpotServiceError:
                            a["contact_company_names"] = {cid: "" for cid in contact_ids}
                    except HubSpotServiceError:
                        pass
                if not a.get("companies") and company_ids_from_task:
                    try:
                        companies = hubspot.get_companies_batch(company_ids_from_task, properties=["name"])
                        a["companies"] = _hubspot_companies_to_activity_companies(companies)
                    except HubSpotServiceError:
                        pass
                return _activity_dict_to_response(a)
        # Not in cache: fetch from HubSpot with associations
        task = hubspot.get_task(activity_id, associations=["contacts", "companies"])
        await supabase.upsert_task_cache(user_id, activity_id, task)
        a = _hubspot_task_to_activity(task)
        contact_ids = a.get("contact_ids") or []
        company_ids_from_task = a.get("company_ids") or []
        if contact_ids:
            try:
                contact_list = hubspot.get_contacts_batch(contact_ids)
                a["contacts"] = contact_list
                try:
                    contact_to_company = hubspot.batch_read_contact_company_ids(contact_ids)
                    unique_company_ids = list(dict.fromkeys(contact_to_company.values()))
                    if unique_company_ids:
                        companies = hubspot.get_companies_batch(unique_company_ids, properties=["name"])
                        company_name_by_id = {str(co.get("id", "")): (co.get("properties") or {}).get("name") for co in companies}
                        a["contact_company_names"] = {
                            cid: company_name_by_id.get(contact_to_company.get(cid, ""), "") or ""
                            for cid in contact_ids
                        }
                        a["companies"] = _hubspot_companies_to_activity_companies(companies)
                    else:
                        a["contact_company_names"] = {cid: "" for cid in contact_ids}
                except HubSpotServiceError:
                    a["contact_company_names"] = {cid: "" for cid in contact_ids}
            except HubSpotServiceError:
                pass
        if not a.get("companies") and company_ids_from_task:
            try:
                companies = hubspot.get_companies_batch(company_ids_from_task, properties=["name"])
                a["companies"] = _hubspot_companies_to_activity_companies(companies)
            except HubSpotServiceError:
                pass
        return _activity_dict_to_response(a)
    except HubSpotServiceError as e:
        if e.status_code == 404:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Activity not found")
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=e.message or "HubSpot error",
        )
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Get activity error: %s", e)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to get activity",
        )


def _notes_hash(notes: str) -> str:
    """Stable hash of notes body to detect when to re-run communication summary."""
    return hashlib.sha256((notes or "").strip().encode("utf-8")).hexdigest()


@router.get(
    "/{activity_id}/communication-summary",
    response_model=CommunicationSummaryResponse,
    summary="Get or generate communication summary",
    description="Returns stored summary for this task; if missing or notes changed, runs agent and stores result.",
)
async def get_communication_summary(
    activity_id: str,
    user_id: str = Depends(get_current_user_id),
    supabase: SupabaseService = Depends(get_supabase_service),
    hubspot: HubSpotService = Depends(get_hubspot_service),
) -> CommunicationSummaryResponse:
    """GET /api/v1/activities/{activity_id}/communication-summary — get or generate and store summary from client notes."""
    logger.info("[communication-summary] START activity_id=%s user_id=%s", activity_id, user_id)
    try:
        full_notes = ""
        cached = await supabase.get_tasks_cache(user_id)
        logger.info("[communication-summary] tasks_cache rows=%s", len(cached))
        for row in cached:
            if (row.get("hubspot_task_id") or row.get("data", {}).get("id")) == activity_id:
                data = row.get("data") or {}
                props = data.get("properties") or {}
                raw = (props.get(HS_BODY) or "").strip()
                full_notes = _normalize_notes_body(raw) if raw else ""
                logger.info("[communication-summary] notes from cache: len(raw)=%s len(full_notes)=%s", len(raw), len(full_notes))
                break
        if not full_notes:
            logger.info("[communication-summary] no notes from cache, fetching from HubSpot")
            try:
                task = hubspot.get_task(activity_id)
                props = task.get("properties") or {}
                raw = (props.get(HS_BODY) or "").strip()
                full_notes = _normalize_notes_body(raw) if raw else ""
                logger.info("[communication-summary] notes from HubSpot: len(raw)=%s len(full_notes)=%s", len(raw), len(full_notes))
            except HubSpotServiceError as e:
                logger.warning("[communication-summary] HubSpot get_task failed: %s", e)

        logger.info("[communication-summary] full_notes length=%s", len(full_notes))

        current_hash = _notes_hash(full_notes)
        stored = await supabase.get_communication_summary(user_id, activity_id)
        has_stored = stored is not None
        hash_match = bool(stored and stored.get("notes_hash") == current_hash)
        # Treat stored "error" summary as cache miss so we retry the agent
        COMM_SUMMARY_ERROR_MSG = "Unable to generate summary. Please try again."
        stored_is_error = (
            stored
            and (stored.get("summary") or "").strip() == COMM_SUMMARY_ERROR_MSG
            and not (stored.get("times_contacted") or "").strip()
            and not (stored.get("relationship_status") or "").strip()
        )
        use_cached = hash_match and not stored_is_error
        logger.info("[communication-summary] stored=%s notes_hash_match=%s stored_is_error=%s use_cached=%s", has_stored, hash_match, stored_is_error, use_cached)

        if use_cached and stored:
            logger.info("[communication-summary] returning cached summary")
            return CommunicationSummaryResponse(
                summary=stored.get("summary") or "",
                times_contacted=stored.get("times_contacted") or "",
                relationship_status=stored.get("relationship_status") or "",
            )

        if stored_is_error:
            logger.info("[communication-summary] stored summary was error fallback, regenerating")
        logger.info("[communication-summary] calling generate_communication_summary (notes_len=%s)", len(full_notes))
        result = generate_communication_summary(full_notes)
        logger.info(
            "[communication-summary] agent returned summary_len=%s times_contacted=%s relationship_status=%s",
            len(result.get("summary", "")),
            bool(result.get("times_contacted")),
            bool(result.get("relationship_status")),
        )
        await supabase.upsert_communication_summary(
            user_id=user_id,
            hubspot_task_id=activity_id,
            summary=result["summary"],
            times_contacted=result["times_contacted"],
            relationship_status=result["relationship_status"],
            notes_hash=current_hash,
        )
        return CommunicationSummaryResponse(
            summary=result["summary"],
            times_contacted=result["times_contacted"],
            relationship_status=result["relationship_status"],
        )
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Get communication summary error: %s", e)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to get communication summary",
        )


@router.post(
    "",
    response_model=ActivityResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Create activity",
)
async def create_activity(
    body: ActivityCreate,
    user_id: str = Depends(get_current_user_id),
    supabase: SupabaseService = Depends(get_supabase_service),
    hubspot: HubSpotService = Depends(get_hubspot_service),
) -> ActivityResponse:
    """POST /api/v1/activities — create in HubSpot and cache."""
    try:
        props: dict[str, Any] = {}
        if body.subject is not None:
            props[HS_SUBJECT] = body.subject
        if body.body is not None:
            props[HS_BODY] = body.body
        if body.due_date is not None:
            props[HS_TIMESTAMP] = int(body.due_date.timestamp() * 1000)
        if body.completed is not None:
            props[HS_STATUS] = "COMPLETED" if body.completed else "NOT_STARTED"
        if body.type is not None:
            props[HS_TYPE] = body.type
        payload = {"properties": props}
        task = hubspot.create_task(payload)
        tid = task.get("id")
        if not tid:
            raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="HubSpot did not return task id")
        await supabase.upsert_task_cache(user_id, str(tid), task)
        a = _hubspot_task_to_activity(task)
        return _activity_dict_to_response(a)
    except HubSpotServiceError as e:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=e.message or "HubSpot error",
        )
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Create activity error: %s", e)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to create activity",
        )


@router.put(
    "/{activity_id}",
    response_model=ActivityResponse,
    summary="Update activity",
)
async def update_activity(
    activity_id: str,
    body: ActivityUpdate,
    user_id: str = Depends(get_current_user_id),
    supabase: SupabaseService = Depends(get_supabase_service),
    hubspot: HubSpotService = Depends(get_hubspot_service),
) -> ActivityResponse:
    """PUT /api/v1/activities/{activity_id} — update in HubSpot and cache."""
    try:
        props: dict[str, Any] = {}
        if body.subject is not None:
            props[HS_SUBJECT] = body.subject
        if body.body is not None:
            props[HS_BODY] = body.body
        if body.due_date is not None:
            props[HS_TIMESTAMP] = int(body.due_date.timestamp() * 1000)
        if body.completed is not None:
            props[HS_STATUS] = "COMPLETED" if body.completed else "NOT_STARTED"
        if body.type is not None:
            props[HS_TYPE] = body.type
        payload = {"properties": props}
        if not payload.get("properties"):
            # Fetch current and merge or return as-is
            task = hubspot.get_task(activity_id)
            await supabase.upsert_task_cache(user_id, activity_id, task)
            return _activity_dict_to_response(_hubspot_task_to_activity(task))
        task = hubspot.update_task(activity_id, payload)
        await supabase.upsert_task_cache(user_id, activity_id, task)
        return _activity_dict_to_response(_hubspot_task_to_activity(task))
    except HubSpotServiceError as e:
        if e.status_code == 404:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Activity not found")
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=e.message or "HubSpot error",
        )
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Update activity error: %s", e)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to update activity",
        )


@router.delete(
    "/{activity_id}",
    response_model=MessageResponse,
    summary="Delete activity",
)
async def delete_activity(
    activity_id: str,
    user_id: str = Depends(get_current_user_id),
    supabase: SupabaseService = Depends(get_supabase_service),
    hubspot: HubSpotService = Depends(get_hubspot_service),
) -> MessageResponse:
    """DELETE /api/v1/activities/{activity_id} — delete in HubSpot and remove from cache."""
    try:
        hubspot.delete_task(activity_id)
    except HubSpotServiceError as e:
        if e.status_code == 404:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Activity not found")
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=e.message or "HubSpot error",
        )
    await supabase.delete_task_cache(user_id, activity_id)
    return MessageResponse(message="Activity deleted successfully")


@router.post(
    "/{activity_id}/complete",
    response_model=MessageResponse,
    summary="Mark activity complete",
)
async def complete_activity(
    activity_id: str,
    user_id: str = Depends(get_current_user_id),
    supabase: SupabaseService = Depends(get_supabase_service),
    hubspot: HubSpotService = Depends(get_hubspot_service),
) -> MessageResponse:
    """POST /api/v1/activities/{activity_id}/complete — set status to COMPLETED in HubSpot."""
    try:
        payload = {"properties": {HS_STATUS: "COMPLETED"}}
        task = hubspot.update_task(activity_id, payload)
        await supabase.upsert_task_cache(user_id, activity_id, task)
        return MessageResponse(message="Activity marked complete")
    except HubSpotServiceError as e:
        if e.status_code == 404:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Activity not found")
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=e.message or "HubSpot error",
        )
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Complete activity error: %s", e)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to complete activity",
        )


@router.post(
    "/process-draft",
    response_model=ProcessNotesResponse,
    summary="Process draft notes (no activity id)",
    description="Same as process-notes but accepts note_text and previous_notes in body. Use when creating a new activity.",
)
async def process_draft(
    body: ProcessDraftRequest,
    user_id: str = Depends(get_current_user_id),
) -> ProcessNotesResponse:
    """POST /api/v1/activities/process-draft — LLM processing without an existing activity (e.g. new activity)."""
    try:
        note_text = (body.note_text or "").strip()
        previous_notes = (body.previous_notes or "").strip()

        summary = summarize_communication_history(
            (previous_notes + "\n\n" + note_text).strip() if previous_notes else note_text
        )
        recognised = extract_recognised_date(note_text)
        recommended = recommend_touch_date(note_text, previous_notes)
        metadata = extract_metadata(note_text, previous_notes)
        drafts_map = generate_drafts(note_text, previous_notes)

        drafts_out: dict[str, DraftOut] = {
            k: DraftOut(text=v["text"], confidence=v["confidence"])
            for k, v in drafts_map.items()
        }

        return ProcessNotesResponse(
            summary=summary,
            recognised_date=RecognisedDateOut(
                date=recognised.get("date"),
                label=recognised.get("label"),
                confidence=recognised.get("confidence", 0),
            ),
            recommended_touch_date=RecommendedTouchDateOut(
                date=recommended["date"],
                label=recommended.get("label", ""),
                rationale=recommended.get("rationale", ""),
            ),
            metadata=ExtractedMetadataOut(
                subject=metadata["subject"],
                questions_raised=metadata["questions_raised"],
                urgency=metadata["urgency"],
                subject_confidence=metadata["subject_confidence"],
                questions_confidence=metadata["questions_confidence"],
            ),
            drafts=drafts_out,
        )
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Process draft error: %s", e)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to process draft",
        )


@router.post(
    "/generate-email-drafts",
    response_model=GenerateEmailDraftsResponse,
    summary="Generate Smart compose email drafts",
    description="Generate warm, concise, and formal email drafts from instructions, client notes, task title, and optional last touch date.",
)
async def generate_smart_compose_drafts(
    body: GenerateEmailDraftsRequest,
    user_id: str = Depends(get_current_user_id),
    supabase: SupabaseService = Depends(get_supabase_service),
) -> GenerateEmailDraftsResponse:
    """POST /api/v1/activities/generate-email-drafts — Claude agent for Smart compose (warm, concise, formal)."""
    try:
        # Always prefer the name from the connected Gmail integration, since that
        # is the account used for imports and sending. The login identity's name/email
        # should not affect email sign-offs.
        gmail_sender_name = await get_gmail_user_display_name(user_id, supabase)
        request_sender_name = (body.sender_name or "").strip() or None
        sender_name = gmail_sender_name or request_sender_name

        if gmail_sender_name:
            logger.info(
                "[generate-email-drafts] using sender_name from Gmail integration for user_id=%s (length=%d)",
                user_id[:8],
                len(gmail_sender_name),
            )
        elif request_sender_name:
            logger.info(
                "[generate-email-drafts] Gmail sender name unavailable; using sender_name from request (length=%d)",
                len(request_sender_name),
            )
        else:
            logger.info("[generate-email-drafts] no sender_name available (Gmail + request both empty)")

        drafts_map, suggested_subject = generate_email_drafts(
            email_instructions=body.email_instructions or "",
            client_notes=body.client_notes or "",
            task_title=body.task_title or "",
            last_touch_date=body.last_touch_date,
            sender_name=sender_name,
        )
        drafts_out = {
            k: DraftOut(text=v["text"], confidence=v["confidence"])
            for k, v in drafts_map.items()
        }
        return GenerateEmailDraftsResponse(drafts=drafts_out, suggested_subject=suggested_subject or "")
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Generate email drafts error: %s", e)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to generate email drafts",
        )


@router.post(
    "/{activity_id}/process-notes",
    response_model=ProcessNotesResponse,
    summary="Process notes with LLM",
    description="Run Claude agents: summary, recognised date, recommended touch date, metadata, drafts.",
)
async def process_notes(
    activity_id: str,
    body: ProcessNotesRequest,
    user_id: str = Depends(get_current_user_id),
    supabase: SupabaseService = Depends(get_supabase_service),
    hubspot: HubSpotService = Depends(get_hubspot_service),
) -> ProcessNotesResponse:
    """POST /api/v1/activities/{activity_id}/process-notes — full LLM processing for activity page."""
    try:
        # Load existing activity body (previous notes) for context
        cached = await supabase.get_tasks_cache(user_id)
        existing_body = ""
        for row in cached:
            if (row.get("hubspot_task_id") or row.get("data", {}).get("id")) == activity_id:
                data = row.get("data") or {}
                props = data.get("properties") or {}
                existing_body = (props.get(HS_BODY) or "").strip()
                break
        if not existing_body:
            try:
                task = hubspot.get_task(activity_id)
                props = task.get("properties") or {}
                existing_body = (props.get(HS_BODY) or "").strip()
            except HubSpotServiceError:
                pass

        note_text = (body.note_text or "").strip()
        full_notes = (existing_body + "\n\n" + note_text).strip() if existing_body else note_text

        summary = summarize_communication_history(full_notes)
        recognised = extract_recognised_date(note_text)
        recommended = recommend_touch_date(note_text, existing_body)
        metadata = extract_metadata(note_text, existing_body)
        drafts_map = generate_drafts(note_text, existing_body)

        drafts_out: dict[str, DraftOut] = {
            k: DraftOut(text=v["text"], confidence=v["confidence"])
            for k, v in drafts_map.items()
        }

        return ProcessNotesResponse(
            summary=summary,
            recognised_date=RecognisedDateOut(
                date=recognised.get("date"),
                label=recognised.get("label"),
                confidence=recognised.get("confidence", 0),
            ),
            recommended_touch_date=RecommendedTouchDateOut(
                date=recommended["date"],
                label=recommended.get("label", ""),
                rationale=recommended.get("rationale", ""),
            ),
            metadata=ExtractedMetadataOut(
                subject=metadata["subject"],
                questions_raised=metadata["questions_raised"],
                urgency=metadata["urgency"],
                subject_confidence=metadata["subject_confidence"],
                questions_confidence=metadata["questions_confidence"],
            ),
            drafts=drafts_out,
        )
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Process notes error: %s", e)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to process notes",
        )


@router.post(
    "/create-and-submit",
    response_model=CreateAndSubmitResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Create new activity and submit",
    description="Create a new task in HubSpot with meeting notes, subject, contact, and account (due date optional).",
)
async def create_and_submit_activity(
    body: ActivitySubmitRequest,
    user_id: str = Depends(get_current_user_id),
    supabase: SupabaseService = Depends(get_supabase_service),
    hubspot: HubSpotService = Depends(get_hubspot_service),
) -> CreateAndSubmitResponse:
    """POST /api/v1/activities/create-and-submit — create new task with notes, subject, contact, company."""
    try:
        if not (body.meeting_notes and body.meeting_notes.strip()):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Meeting notes are required.",
            )
        if not body.subject or not body.subject.strip():
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Subject is required.",
            )
        if not body.contact_id or not body.contact_id.strip():
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Contact is required.",
            )
        if not body.company_id or not body.company_id.strip():
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Account is required.",
            )
        if not body.due_date or not body.due_date.strip():
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Due date is required when creating an activity.",
            )
        if body.contact_id and body.company_id:
            company_ids = hubspot.get_contact_company_ids(body.contact_id)
            if company_ids and body.company_id not in company_ids:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="Selected contact is not associated with the selected account.",
                )
        # Activity date = when the task was performed (used for note prefix). Default today.
        if body.activity_date and body.activity_date.strip():
            try:
                activity_dt = datetime.strptime(body.activity_date.strip()[:10], "%Y-%m-%d").replace(
                    tzinfo=timezone.utc
                )
            except ValueError:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="Activity date must be YYYY-MM-DD.",
                )
        else:
            activity_dt = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
        date_prefix = activity_dt.strftime("%m/%d/%y")
        new_body = _normalize_notes_body(f"{date_prefix} - {body.meeting_notes.strip()}")

        # Due date = task due date in HubSpot. Default today.
        if body.due_date and body.due_date.strip():
            try:
                due_dt = datetime.strptime(body.due_date.strip()[:10], "%Y-%m-%d").replace(
                    tzinfo=timezone.utc
                )
            except ValueError:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="Due date must be YYYY-MM-DD.",
                )
        else:
            due_dt = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
        due_dt_utc = due_dt.replace(tzinfo=timezone.utc) if due_dt.tzinfo is None else due_dt
        ts_ms = int(due_dt_utc.timestamp() * 1000)
        payload = {
            "properties": {
                HS_SUBJECT: body.subject.strip(),
                HS_BODY: new_body,
                HS_TIMESTAMP: ts_ms,
            },
        }
        hs_priority = _hubspot_priority(body.priority)
        if hs_priority is not None:
            payload["properties"][HS_PRIORITY] = hs_priority
        task = hubspot.create_task(payload)
        tid = task.get("id")
        if not tid:
            raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="HubSpot did not return task id")
        tid_str = str(tid)
        await supabase.upsert_task_cache(user_id, tid_str, task)
        try:
            hubspot.associate_task_with_contact(tid_str, body.contact_id)
        except HubSpotServiceError as ae:
            logger.warning("Task contact association failed: %s", ae.message)
        try:
            hubspot.associate_task_with_company(tid_str, body.company_id)
        except HubSpotServiceError as ae:
            logger.warning("Task company association failed: %s", ae.message)
        try:
            task_with_assoc = hubspot.get_task(tid_str, associations=["contacts", "companies"])
            await supabase.upsert_task_cache(user_id, tid_str, task_with_assoc)
        except HubSpotServiceError as ae:
            logger.warning("Re-fetch task with associations failed: %s", ae.message)
        return CreateAndSubmitResponse(message="Activity created successfully", id=tid_str)
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Create and submit error: %s", e)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to create activity",
        )


@router.post(
    "/{activity_id}/submit",
    response_model=MessageResponse,
    summary="Submit activity",
    description="Mark complete only, or update task with notes, subject, contact, account, and due date (due date required unless marking complete).",
)
async def submit_activity(
    activity_id: str,
    body: ActivitySubmitRequest,
    user_id: str = Depends(get_current_user_id),
    supabase: SupabaseService = Depends(get_supabase_service),
    hubspot: HubSpotService = Depends(get_hubspot_service),
) -> MessageResponse:
    """POST /api/v1/activities/{activity_id}/submit — mark complete or update task. Full update requires meeting_notes, subject, contact_id, company_id only."""
    try:
        if body.mark_complete:
            if body.due_date and body.due_date.strip():
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="Cannot mark activity as complete when a due date is set. Remove the due date.",
                )
            has_full_update = (
                body.meeting_notes and body.meeting_notes.strip()
                and body.subject and body.subject.strip()
                and body.contact_id and body.contact_id.strip()
                and body.company_id and body.company_id.strip()
            )
            if has_full_update:
                # Contact/company consistency
                company_ids = hubspot.get_contact_company_ids(body.contact_id)
                if company_ids and body.company_id not in company_ids:
                    raise HTTPException(
                        status_code=status.HTTP_400_BAD_REQUEST,
                        detail="Selected contact is not associated with the selected account.",
                    )
                existing_body = ""
                try:
                    task = hubspot.get_task(activity_id)
                    props = task.get("properties") or {}
                    existing_body = (props.get(HS_BODY) or "").strip()
                except HubSpotServiceError as e:
                    if e.status_code == 404:
                        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Activity not found")
                    raise
                if body.activity_date and body.activity_date.strip():
                    try:
                        activity_dt = datetime.strptime(body.activity_date.strip()[:10], "%Y-%m-%d").replace(
                            tzinfo=timezone.utc
                        )
                    except ValueError:
                        raise HTTPException(
                            status_code=status.HTTP_400_BAD_REQUEST,
                            detail="Activity date must be YYYY-MM-DD.",
                        )
                else:
                    activity_dt = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
                date_prefix = activity_dt.strftime("%m/%d/%y")
                new_note_line = f"{date_prefix} - {body.meeting_notes.strip()}"
                normalized_existing = _normalize_notes_body(existing_body) if existing_body else ""
                new_body = new_note_line + ("\n\n" + normalized_existing if normalized_existing else "")
                new_body = _normalize_notes_body(new_body)
                ts_ms = int(activity_dt.timestamp() * 1000)
                payload = {
                    "properties": {
                        HS_SUBJECT: body.subject.strip(),
                        HS_BODY: new_body,
                        HS_TIMESTAMP: ts_ms,
                        HS_STATUS: "COMPLETED",
                    },
                }
                hs_priority = _hubspot_priority(body.priority)
                if hs_priority is not None:
                    payload["properties"][HS_PRIORITY] = hs_priority
                task = hubspot.update_task(activity_id, payload)
                await supabase.upsert_task_cache(user_id, activity_id, task)
                if body.contact_id:
                    try:
                        hubspot.associate_task_with_contact(activity_id, body.contact_id)
                    except HubSpotServiceError as ae:
                        logger.warning("Task contact association failed: %s", ae.message)
                if body.company_id:
                    try:
                        hubspot.associate_task_with_company(activity_id, body.company_id)
                    except HubSpotServiceError as ae:
                        logger.warning("Task company association failed: %s", ae.message)
                try:
                    task_with_assoc = hubspot.get_task(activity_id, associations=["contacts", "companies"])
                    await supabase.upsert_task_cache(user_id, activity_id, task_with_assoc)
                except HubSpotServiceError as ae:
                    logger.warning("Re-fetch task with associations failed: %s", ae.message)
                return MessageResponse(message="Activity updated and marked complete")
            payload = {"properties": {HS_STATUS: "COMPLETED"}}
            hs_priority = _hubspot_priority(body.priority)
            if hs_priority is not None:
                payload["properties"][HS_PRIORITY] = hs_priority
            task = hubspot.update_task(activity_id, payload)
            await supabase.upsert_task_cache(user_id, activity_id, task)
            return MessageResponse(message="Activity marked complete")

        # Full submit: require only meeting_notes, subject, contact_id, company_id (LLM processing not required)
        if not (body.meeting_notes and body.meeting_notes.strip()):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Meeting notes are required.",
            )
        if not body.subject or not body.subject.strip():
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Subject is required.",
            )
        if not body.contact_id or not body.contact_id.strip():
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Contact is required.",
            )
        if not body.company_id or not body.company_id.strip():
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Account is required.",
            )
        if not body.due_date or not body.due_date.strip():
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Due date is required when updating an activity (unless marking as complete).",
            )

        # Contact/company consistency: contact must belong to company
        if body.contact_id and body.company_id:
            company_ids = hubspot.get_contact_company_ids(body.contact_id)
            if company_ids and body.company_id not in company_ids:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="Selected contact is not associated with the selected account.",
                )

        # Load current task body for prepending new note
        existing_body = ""
        try:
            task = hubspot.get_task(activity_id)
            props = task.get("properties") or {}
            existing_body = (props.get(HS_BODY) or "").strip()
        except HubSpotServiceError as e:
            if e.status_code == 404:
                raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Activity not found")
            raise

        # Note prefix uses activity_date (date task was performed). Default today (UTC).
        if body.activity_date and body.activity_date.strip():
            try:
                activity_dt = datetime.strptime(body.activity_date.strip()[:10], "%Y-%m-%d").replace(
                    tzinfo=timezone.utc
                )
            except ValueError:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="Activity date must be YYYY-MM-DD.",
                )
        else:
            activity_dt = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
        date_prefix = activity_dt.strftime("%m/%d/%y")
        new_note_line = f"{date_prefix} - {body.meeting_notes.strip()}"
        normalized_existing = _normalize_notes_body(existing_body) if existing_body else ""
        new_body = new_note_line + ("\n\n" + normalized_existing if normalized_existing else "")
        new_body = _normalize_notes_body(new_body)

        # Task due date in HubSpot (HS_TIMESTAMP). Use due_date if provided, else today.
        if body.due_date and body.due_date.strip():
            try:
                due_dt = datetime.strptime(body.due_date.strip()[:10], "%Y-%m-%d").replace(
                    tzinfo=timezone.utc
                )
            except ValueError:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="Due date must be YYYY-MM-DD.",
                )
        else:
            due_dt = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
        due_dt_utc = due_dt.replace(tzinfo=timezone.utc) if due_dt.tzinfo is None else due_dt
        ts_ms = int(due_dt_utc.timestamp() * 1000)
        payload = {
            "properties": {
                HS_SUBJECT: body.subject.strip(),
                HS_BODY: new_body,
                HS_TIMESTAMP: ts_ms,
                HS_STATUS: "NOT_STARTED",
            },
        }
        hs_priority = _hubspot_priority(body.priority)
        if hs_priority is not None:
            payload["properties"][HS_PRIORITY] = hs_priority
        task = hubspot.update_task(activity_id, payload)
        await supabase.upsert_task_cache(user_id, activity_id, task)

        # Optionally set associations
        if body.contact_id:
            try:
                hubspot.associate_task_with_contact(activity_id, body.contact_id)
            except HubSpotServiceError as ae:
                logger.warning("Task contact association failed: %s", ae.message)
        if body.company_id:
            try:
                hubspot.associate_task_with_company(activity_id, body.company_id)
            except HubSpotServiceError as ae:
                logger.warning("Task company association failed: %s", ae.message)

        try:
            task_with_assoc = hubspot.get_task(activity_id, associations=["contacts", "companies"])
            await supabase.upsert_task_cache(user_id, activity_id, task_with_assoc)
        except HubSpotServiceError as ae:
            logger.warning("Re-fetch task with associations failed: %s", ae.message)

        return MessageResponse(message="Activity updated successfully")
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Submit activity error: %s", e)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to submit activity",
        )


@router.post(
    "/{activity_id}/regenerate-draft",
    response_model=DraftOut,
    summary="Regenerate one draft tone",
)
async def regenerate_draft(
    activity_id: str,
    body: RegenerateDraftRequest,
    _user_id: str = Depends(get_current_user_id),
) -> DraftOut:
    """POST /api/v1/activities/{activity_id}/regenerate-draft — regenerate a single draft (e.g. formal)."""
    try:
        result = regenerate_single_draft(
            body.current_note,
            body.previous_notes,
            body.tone,
        )
        return DraftOut(text=result["text"], confidence=result.get("confidence", 75))
    except Exception as e:
        logger.exception("Regenerate draft error: %s", e)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to regenerate draft",
        )
