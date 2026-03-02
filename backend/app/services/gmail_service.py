"""
Gmail API: load tokens from DB, build authenticated client with auto-refresh.
Uses google-auth-oauthlib and google-api-python-client.
"""

import logging
from datetime import datetime, timezone
from typing import Any, Optional

from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import Flow
from googleapiclient.discovery import build

from app.core.config import get_settings
from app.services.supabase_service import SupabaseService

logger = logging.getLogger(__name__)

# Gmail scopes: read and send (required for Smart compose send)
GMAIL_READONLY_SCOPE = "https://www.googleapis.com/auth/gmail.readonly"
GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send"
GMAIL_SCOPES = [GMAIL_READONLY_SCOPE, GMAIL_SEND_SCOPE]


def _parse_token_expiry_from_db(value: Optional[str]) -> Optional[datetime]:
    """
    Parse token_expiry from the database into a timezone-aware UTC datetime
    for use with google.oauth2.credentials.Credentials.
    Handles ISO strings with or without timezone; always returns UTC-aware or None.
    """
    if not value:
        return None
    try:
        s = str(value).strip().replace("Z", "+00:00")
        dt = datetime.fromisoformat(s)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except Exception:
        return None


def _ensure_utc_aware(dt: Optional[datetime]) -> Optional[datetime]:
    """Ensure datetime uses datetime.timezone.utc specifically (not pytz or other UTC)."""
    if dt is None:
        return None
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    # Force to native datetime.timezone.utc even if already has a timezone
    return dt.astimezone(timezone.utc).replace(tzinfo=timezone.utc)


def _credentials_from_tokens(
    access_token: str,
    refresh_token: Optional[str],
    token_expiry: Optional[datetime],
    client_id: str,
    client_secret: str,
) -> Credentials:
    """Build Credentials from stored tokens. Token expiry can be None (treated as expired)."""
    creds = Credentials(
        token=access_token,
        refresh_token=refresh_token,
        token_uri="https://oauth2.googleapis.com/token",
        client_id=client_id,
        client_secret=client_secret,
        scopes=GMAIL_SCOPES,
    )
    if token_expiry:
        creds.expiry = _ensure_utc_aware(token_expiry)
    return creds


async def get_gmail_client(user_id: str, supabase: SupabaseService):
    """
    Load Gmail tokens for the given user from the DB, build an authenticated
    Gmail API client, and refresh the access token if expired.
    Returns the Gmail API service object, or None if the user has no tokens.
    """
    settings = get_settings()
    if not settings.google_client_id or not settings.google_client_secret:
        logger.warning("Google OAuth not configured (GOOGLE_CLIENT_ID/SECRET)")
        return None

    row = await supabase.get_gmail_tokens(user_id)
    if not row:
        return None

    access_token = row.get("access_token")
    refresh_token = row.get("refresh_token")
    # Parse token_expiry from DB as UTC-aware so Credentials never sees naive datetimes
    token_expiry = _parse_token_expiry_from_db(row.get("token_expiry"))

    creds = _credentials_from_tokens(
        access_token=access_token or "",
        refresh_token=refresh_token,
        token_expiry=token_expiry,
        client_id=settings.google_client_id,
        client_secret=settings.google_client_secret,
    )

    # Refresh if expired (check ourselves to avoid naive/aware datetime comparison in creds.expired)
    now_utc = datetime.now(timezone.utc)
    expiry_utc = _ensure_utc_aware(creds.expiry) if creds.expiry else None
    is_expired = expiry_utc is None or now_utc >= expiry_utc
    if is_expired and creds.refresh_token:
        try:
            creds.refresh(Request())
            # creds.expiry after refresh can be naive; persist as UTC-aware ISO string so DB never stores naive
            expiry_after_refresh = _ensure_utc_aware(creds.expiry)
            if expiry_after_refresh:
                creds.expiry = expiry_after_refresh
            token_expiry_for_db = expiry_after_refresh.isoformat() if expiry_after_refresh else None
            # Persist new tokens; preserve last_connected_at and email (only set on OAuth connect)
            existing_connected_at = row.get("last_connected_at")
            last_connected_dt = None
            if existing_connected_at:
                try:
                    last_connected_dt = datetime.fromisoformat(str(existing_connected_at).replace("Z", "+00:00"))
                except Exception:
                    pass
            email_to_save = (row.get("email") or "").strip() or None
            if not email_to_save:
                try:
                    temp_service = build("gmail", "v1", credentials=creds)
                    profile = temp_service.users().getProfile(userId="me").execute()
                    email_to_save = (profile.get("emailAddress") or "").strip() or None
                    if email_to_save:
                        logger.info("Backfilled Gmail email for user %s (on token refresh)", user_id)
                except Exception as e:
                    logger.debug("Could not fetch Gmail profile for email backfill: %s", e)
            await supabase.upsert_gmail_tokens(
                user_id=user_id,
                access_token=creds.token or "",
                refresh_token=creds.refresh_token,
                token_expiry=token_expiry_for_db,
                last_connected_at=last_connected_dt,
                email=email_to_save or row.get("email"),
            )
        except Exception as e:
            logger.error("Gmail token refresh failed for user %s: %s", user_id, e)
            return None

    service = build("gmail", "v1", credentials=creds)
    return service
