"""
Supabase client: auth (sign up, sign in, password reset), token verification, user profiles.
"""

import logging
from datetime import datetime, timezone
from typing import Any, Dict, Optional, Union

from fastapi import HTTPException, status
from supabase import Client, create_client

from app.core.config import get_settings

logger = logging.getLogger(__name__)
settings = get_settings()


class SupabaseService:
    def __init__(self) -> None:
        self.client: Client = create_client(
            settings.SUPABASE_URL,
            settings.SUPABASE_SERVICE_KEY,
        )
        self.auth_client: Client = create_client(
            settings.SUPABASE_URL,
            settings.SUPABASE_ANON_KEY,
        )

    async def sign_up(self, email: str, password: str, full_name: str) -> Dict[str, Any]:
        """Register a new user."""
        try:
            response = self.auth_client.auth.sign_up(
                {
                    "email": email,
                    "password": password,
                    "options": {
                        "data": {
                            "full_name": full_name,
                        }
                    },
                }
            )

            if not response.user:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="Failed to create user",
                )

            return {
                "user": response.user,
                "session": response.session,
            }
        except HTTPException:
            raise
        except Exception as e:
            logger.error("Signup error: %s", str(e))
            if "already registered" in str(e).lower():
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="Email already registered",
                )
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail=str(e),
            )

    async def sign_in(self, email: str, password: str) -> Dict[str, Any]:
        """Sign in a user."""
        try:
            response = self.auth_client.auth.sign_in_with_password(
                {
                    "email": email,
                    "password": password,
                }
            )

            if not response.user or not response.session:
                raise HTTPException(
                    status_code=status.HTTP_401_UNAUTHORIZED,
                    detail="Invalid credentials",
                )

            return {
                "user": response.user,
                "session": response.session,
            }
        except HTTPException:
            raise
        except Exception as e:
            logger.error("Signin error: %s", str(e))
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid email or password",
            )

    async def sign_out(self, access_token: str) -> bool:
        """Sign out a user."""
        try:
            self.client.auth.sign_out()
            return True
        except Exception as e:
            logger.error("Signout error: %s", str(e))
            return False

    async def verify_token(self, access_token: str) -> Dict[str, Any]:
        """Verify access token and return user."""
        try:
            response = self.client.auth.get_user(access_token)

            if not response.user:
                raise HTTPException(
                    status_code=status.HTTP_401_UNAUTHORIZED,
                    detail="Invalid or expired token",
                )

            return response.user
        except HTTPException:
            raise
        except Exception as e:
            logger.error("Token verification error: %s", str(e))
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid or expired token",
            )

    async def get_user_profile(self, user_id: str) -> Optional[Dict[str, Any]]:
        """Get user profile from database."""
        try:
            response = (
                self.client.table("user_profiles")
                .select("*")
                .eq("id", user_id)
                .execute()
            )

            if response.data and len(response.data) > 0:
                return response.data[0]
            return None
        except Exception as e:
            logger.error("Get profile error: %s", str(e))
            return None

    async def update_user_profile(
        self, user_id: str, data: Dict[str, Any]
    ) -> Dict[str, Any]:
        """Update user profile."""
        try:
            response = (
                self.client.table("user_profiles")
                .update(data)
                .eq("id", user_id)
                .execute()
            )

            if response.data and len(response.data) > 0:
                return response.data[0]
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Profile not found",
            )
        except HTTPException:
            raise
        except Exception as e:
            logger.error("Update profile error: %s", str(e))
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Failed to update profile",
            )

    async def send_password_reset(self, email: str) -> bool:
        """Send password reset email."""
        try:
            self.auth_client.auth.reset_password_for_email(
                email,
                options={
                    "redirect_to": f"{settings.frontend_url}/reset-password",
                },
            )
            return True
        except Exception as e:
            logger.error("Password reset error: %s", str(e))
            # Don't reveal if email exists
            return True

    async def update_password(self, access_token: str, new_password: str) -> bool:
        """Update user password."""
        try:
            self.client.auth.update_user(
                {
                    "password": new_password,
                }
            )
            return True
        except Exception as e:
            logger.error("Password update error: %s", str(e))
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Failed to update password",
            )

    # -------------------------------------------------------------------------
    # HubSpot tasks cache (hubspot_tasks_cache table)
    # -------------------------------------------------------------------------

    async def get_tasks_cache_freshness(self, user_id: str) -> Optional[str]:
        """
        Return the most recent last_synced_at (ISO string) for this user's cache,
        or None if no cached rows.
        """
        try:
            response = (
                self.client.table("hubspot_tasks_cache")
                .select("last_synced_at")
                .eq("user_id", user_id)
                .order("last_synced_at", desc=True)
                .limit(1)
                .execute()
            )
            if response.data and len(response.data) > 0 and response.data[0].get("last_synced_at"):
                return response.data[0]["last_synced_at"]
            return None
        except Exception as e:
            logger.error("Get tasks cache freshness error: %s", str(e))
            return None

    async def get_tasks_cache(self, user_id: str) -> list[Dict[str, Any]]:
        """Return all cached task rows for user (each has hubspot_task_id, data, last_synced_at)."""
        try:
            response = (
                self.client.table("hubspot_tasks_cache")
                .select("id, hubspot_task_id, data, last_synced_at, created_at")
                .eq("user_id", user_id)
                .execute()
            )
            return list(response.data) if response.data else []
        except Exception as e:
            logger.error("Get tasks cache error: %s", str(e))
            return []

    async def upsert_task_cache(
        self,
        user_id: str,
        hubspot_task_id: str,
        data: Dict[str, Any],
    ) -> Dict[str, Any]:
        """Insert or update a single task in hubspot_tasks_cache."""
        try:
            now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
            response = (
                self.client.table("hubspot_tasks_cache")
                .upsert(
                    {
                        "user_id": user_id,
                        "hubspot_task_id": hubspot_task_id,
                        "data": data,
                        "last_synced_at": now,
                    },
                    on_conflict="user_id,hubspot_task_id",
                )
                .execute()
            )
            if response.data and len(response.data) > 0:
                return response.data[0]
            return {"user_id": user_id, "hubspot_task_id": hubspot_task_id, "data": data}
        except Exception as e:
            logger.error("Upsert task cache error: %s", str(e))
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Failed to update tasks cache",
            )

    async def upsert_tasks_cache_bulk(
        self,
        user_id: str,
        tasks: list[Dict[str, Any]],
    ) -> None:
        """Insert or update multiple tasks in hubspot_tasks_cache. Each task dict must have 'id' and full object."""
        if not tasks:
            return
        try:
            now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
            rows = [
                {
                    "user_id": user_id,
                    "hubspot_task_id": t.get("id") or t["id"],
                    "data": t,
                    "last_synced_at": now,
                }
                for t in tasks
            ]
            self.client.table("hubspot_tasks_cache").upsert(
                rows,
                on_conflict="user_id,hubspot_task_id",
            ).execute()
        except Exception as e:
            logger.error("Upsert tasks cache bulk error: %s", str(e))
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Failed to update tasks cache",
            )

    async def delete_task_cache(self, user_id: str, hubspot_task_id: str) -> bool:
        """Remove one task from cache. Returns True if deleted."""
        try:
            response = (
                self.client.table("hubspot_tasks_cache")
                .delete()
                .eq("user_id", user_id)
                .eq("hubspot_task_id", hubspot_task_id)
                .execute()
            )
            return bool(response.data)
        except Exception as e:
            logger.error("Delete task cache error: %s", str(e))
            return False

    async def delete_tasks_cache_for_user(self, user_id: str) -> None:
        """Remove all cached tasks for this user. Use after syncing from HubSpot so cache matches HubSpot exactly."""
        try:
            self.client.table("hubspot_tasks_cache").delete().eq("user_id", user_id).execute()
        except Exception as e:
            logger.error("Delete all tasks cache for user error: %s", str(e))
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Failed to clear tasks cache",
            )

    # -------------------------------------------------------------------------
    # HubSpot companies cache (hubspot_companies_cache table)
    # -------------------------------------------------------------------------

    async def upsert_company_cache(
        self,
        user_id: str,
        hubspot_company_id: str,
        data: Dict[str, Any],
    ) -> Dict[str, Any]:
        """Insert or update a single company in hubspot_companies_cache."""
        try:
            now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
            response = (
                self.client.table("hubspot_companies_cache")
                .upsert(
                    {
                        "user_id": user_id,
                        "hubspot_company_id": hubspot_company_id,
                        "data": data,
                        "last_synced_at": now,
                    },
                    on_conflict="user_id,hubspot_company_id",
                )
                .execute()
            )
            if response.data and len(response.data) > 0:
                return response.data[0]
            return {"user_id": user_id, "hubspot_company_id": hubspot_company_id, "data": data}
        except Exception as e:
            logger.error("Upsert company cache error: %s", str(e))
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Failed to update companies cache",
            )

    # -------------------------------------------------------------------------
    # Task communication summaries (task_communication_summaries table)
    # -------------------------------------------------------------------------

    async def get_communication_summary(
        self, user_id: str, hubspot_task_id: str
    ) -> Optional[Dict[str, Any]]:
        """Return stored communication summary for this task, or None if not found."""
        try:
            response = (
                self.client.table("task_communication_summaries")
                .select("summary, times_contacted, relationship_status, notes_hash, updated_at")
                .eq("user_id", user_id)
                .eq("hubspot_task_id", hubspot_task_id)
                .limit(1)
                .execute()
            )
            if response.data and len(response.data) > 0:
                return response.data[0]
            return None
        except Exception as e:
            logger.error("Get communication summary error: %s", str(e))
            return None

    async def upsert_communication_summary(
        self,
        user_id: str,
        hubspot_task_id: str,
        summary: str,
        times_contacted: str,
        relationship_status: str,
        notes_hash: str,
    ) -> Dict[str, Any]:
        """Insert or update communication summary for this task."""
        try:
            now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
            row = {
                "user_id": user_id,
                "hubspot_task_id": hubspot_task_id,
                "summary": summary or "",
                "times_contacted": times_contacted or "",
                "relationship_status": relationship_status or "",
                "notes_hash": notes_hash or "",
                "updated_at": now,
            }
            response = (
                self.client.table("task_communication_summaries")
                .upsert(row, on_conflict="user_id,hubspot_task_id")
                .execute()
            )
            if response.data and len(response.data) > 0:
                return response.data[0]
            return row
        except Exception as e:
            logger.error("Upsert communication summary error: %s", str(e))
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Failed to save communication summary",
            )

    # -------------------------------------------------------------------------
    # HubSpot contacts cache (hubspot_contacts_cache table)
    # -------------------------------------------------------------------------

    async def get_contacts_cache(self, user_id: str) -> list[Dict[str, Any]]:
        """Return all cached contact rows for user (each has hubspot_contact_id, data, last_synced_at)."""
        try:
            response = (
                self.client.table("hubspot_contacts_cache")
                .select("id, hubspot_contact_id, data, last_synced_at, created_at")
                .eq("user_id", user_id)
                .execute()
            )
            return list(response.data) if response.data else []
        except Exception as e:
            logger.error("Get contacts cache error: %s", str(e))
            return []

    async def upsert_contact_cache(
        self,
        user_id: str,
        hubspot_contact_id: str,
        data: Dict[str, Any],
    ) -> Dict[str, Any]:
        """Insert or update a single contact in hubspot_contacts_cache."""
        logger.info(
            "upsert_contact_cache: user_id=%s hubspot_contact_id=%s",
            user_id,
            hubspot_contact_id,
        )
        try:
            now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
            response = (
                self.client.table("hubspot_contacts_cache")
                .upsert(
                    {
                        "user_id": user_id,
                        "hubspot_contact_id": hubspot_contact_id,
                        "data": data,
                        "last_synced_at": now,
                    },
                    on_conflict="user_id,hubspot_contact_id",
                )
                .execute()
            )
            if response.data and len(response.data) > 0:
                logger.info("upsert_contact_cache: success hubspot_contact_id=%s", hubspot_contact_id)
                return response.data[0]
            return {"user_id": user_id, "hubspot_contact_id": hubspot_contact_id, "data": data}
        except Exception as e:
            logger.error("upsert_contact_cache: error user_id=%s hubspot_contact_id=%s: %s", user_id, hubspot_contact_id, str(e))
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Failed to update contacts cache",
            )

    async def upsert_contacts_cache_bulk(
        self,
        user_id: str,
        contacts: list[Dict[str, Any]],
    ) -> None:
        """Insert or update multiple contacts in hubspot_contacts_cache."""
        if not contacts:
            return
        try:
            now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
            rows = [
                {
                    "user_id": user_id,
                    "hubspot_contact_id": c.get("id") or c["id"],
                    "data": c,
                    "last_synced_at": now,
                }
                for c in contacts
            ]
            self.client.table("hubspot_contacts_cache").upsert(
                rows,
                on_conflict="user_id,hubspot_contact_id",
            ).execute()
        except Exception as e:
            logger.error("Upsert contacts cache bulk error: %s", str(e))
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Failed to update contacts cache",
            )

    async def delete_contact_cache(self, user_id: str, hubspot_contact_id: str) -> bool:
        """Remove one contact from cache. Returns True if deleted."""
        try:
            response = (
                self.client.table("hubspot_contacts_cache")
                .delete()
                .eq("user_id", user_id)
                .eq("hubspot_contact_id", hubspot_contact_id)
                .execute()
            )
            return bool(response.data)
        except Exception as e:
            logger.error("Delete contact cache error: %s", str(e))
            return False

    # -------------------------------------------------------------------------
    # User dashboard state (user_dashboard_state table)
    # -------------------------------------------------------------------------

    async def get_dashboard_state(self, user_id: str) -> Optional[Dict[str, Any]]:
        """Return the user's dashboard state row, or None if none exists."""
        try:
            response = (
                self.client.table("user_dashboard_state")
                .select("selected_activity_id, sort_option, filter_state, date_picker_value, updated_at")
                .eq("user_id", user_id)
                .limit(1)
                .execute()
            )
            if response.data and len(response.data) > 0:
                return response.data[0]
            return None
        except Exception as e:
            logger.error("Get dashboard state error: %s", str(e))
            return None

    async def upsert_dashboard_state(
        self,
        user_id: str,
        data: Dict[str, Any],
    ) -> Dict[str, Any]:
        """Insert or update user_dashboard_state for user_id. Merges with existing state."""
        try:
            existing = await self.get_dashboard_state(user_id)
            # Merge: existing defaults, then override with data
            row: Dict[str, Any] = {
                "user_id": user_id,
                "selected_activity_id": existing.get("selected_activity_id") if existing else None,
                "sort_option": (existing.get("sort_option") or "due_date_oldest") if existing else "due_date_oldest",
                "filter_state": (existing.get("filter_state") or {}) if existing else {},
                "date_picker_value": existing.get("date_picker_value") if existing else None,
            }
            if "selected_activity_id" in data:
                row["selected_activity_id"] = data["selected_activity_id"]
            if "sort_option" in data:
                row["sort_option"] = data["sort_option"]
            if "filter_state" in data:
                row["filter_state"] = data["filter_state"]
            if "date_picker_value" in data:
                row["date_picker_value"] = data["date_picker_value"]
            response = (
                self.client.table("user_dashboard_state")
                .upsert(row, on_conflict="user_id")
                .execute()
            )
            if response.data and len(response.data) > 0:
                return response.data[0]
            return (await self.get_dashboard_state(user_id)) or row
        except Exception as e:
            logger.error("Upsert dashboard state error: %s", str(e))
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Failed to update dashboard state",
            )

    async def delete_dashboard_state(self, user_id: str) -> None:
        """Delete the user's dashboard state row. After sign out, next GET returns defaults (today)."""
        try:
            self.client.table("user_dashboard_state").delete().eq(
                "user_id", user_id
            ).execute()
        except Exception as e:
            logger.error("Delete dashboard state error: %s", str(e))
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Failed to delete dashboard state",
            )

    # -------------------------------------------------------------------------
    # Gmail OAuth tokens (gmail_tokens table)
    # -------------------------------------------------------------------------

    async def get_gmail_tokens(self, user_id: str) -> Optional[Dict[str, Any]]:
        """Return Gmail tokens for user, or None if not connected."""
        try:
            response = (
                self.client.table("gmail_tokens")
                .select("access_token, refresh_token, token_expiry, last_connected_at, email")
                .eq("user_id", user_id)
                .limit(1)
                .execute()
            )
            if response.data and len(response.data) > 0:
                return response.data[0]
            return None
        except Exception as e:
            logger.error("Get Gmail tokens error: %s", str(e))
            return None

    async def upsert_gmail_tokens(
        self,
        user_id: str,
        access_token: str,
        refresh_token: Optional[str] = None,
        token_expiry: Optional[Union[datetime, str]] = None,
        last_connected_at: Optional[datetime] = None,
        email: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Insert or update Gmail tokens for user. Pass last_connected_at and email when user completes OAuth connect. token_expiry can be an ISO str (with timezone) or datetime."""
        try:
            now = datetime.now(timezone.utc)
            row: Dict[str, Any] = {
                "user_id": user_id,
                "access_token": access_token,
                "refresh_token": refresh_token,
                "updated_at": now.isoformat().replace("+00:00", "Z"),
            }
            if token_expiry is not None:
                row["token_expiry"] = (
                    token_expiry if isinstance(token_expiry, str) else token_expiry.isoformat().replace("+00:00", "Z")
                )
            if last_connected_at is not None:
                row["last_connected_at"] = last_connected_at.isoformat().replace("+00:00", "Z")
            if email is not None:
                row["email"] = email
            response = (
                self.client.table("gmail_tokens")
                .upsert(row, on_conflict="user_id")
                .execute()
            )
            if response.data and len(response.data) > 0:
                return response.data[0]
            return row
        except Exception as e:
            logger.error("Upsert Gmail tokens error: %s", str(e))
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Failed to save Gmail tokens",
            )

    async def delete_gmail_tokens(self, user_id: str) -> bool:
        """Remove Gmail tokens for user. Returns True if deleted."""
        try:
            response = (
                self.client.table("gmail_tokens")
                .delete()
                .eq("user_id", user_id)
                .execute()
            )
            return bool(response.data)
        except Exception as e:
            logger.error("Delete Gmail tokens error: %s", str(e))
            return False

    # -------------------------------------------------------------------------
    # Sync log (integration sync audit trail)
    # -------------------------------------------------------------------------

    async def insert_sync_log(
        self,
        user_id: str,
        source: str,
        action: str,
        status: str,
        started_at: datetime,
        finished_at: datetime,
        duration_ms: int,
        details: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """Append a sync log entry. Used by activities sync and other integration syncs."""
        try:
            row: Dict[str, Any] = {
                "user_id": user_id,
                "source": source,
                "action": action,
                "status": status,
                "started_at": started_at.isoformat().replace("+00:00", "Z"),
                "finished_at": finished_at.isoformat().replace("+00:00", "Z"),
                "duration_ms": duration_ms,
                "details": details,
                "metadata": metadata or {},
            }
            response = self.client.table("sync_log").insert(row).execute()
            if response.data and len(response.data) > 0:
                out = dict(response.data[0])
                out["id"] = str(out["id"])
                return out
            return {"id": "", **row}
        except Exception as e:
            logger.error("Insert sync log error: %s", str(e))
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Failed to record sync log",
            )

    async def list_sync_logs(
        self,
        user_id: str,
        status_filter: Optional[str] = None,
        source_filter: Optional[str] = None,
        limit: int = 50,
        offset: int = 0,
    ) -> tuple[list[Dict[str, Any]], int]:
        """List sync log entries for user with optional filters. Returns (rows, total_count)."""
        try:
            q = (
                self.client.table("sync_log")
                .select("id, source, action, status, started_at, finished_at, duration_ms, details, metadata, created_at", count="exact")
                .eq("user_id", user_id)
                .order("created_at", desc=True)
            )
            if status_filter and status_filter != "all":
                q = q.eq("status", status_filter)
            if source_filter and source_filter != "all":
                q = q.eq("source", source_filter)
            response = q.range(offset, offset + limit - 1).execute()
            total = response.count if response.count is not None else len(response.data or [])
            rows = list(response.data or [])
            for r in rows:
                if r.get("id"):
                    r["id"] = str(r["id"])
            return rows, total
        except Exception as e:
            logger.error("List sync logs error: %s", str(e))
            return [], 0


def get_supabase_service() -> SupabaseService:
    """Dependency for FastAPI."""
    return SupabaseService()
