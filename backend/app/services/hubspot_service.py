"""
HubSpot API v3 client and operations.
Uses Bearer token auth, requests library, error handling, and rate limiting awareness.
"""

import logging
import time
from collections import deque
from typing import Any

import requests

from app.core.config import get_settings

logger = logging.getLogger(__name__)

# HubSpot rate limit: 100 requests per 10 seconds (Starter); we throttle to stay under.
RATE_LIMIT_WINDOW_SEC = 10
RATE_LIMIT_MAX_REQUESTS = 95  # leave small headroom


class HubSpotServiceError(Exception):
    """Raised when a HubSpot API call fails."""

    def __init__(
        self,
        message: str,
        status_code: int | None = None,
        detail: Any = None,
    ) -> None:
        self.message = message
        self.status_code = status_code
        self.detail = detail
        super().__init__(message)


class HubSpotService:
    """
    HubSpot API v3 service. Bearer token auth, retries on 429/5xx, rate limiting awareness.
    """

    def __init__(self, access_token: str | None = None) -> None:
        settings = get_settings()
        self._token = access_token or settings.hubspot_access_token or settings.hubspot_api_key
        self._base_url = "https://api.hubapi.com"
        self._max_retries = 3
        self._retry_status_codes = (429, 500, 502, 503)
        # Rate limiting: timestamps of recent requests (within last RATE_LIMIT_WINDOW_SEC)
        self._request_timestamps: deque[float] = deque(maxlen=RATE_LIMIT_MAX_REQUESTS + 10)

    def _get_headers(self) -> dict[str, str]:
        """Build request headers with Bearer token."""
        if not self._token:
            raise HubSpotServiceError(
                "HubSpot access token not configured. Set HUBSPOT_ACCESS_TOKEN in environment."
            )
        return {
            "Authorization": f"Bearer {self._token}",
            "Content-Type": "application/json",
        }

    def _rate_limit_wait(self) -> None:
        """If we've hit the request count in the window, sleep until oldest request exits the window."""
        now = time.monotonic()
        # Drop timestamps outside the window
        while self._request_timestamps and now - self._request_timestamps[0] >= RATE_LIMIT_WINDOW_SEC:
            self._request_timestamps.popleft()
        if len(self._request_timestamps) >= RATE_LIMIT_MAX_REQUESTS:
            sleep_time = RATE_LIMIT_WINDOW_SEC - (now - self._request_timestamps[0])
            if sleep_time > 0:
                logger.warning(
                    "HubSpot rate limit approaching: sleeping %.1fs (limit %d/%ds)",
                    sleep_time,
                    RATE_LIMIT_MAX_REQUESTS,
                    RATE_LIMIT_WINDOW_SEC,
                )
                time.sleep(sleep_time)
            self._request_timestamps.clear()

    def _handle_error(self, response: requests.Response) -> None:
        """Interpret error response and raise HubSpotServiceError with detail."""
        try:
            body = response.json()
        except Exception:
            body = response.text or None
        msg = f"HubSpot API error: {response.status_code}"
        if isinstance(body, dict):
            detail = body.get("message") or body.get("status") or body
            if body.get("category"):
                msg += f" ({body['category']})"
            if isinstance(detail, str):
                msg += f" — {detail}"
        elif isinstance(body, str) and body:
            msg += f" — {body[:500]}"
        raise HubSpotServiceError(msg, status_code=response.status_code, detail=body)

    def _request(
        self,
        method: str,
        path: str,
        *,
        params: dict[str, Any] | None = None,
        json: dict[str, Any] | list[Any] | None = None,
        retries: int | None = None,
    ) -> dict[str, Any] | list[Any]:
        """
        Execute HTTP request with rate limiting and retries on 429/5xx.
        path: e.g. /crm/v3/objects/contacts (no leading slash required).
        """
        retries = self._max_retries if retries is None else retries
        url = f"{self._base_url.rstrip('/')}/{path.lstrip('/')}"
        headers = self._get_headers()
        last_exc: Exception | None = None

        for attempt in range(retries + 1):
            self._rate_limit_wait()
            self._request_timestamps.append(time.monotonic())

            try:
                resp = requests.request(
                    method=method,
                    url=url,
                    headers=headers,
                    params=params,
                    json=json,
                    timeout=30,
                )
            except requests.RequestException as e:
                last_exc = e
                logger.warning("HubSpot request failed (attempt %d): %s", attempt + 1, e)
                if attempt < retries:
                    time.sleep(2 ** attempt)
                continue

            if resp.ok:
                if resp.status_code == 204:
                    return {}
                if not resp.content:
                    return {}
                return resp.json()

            if resp.status_code in self._retry_status_codes and attempt < retries:
                retry_after = resp.headers.get("Retry-After")
                wait = float(retry_after) if retry_after and retry_after.isdigit() else (2 ** attempt)
                logger.warning(
                    "HubSpot %s %s (attempt %d), retrying in %.1fs",
                    resp.status_code,
                    resp.reason,
                    attempt + 1,
                    wait,
                )
                time.sleep(wait)
                continue

            self._handle_error(resp)

        if last_exc:
            raise HubSpotServiceError(
                f"HubSpot request failed after {retries + 1} attempts: {last_exc!s}"
            ) from last_exc
        raise HubSpotServiceError("HubSpot request failed unexpectedly")

    # -------------------------------------------------------------------------
    # Contacts
    # -------------------------------------------------------------------------

    def get_contacts(
        self,
        limit: int = 100,
        after: str | None = None,
        properties: list[str] | None = None,
    ) -> dict[str, Any]:
        """Fetch all contacts from HubSpot. Returns list and pagination info."""
        params: dict[str, Any] = {"limit": min(limit, 100)}
        if after:
            params["after"] = after
        if properties:
            params["properties"] = ",".join(properties)
        try:
            data = self._request("GET", "/crm/v3/objects/contacts", params=params)
        except HubSpotServiceError:
            raise
        except Exception as e:
            raise HubSpotServiceError(f"Failed to fetch contacts: {e!s}") from e
        return data if isinstance(data, dict) else {"results": data}

    def get_contact(
        self,
        contact_id: str,
        properties: list[str] | None = None,
    ) -> dict[str, Any]:
        """Fetch a single contact by ID."""
        params: dict[str, Any] = {}
        if properties:
            params["properties"] = ",".join(properties)
        try:
            data = self._request(
                "GET",
                f"/crm/v3/objects/contacts/{contact_id}",
                params=params or None,
            )
        except HubSpotServiceError:
            raise
        except Exception as e:
            raise HubSpotServiceError(f"Failed to fetch contact {contact_id}: {e!s}") from e
        if not isinstance(data, dict):
            raise HubSpotServiceError(f"Unexpected response for contact {contact_id}")
        return data

    def create_contact(self, contact_data: dict[str, Any]) -> dict[str, Any]:
        """Create a new contact. contact_data can be {'properties': {...}} or flat properties."""
        if "properties" not in contact_data:
            contact_data = {"properties": contact_data}
        props = contact_data.get("properties") or {}
        logger.info(
            "HubSpot create_contact: POST /crm/v3/objects/contacts property_keys=%s",
            list(props.keys()),
        )
        try:
            data = self._request("POST", "/crm/v3/objects/contacts", json=contact_data)
        except HubSpotServiceError as e:
            logger.warning(
                "HubSpot create_contact: API error status_code=%s message=%s",
                e.status_code,
                e.message,
            )
            raise
        except Exception as e:
            logger.exception("HubSpot create_contact: request failed: %s", e)
            raise HubSpotServiceError(f"Failed to create contact: {e!s}") from e
        if not isinstance(data, dict):
            logger.error("HubSpot create_contact: unexpected response type %s", type(data).__name__)
            raise HubSpotServiceError("Unexpected response when creating contact")
        contact_id = data.get("id")
        logger.info("HubSpot create_contact: success id=%s", contact_id)
        return data

    def update_contact(
        self,
        contact_id: str,
        contact_data: dict[str, Any],
    ) -> dict[str, Any]:
        """Update an existing contact by ID."""
        if "properties" not in contact_data:
            contact_data = {"properties": contact_data}
        try:
            data = self._request(
                "PATCH",
                f"/crm/v3/objects/contacts/{contact_id}",
                json=contact_data,
            )
        except HubSpotServiceError:
            raise
        except Exception as e:
            raise HubSpotServiceError(f"Failed to update contact {contact_id}: {e!s}") from e
        if not isinstance(data, dict):
            raise HubSpotServiceError(f"Unexpected response when updating contact {contact_id}")
        return data

    def delete_contact(self, contact_id: str) -> None:
        """Archive (soft-delete) a contact by ID."""
        try:
            self._request("DELETE", f"/crm/v3/objects/contacts/{contact_id}")
        except HubSpotServiceError:
            raise
        except Exception as e:
            raise HubSpotServiceError(f"Failed to delete contact {contact_id}: {e!s}") from e

    # -------------------------------------------------------------------------
    # Companies
    # -------------------------------------------------------------------------

    def get_companies(
        self,
        limit: int = 100,
        after: str | None = None,
        properties: list[str] | None = None,
    ) -> dict[str, Any]:
        """Fetch all companies from HubSpot. Returns list and pagination info."""
        params: dict[str, Any] = {"limit": min(limit, 100)}
        if after:
            params["after"] = after
        if properties:
            params["properties"] = ",".join(properties)
        try:
            data = self._request("GET", "/crm/v3/objects/companies", params=params)
        except HubSpotServiceError:
            raise
        except Exception as e:
            raise HubSpotServiceError(f"Failed to fetch companies: {e!s}") from e
        return data if isinstance(data, dict) else {"results": data}

    def get_company(
        self,
        company_id: str,
        properties: list[str] | None = None,
    ) -> dict[str, Any]:
        """Fetch a single company by ID."""
        params: dict[str, Any] = {}
        if properties:
            params["properties"] = ",".join(properties)
        try:
            data = self._request(
                "GET",
                f"/crm/v3/objects/companies/{company_id}",
                params=params or None,
            )
        except HubSpotServiceError:
            raise
        except Exception as e:
            raise HubSpotServiceError(f"Failed to fetch company {company_id}: {e!s}") from e
        if not isinstance(data, dict):
            raise HubSpotServiceError(f"Unexpected response for company {company_id}")
        return data

    def create_company(self, company_data: dict[str, Any]) -> dict[str, Any]:
        """Create a new company. company_data can be {'properties': {...}} or flat properties."""
        if "properties" not in company_data:
            company_data = {"properties": company_data}
        try:
            data = self._request("POST", "/crm/v3/objects/companies", json=company_data)
        except HubSpotServiceError:
            raise
        except Exception as e:
            raise HubSpotServiceError(f"Failed to create company: {e!s}") from e
        if not isinstance(data, dict):
            raise HubSpotServiceError("Unexpected response when creating company")
        return data

    # -------------------------------------------------------------------------
    # Tasks (activities)
    # -------------------------------------------------------------------------

    TASK_PROPERTIES = [
        "hs_timestamp",
        "hs_task_subject",
        "hs_task_body",
        "hs_task_status",
        "hs_task_priority",
        "hs_task_type",
        "hs_createdate",
        "hs_lastmodifieddate",
    ]

    def get_tasks(
        self,
        limit: int = 100,
        after: str | None = None,
        properties: list[str] | None = None,
        associations: list[str] | None = None,
    ) -> dict[str, Any]:
        """Fetch all tasks from HubSpot. Returns list and pagination info."""
        params: dict[str, Any] = {"limit": min(limit, 100)}
        if after:
            params["after"] = after
        if properties:
            params["properties"] = ",".join(properties)
        else:
            params["properties"] = ",".join(self.TASK_PROPERTIES)
        if associations:
            params["associations"] = ",".join(associations)
        try:
            data = self._request("GET", "/crm/v3/objects/tasks", params=params)
        except HubSpotServiceError:
            raise
        except Exception as e:
            raise HubSpotServiceError(f"Failed to fetch tasks: {e!s}") from e
        return data if isinstance(data, dict) else {"results": data}

    def search_tasks(
        self,
        due_date_from_ms: int | None = None,
        due_date_to_ms: int | None = None,
        query: str | None = None,
        limit: int = 100,
        after: str | None = None,
        properties: list[str] | None = None,
    ) -> dict[str, Any]:
        """
        Search tasks by due date (hs_timestamp) and/or by text query.
        Use POST /crm/v3/objects/tasks/search. When query is set, HubSpot searches
        task subject/body (and possibly related). Returns all statuses (completed + not completed).
        """
        body: dict[str, Any] = {"limit": min(limit, 200), "sorts": []}
        if after is not None:
            body["after"] = after
        if properties:
            body["properties"] = properties
        else:
            body["properties"] = self.TASK_PROPERTIES.copy()

        filter_groups: list[dict[str, Any]] = []
        if due_date_from_ms is not None or due_date_to_ms is not None:
            filters: list[dict[str, Any]] = []
            if due_date_from_ms is not None:
                filters.append({
                    "propertyName": "hs_timestamp",
                    "operator": "GTE",
                    "value": str(due_date_from_ms),
                })
            if due_date_to_ms is not None:
                filters.append({
                    "propertyName": "hs_timestamp",
                    "operator": "LTE",
                    "value": str(due_date_to_ms),
                })
            if filters:
                filter_groups.append({"filters": filters})
        body["filterGroups"] = filter_groups if filter_groups else []

        if query and query.strip():
            body["query"] = query.strip()[:3000]

        try:
            data = self._request(
                "POST",
                "/crm/v3/objects/tasks/search",
                json=body,
            )
        except HubSpotServiceError:
            raise
        except Exception as e:
            raise HubSpotServiceError(f"Failed to search tasks: {e!s}") from e
        if not isinstance(data, dict):
            return {"results": data, "total": len(data) if isinstance(data, list) else 0}
        return data

    def batch_read_tasks(
        self,
        task_ids: list[str],
        properties: list[str] | None = None,
        associations: list[str] | None = None,
    ) -> list[dict[str, Any]]:
        """Batch read tasks by IDs. Optional associations (e.g. contacts, companies). Max 100 per request."""
        if not task_ids:
            return []
        ids = task_ids[:100]
        body: dict[str, Any] = {
            "inputs": [{"id": tid} for tid in ids],
            "properties": properties or self.TASK_PROPERTIES.copy(),
        }
        if associations:
            body["associations"] = associations
        try:
            data = self._request(
                "POST",
                "/crm/v3/objects/tasks/batch/read",
                json=body,
            )
        except HubSpotServiceError:
            raise
        except Exception as e:
            raise HubSpotServiceError(f"Failed to batch read tasks: {e!s}") from e
        if isinstance(data, list):
            return data
        if isinstance(data, dict) and "results" in data:
            return data["results"]
        return []

    def batch_read_task_associations(
        self,
        task_ids: list[str],
        to_object_type: str,
    ) -> dict[str, list[str]]:
        """
        Batch read task-to-object associations (e.g. contacts, companies).
        POST /crm/v3/associations/tasks/{to_object_type}/batch/read.
        Returns dict task_id -> list of associated object IDs. Max 100 task IDs per request.
        """
        if not task_ids:
            return {}
        ids = task_ids[:100]
        body: dict[str, Any] = {"inputs": [{"id": tid} for tid in ids]}
        try:
            data = self._request(
                "POST",
                f"/crm/v3/associations/tasks/{to_object_type}/batch/read",
                json=body,
            )
        except HubSpotServiceError:
            raise
        except Exception as e:
            raise HubSpotServiceError(
                f"Failed to batch read task-{to_object_type} associations: {e!s}"
            ) from e
        result: dict[str, list[str]] = {}
        for r in (data.get("results", []) if isinstance(data, dict) else []):
            from_obj = r.get("from") or {}
            from_id = from_obj.get("id") if isinstance(from_obj, dict) else None
            to_list = r.get("to") or []
            if from_id is not None:
                ids_list = []
                for t in to_list:
                    if isinstance(t, dict) and t.get("id"):
                        ids_list.append(str(t["id"]))
                result[str(from_id)] = ids_list
        # [CONTACT_DEBUG] Log association lookup: requested task_ids vs tasks that had associations
        tasks_with_assoc = list(result.keys())
        tasks_without = [tid for tid in ids if str(tid) not in result]
        if tasks_without:
            logger.info(
                "[contact_debug] batch_read_task_associations(%s): requested=%s, with_assoc=%s, without=%s (sample)",
                to_object_type,
                len(ids),
                len(tasks_with_assoc),
                len(tasks_without),
            )
            logger.info("[contact_debug] sample task_ids without %s: %s", to_object_type, tasks_without[:5])
        return result

    def get_task(
        self,
        task_id: str,
        properties: list[str] | None = None,
        associations: list[str] | None = None,
    ) -> dict[str, Any]:
        """Fetch a single task by ID, optionally with associations (e.g. contacts)."""
        params: dict[str, Any] = {}
        if properties:
            params["properties"] = ",".join(properties)
        else:
            params["properties"] = ",".join(self.TASK_PROPERTIES)
        if associations:
            params["associations"] = ",".join(associations)
        try:
            data = self._request(
                "GET",
                f"/crm/v3/objects/tasks/{task_id}",
                params=params or None,
            )
        except HubSpotServiceError:
            raise
        except Exception as e:
            raise HubSpotServiceError(f"Failed to fetch task {task_id}: {e!s}") from e
        if not isinstance(data, dict):
            raise HubSpotServiceError(f"Unexpected response for task {task_id}")
        return data

    def get_contacts_batch(
        self,
        contact_ids: list[str],
        properties: list[str] | None = None,
    ) -> list[dict[str, Any]]:
        """Batch fetch contacts by IDs. HubSpot batch read up to 100 per request."""
        if not contact_ids:
            return []
        props = properties or ["firstname", "lastname", "email", "phone", "mobilephone"]
        body: dict[str, Any] = {
            "properties": props,
            "inputs": [{"id": cid} for cid in contact_ids[:100]],
        }
        try:
            data = self._request(
                "POST",
                "/crm/v3/objects/contacts/batch/read",
                json=body,
            )
        except HubSpotServiceError:
            raise
        except Exception as e:
            raise HubSpotServiceError(f"Failed to batch fetch contacts: {e!s}") from e
        out: list[dict[str, Any]] = data if isinstance(data, list) else (data["results"] if isinstance(data, dict) and "results" in data else [])
        # [CONTACT_DEBUG] Log batch contact fetch: requested vs returned (IDs not returned might be deleted or invalid)
        requested = contact_ids[:100]
        returned_ids = [str(c.get("id", "")) for c in out if c.get("id")]
        missing = [cid for cid in requested if str(cid) not in returned_ids]
        if missing:
            logger.info(
                "[contact_debug] get_contacts_batch: requested=%s, returned=%s, missing_from_response=%s (sample)",
                len(requested),
                len(out),
                len(missing),
            )
            logger.info("[contact_debug] get_contacts_batch missing id types: %s", [type(c).__name__ for c in missing[:5]])
        return out

    def create_task(self, task_data: dict[str, Any]) -> dict[str, Any]:
        """Create a new task. task_data can be {'properties': {...}} or flat properties."""
        if "properties" not in task_data:
            task_data = {"properties": task_data}
        try:
            data = self._request("POST", "/crm/v3/objects/tasks", json=task_data)
        except HubSpotServiceError:
            raise
        except Exception as e:
            raise HubSpotServiceError(f"Failed to create task: {e!s}") from e
        if not isinstance(data, dict):
            raise HubSpotServiceError("Unexpected response when creating task")
        return data

    def update_task(
        self,
        task_id: str,
        task_data: dict[str, Any],
    ) -> dict[str, Any]:
        """Update an existing task by ID."""
        if "properties" not in task_data:
            task_data = {"properties": task_data}
        try:
            data = self._request(
                "PATCH",
                f"/crm/v3/objects/tasks/{task_id}",
                json=task_data,
            )
        except HubSpotServiceError:
            raise
        except Exception as e:
            raise HubSpotServiceError(f"Failed to update task {task_id}: {e!s}") from e
        if not isinstance(data, dict):
            raise HubSpotServiceError(f"Unexpected response when updating task {task_id}")
        return data

    def delete_task(self, task_id: str) -> None:
        """Delete (archive) a task by ID. HubSpot returns 204."""
        try:
            self._request("DELETE", f"/crm/v3/objects/tasks/{task_id}")
        except HubSpotServiceError:
            raise
        except Exception as e:
            raise HubSpotServiceError(f"Failed to delete task {task_id}: {e!s}") from e

    def associate_task_with_contact(self, task_id: str, contact_id: str) -> None:
        """Create default association between task and contact (v4 API; object types are singular)."""
        try:
            self._request(
                "PUT",
                f"/crm/v4/objects/task/{task_id}/associations/default/contact/{contact_id}",
            )
        except HubSpotServiceError:
            raise
        except Exception as e:
            raise HubSpotServiceError(
                f"Failed to associate task {task_id} with contact {contact_id}: {e!s}"
            ) from e

    def associate_task_with_company(self, task_id: str, company_id: str) -> None:
        """Create default association between task and company (v4 API; object types are singular)."""
        try:
            self._request(
                "PUT",
                f"/crm/v4/objects/task/{task_id}/associations/default/company/{company_id}",
            )
        except HubSpotServiceError:
            raise
        except Exception as e:
            raise HubSpotServiceError(
                f"Failed to associate task {task_id} with company {company_id}: {e!s}"
            ) from e

    # -------------------------------------------------------------------------
    # Search
    # -------------------------------------------------------------------------

    def search_contacts(
        self,
        query: str,
        limit: int = 100,
        after: str | None = None,
        properties: list[str] | None = None,
    ) -> dict[str, Any]:
        """
        Search contacts by name/email. Uses HubSpot search default text search
        (firstname, lastname, email, phone, etc.). query is case-insensitive.
        """
        body: dict[str, Any] = {
            "query": query,
            "limit": min(limit, 200),
        }
        if after:
            body["after"] = after
        if properties:
            body["properties"] = properties
        try:
            data = self._request(
                "POST",
                "/crm/v3/objects/contacts/search",
                json=body,
            )
        except HubSpotServiceError:
            raise
        except Exception as e:
            raise HubSpotServiceError(f"Failed to search contacts: {e!s}") from e
        if not isinstance(data, dict):
            raise HubSpotServiceError("Unexpected response when searching contacts")
        return data

    def search_companies(
        self,
        query: str,
        limit: int = 50,
        after: str | None = None,
        properties: list[str] | None = None,
    ) -> dict[str, Any]:
        """
        Search companies by name/domain/website/phone. Uses HubSpot default text search.
        """
        body: dict[str, Any] = {
            "query": query,
            "limit": min(limit, 100),
        }
        if after:
            body["after"] = after
        if properties:
            body["properties"] = properties
        try:
            data = self._request(
                "POST",
                "/crm/v3/objects/companies/search",
                json=body,
            )
        except HubSpotServiceError:
            raise
        except Exception as e:
            raise HubSpotServiceError(f"Failed to search companies: {e!s}") from e
        if not isinstance(data, dict):
            raise HubSpotServiceError("Unexpected response when searching companies")
        return data

    def get_company_contact_ids(self, company_id: str) -> list[str]:
        """
        Get contact IDs associated with a company (v4 associations API).
        """
        try:
            data = self._request(
                "GET",
                f"/crm/v4/objects/companies/{company_id}/associations/contacts",
            )
        except HubSpotServiceError:
            raise
        except Exception as e:
            raise HubSpotServiceError(
                f"Failed to get contacts for company {company_id}: {e!s}"
            ) from e
        if isinstance(data, dict) and "results" in data:
            ids = []
            for r in data["results"]:
                if not isinstance(r, dict):
                    continue
                oid = r.get("toObjectId") or r.get("id")
                if oid is not None:
                    ids.append(str(oid))
            return ids
        if isinstance(data, list):
            return [str(r.get("toObjectId") or r.get("id") or r) for r in data if isinstance(r, dict) and (r.get("toObjectId") or r.get("id"))]
        return []

    def get_contact_company_ids(self, contact_id: str) -> list[str]:
        """
        Get company IDs associated with a contact (v4 associations API).
        """
        try:
            data = self._request(
                "GET",
                f"/crm/v4/objects/contacts/{contact_id}/associations/companies",
            )
        except HubSpotServiceError:
            raise
        except Exception as e:
            raise HubSpotServiceError(
                f"Failed to get companies for contact {contact_id}: {e!s}"
            ) from e
        if isinstance(data, dict) and "results" in data:
            ids = []
            for r in data["results"]:
                if not isinstance(r, dict):
                    continue
                oid = r.get("toObjectId") or r.get("id")
                if oid is not None:
                    ids.append(str(oid))
            return ids
        if isinstance(data, list):
            return [str(r.get("toObjectId") or r.get("id") or r) for r in data if isinstance(r, dict) and (r.get("toObjectId") or r.get("id"))]
        return []

    def batch_read_contact_company_ids(self, contact_ids: list[str]) -> dict[str, str]:
        """
        Batch read contact->company associations. Returns dict contact_id -> first company_id.
        """
        if not contact_ids:
            return {}
        body: dict[str, Any] = {
            "inputs": [{"id": cid} for cid in contact_ids[:100]],
        }
        try:
            data = self._request(
                "POST",
                "/crm/v4/associations/contacts/companies/batch/read",
                json=body,
            )
        except HubSpotServiceError:
            raise
        except Exception as e:
            raise HubSpotServiceError(f"Failed to batch read contact-company associations: {e!s}") from e
        result: dict[str, str] = {}
        results = data.get("results", []) if isinstance(data, dict) else []
        for r in results:
            from_id = (r.get("from") or {}).get("id")
            to_list = r.get("to") or []
            if from_id is not None and to_list:
                first_to = to_list[0] if isinstance(to_list[0], dict) else None
                if first_to:
                    to_id = first_to.get("toObjectId") or first_to.get("id")
                    if to_id is not None:
                        result[str(from_id)] = str(to_id)
        return result

    def get_companies_batch(
        self,
        company_ids: list[str],
        properties: list[str] | None = None,
    ) -> list[dict[str, Any]]:
        """Batch fetch companies by IDs. HubSpot batch read up to 100 per request."""
        if not company_ids:
            return []
        props = properties or ["name"]
        body: dict[str, Any] = {
            "properties": props,
            "inputs": [{"id": cid} for cid in company_ids[:100]],
        }
        try:
            data = self._request(
                "POST",
                "/crm/v3/objects/companies/batch/read",
                json=body,
            )
        except HubSpotServiceError:
            raise
        except Exception as e:
            raise HubSpotServiceError(f"Failed to batch fetch companies: {e!s}") from e
        if isinstance(data, list):
            return data
        if isinstance(data, dict) and "results" in data:
            return data["results"]
        return []

    def associate_contact_with_company(self, contact_id: str, company_id: str) -> None:
        """
        Create default association between a contact and a company (v4 API).
        PUT /crm/v4/objects/contact/{contactId}/associations/default/company/{companyId}
        """
        try:
            self._request(
                "PUT",
                f"/crm/v4/objects/contact/{contact_id}/associations/default/company/{company_id}",
            )
        except HubSpotServiceError:
            raise
        except Exception as e:
            raise HubSpotServiceError(
                f"Failed to associate contact {contact_id} with company {company_id}: {e!s}"
            ) from e


def get_hubspot_service(access_token: str | None = None) -> HubSpotService:
    """Dependency: return a HubSpotService instance."""
    return HubSpotService(access_token=access_token)
