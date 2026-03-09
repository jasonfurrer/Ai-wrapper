"""
Gmail API: load tokens from DB, build authenticated client with auto-refresh.
Uses google-auth-oauthlib and google-api-python-client..
"""

import logging
from datetime import datetime, timezone
from typing import Any, Optional

from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import Flow
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError

from app.core.config import get_settings
from app.services.supabase_service import SupabaseService

logger = logging.getLogger(__name__)

# Gmail scopes: read and send (required for Smart compose send)
GMAIL_READONLY_SCOPE = "https://www.googleapis.com/auth/gmail.readonly"
GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send"
# User profile scope: requested in OAuth flow (auth.py) for new connections so we can read display name via People API.
# Do NOT add to GMAIL_SCOPES below: existing tokens were granted only Gmail scopes; refresh would fail with invalid_scope.
USERINFO_PROFILE_SCOPE = "https://www.googleapis.com/auth/userinfo.profile"
# Scopes used when building Credentials from stored tokens and when refreshing. Must match what existing tokens have.
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


async def _get_gmail_credentials(user_id: str, supabase: SupabaseService) -> Optional[Credentials]:
    """
    Load Gmail tokens, refresh if expired, persist updated tokens, and return credentials.
    Returns None if OAuth is not configured, user has no tokens, or refresh fails.
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
    token_expiry = _parse_token_expiry_from_db(row.get("token_expiry"))

    creds = _credentials_from_tokens(
        access_token=access_token or "",
        refresh_token=refresh_token,
        token_expiry=token_expiry,
        client_id=settings.google_client_id,
        client_secret=settings.google_client_secret,
    )

    now_utc = datetime.now(timezone.utc)
    expiry_utc = _ensure_utc_aware(creds.expiry) if creds.expiry else None
    is_expired = expiry_utc is None or now_utc >= expiry_utc
    if is_expired and creds.refresh_token:
        try:
            creds.refresh(Request())
            expiry_after_refresh = _ensure_utc_aware(creds.expiry)
            if expiry_after_refresh:
                creds.expiry = expiry_after_refresh
            token_expiry_for_db = expiry_after_refresh.isoformat() if expiry_after_refresh else None
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

    return creds


async def get_gmail_client(user_id: str, supabase: SupabaseService):
    """
    Load Gmail tokens for the given user from the DB, build an authenticated
    Gmail API client, and refresh the access token if expired.
    Returns the Gmail API service object, or None if the user has no tokens.
    """
    creds = await _get_gmail_credentials(user_id, supabase)
    if not creds:
        return None
    return build("gmail", "v1", credentials=creds)


def _name_from_person_entry(entry: dict) -> Optional[str]:
    """Extract display name from a People API name entry (supports camelCase and snake_case)."""
    display = (
        (entry.get("displayName") or entry.get("display_name") or "").strip()
    )
    if display:
        return display
    given = (entry.get("givenName") or entry.get("given_name") or "").strip()
    family = (entry.get("familyName") or entry.get("family_name") or "").strip()
    return " ".join([given, family]).strip() or None


async def get_gmail_user_display_name(user_id: str, supabase: SupabaseService) -> Optional[str]:
    """
    Fetch the display name of the connected Gmail/Google account.
    Primary strategy:
      1) People API (requires userinfo.profile on the Gmail OAuth token).
      2) Fallback to Gmail settings.sendAs (uses gmail.send scope) to read the
         displayName configured for the primary send-as address.
    Used for email draft sign-offs (e.g. "Best regards, John Smith").
    Returns None if Gmail is not connected or both strategies fail.
    """
    logger.info("[get_gmail_user_display_name] user_id=%s: fetching Gmail credentials", user_id[:8])
    creds = await _get_gmail_credentials(user_id, supabase)
    if not creds:
        logger.warning(
            "[get_gmail_user_display_name] user_id=%s: no credentials (Gmail not connected or refresh failed)",
            user_id[:8],
        )
        return None

    # 1) Try People API first (best source for account profile name)
    people_error = None
    try:
        people_service = build("people", "v1", credentials=creds)
        person = people_service.people().get(
            resourceName="people/me",
            personFields="names",
        ).execute()
        names = person.get("names") or []
        logger.info(
            "[get_gmail_user_display_name] user_id=%s: People API returned %d name(s)",
            user_id[:8],
            len(names),
        )
        if names:
            first = names[0]
            result = _name_from_person_entry(first)
            if result:
                logger.info(
                    "[get_gmail_user_display_name] user_id=%s: resolved display name from People API (length=%d)",
                    user_id[:8],
                    len(result),
                )
                return result
            logger.warning(
                "[get_gmail_user_display_name] user_id=%s: People API name entry had no displayName/givenName/familyName: keys=%s",
                user_id[:8],
                list(first.keys()),
            )
        else:
            logger.warning(
                "[get_gmail_user_display_name] user_id=%s: People API returned no names",
                user_id[:8],
            )
    except HttpError as e:
        resp = getattr(e, "resp", None)
        status = getattr(resp, "status", None) if resp else None
        reason = getattr(resp, "reason", None) if resp else None
        people_error = e
        logger.warning(
            "[get_gmail_user_display_name] user_id=%s: People API HttpError status=%s reason=%s; will fall back to Gmail settings.sendAs. Error: %s",
            user_id[:8],
            status,
            reason,
            e,
        )
    except Exception as e:
        people_error = e
        logger.warning(
            "[get_gmail_user_display_name] user_id=%s: People API failed; will fall back to Gmail settings.sendAs: %s",
            user_id[:8],
            e,
            exc_info=True,
        )

    # 2) Fallback: use Gmail settings.sendAs to read the displayName for the primary address.
    try:
        gmail_service = build("gmail", "v1", credentials=creds)
        send_as = (
            gmail_service.users()
            .settings()
            .sendAs()
            .list(userId="me")
            .execute()
            .get("sendAs", [])
        )
        logger.info(
            "[get_gmail_user_display_name] user_id=%s: Gmail settings.sendAs returned %d address(es)",
            user_id[:8],
            len(send_as),
        )
        primary_entry = None
        for entry in send_as:
            if entry.get("isPrimary"):
                primary_entry = entry
                break
        if not primary_entry and send_as:
            primary_entry = send_as[0]
        if not primary_entry:
            logger.warning(
                "[get_gmail_user_display_name] user_id=%s: Gmail settings.sendAs had no entries",
                user_id[:8],
            )
            return None
        display = (primary_entry.get("displayName") or "").strip()
        if display:
            logger.info(
                "[get_gmail_user_display_name] user_id=%s: resolved display name from Gmail settings.sendAs (length=%d)",
                user_id[:8],
                len(display),
            )
            return display
        logger.warning(
            "[get_gmail_user_display_name] user_id=%s: primary sendAs entry missing displayName; keys=%s",
            user_id[:8],
            list(primary_entry.keys()),
        )
        return None
    except Exception as e:
        logger.warning(
            "[get_gmail_user_display_name] user_id=%s: Gmail settings.sendAs fallback failed (original People API error=%r): %s",
            user_id[:8],
            people_error,
            e,
            exc_info=True,
        )
        return None
