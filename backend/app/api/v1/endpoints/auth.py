"""
Auth API: signup, signin, signout, me, password reset/update, Gmail OAuth.
"""

import base64
import logging
from typing import Any, Dict

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import RedirectResponse

from app.core.config import get_settings
from app.core.security import get_current_user, get_current_user_id
from app.schemas.auth import (
    AuthResponse,
    MessageResponse,
    PasswordResetRequest,
    PasswordUpdateRequest,
    SignInRequest,
    SignUpRequest,
    UserProfile,
)
from app.services.supabase_service import SupabaseService, get_supabase_service

logger = logging.getLogger(__name__)
router = APIRouter()


@router.post(
    "/signup",
    response_model=AuthResponse,
    status_code=status.HTTP_201_CREATED,
)
async def signup(
    request: SignUpRequest,
    supabase: SupabaseService = Depends(get_supabase_service),
):
    """
    Register a new user.

    - **email**: Valid email address
    - **password**: Minimum 8 characters
    - **full_name**: User's full name
    """
    result = await supabase.sign_up(
        email=request.email,
        password=request.password,
        full_name=request.full_name,
    )

    session = result["session"]
    user = result["user"]

    # Get user profile
    profile = await supabase.get_user_profile(user.id)

    return AuthResponse(
        access_token=session.access_token,
        token_type="bearer",
        expires_in=session.expires_in,
        expires_at=session.expires_at,
        refresh_token=session.refresh_token,
        user=UserProfile(
            id=user.id,
            email=user.email,
            full_name=profile.get("full_name") if profile else None,
            company_name=profile.get("company_name") if profile else None,
            hubspot_portal_id=profile.get("hubspot_portal_id") if profile else None,
            created_at=user.created_at,
        ),
    )


@router.post("/signin", response_model=AuthResponse)
async def signin(
    request: SignInRequest,
    supabase: SupabaseService = Depends(get_supabase_service),
):
    """
    Sign in an existing user.

    - **email**: Registered email address
    - **password**: User's password
    """
    result = await supabase.sign_in(
        email=request.email,
        password=request.password,
    )

    session = result["session"]
    user = result["user"]

    # Get user profile
    profile = await supabase.get_user_profile(user.id)

    return AuthResponse(
        access_token=session.access_token,
        token_type="bearer",
        expires_in=session.expires_in,
        expires_at=session.expires_at,
        refresh_token=session.refresh_token,
        user=UserProfile(
            id=user.id,
            email=user.email,
            full_name=profile.get("full_name") if profile else None,
            company_name=profile.get("company_name") if profile else None,
            hubspot_portal_id=profile.get("hubspot_portal_id") if profile else None,
            created_at=user.created_at,
        ),
    )


@router.post("/signout", response_model=MessageResponse)
async def signout(
    current_user: Dict[str, Any] = Depends(get_current_user),
    supabase: SupabaseService = Depends(get_supabase_service),
):
    """
    Sign out the current user.
    Requires authentication.
    """
    await supabase.sign_out(access_token="")

    return MessageResponse(
        message="Successfully signed out",
        success=True,
    )


@router.get("/me", response_model=UserProfile)
async def get_current_user_profile(
    user_id: str = Depends(get_current_user_id),
    supabase: SupabaseService = Depends(get_supabase_service),
):
    """
    Get current user's profile.
    Requires authentication.
    """
    profile = await supabase.get_user_profile(user_id)

    if not profile:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Profile not found",
        )

    return UserProfile(**profile)


@router.post("/password-reset", response_model=MessageResponse)
async def request_password_reset(
    request: PasswordResetRequest,
    supabase: SupabaseService = Depends(get_supabase_service),
):
    """
    Request password reset email.

    - **email**: Email address to send reset link to

    Note: Always returns success for security (doesn't reveal if email exists)
    """
    await supabase.send_password_reset(request.email)

    return MessageResponse(
        message="If an account exists with this email, you will receive a password reset link",
        success=True,
    )


@router.post("/password-update", response_model=MessageResponse)
async def update_password(
    request: PasswordUpdateRequest,
    current_user: Dict[str, Any] = Depends(get_current_user),
    supabase: SupabaseService = Depends(get_supabase_service),
):
    """
    Update user password.
    Requires authentication.

    - **new_password**: New password (minimum 8 characters)
    """
    await supabase.update_password(
        access_token="",
        new_password=request.new_password,
    )

    return MessageResponse(
        message="Password updated successfully",
        success=True,
    )


# ---------------------------------------------------------------------------
# Gmail OAuth
# ---------------------------------------------------------------------------

GMAIL_SCOPES = [
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.send",
]


@router.get("/gmail/status")
async def gmail_status(
    user_id: str = Depends(get_current_user_id),
    supabase: SupabaseService = Depends(get_supabase_service),
):
    """Return whether the current user has Gmail connected, their email (from DB), and last_connected_at."""
    tokens = await supabase.get_gmail_tokens(user_id)
    if not tokens:
        return {"connected": False}

    email = tokens.get("email")
    last_connected_at = tokens.get("last_connected_at")
    # If email was never stored (e.g. before we added the column), try Gmail API once
    if not email:
        try:
            from app.services.gmail_service import get_gmail_client
            service = await get_gmail_client(user_id, supabase)
            if service:
                profile = service.users().getProfile(userId="me").execute()
                email = profile.get("emailAddress")
        except Exception as e:
            logger.debug("Gmail profile fetch for status: %s", e)
    return {
        "connected": True,
        "email": email,
        "last_connected_at": last_connected_at,
    }


@router.get("/gmail")
async def gmail_connect(
    user_id: str = Depends(get_current_user_id),
    supabase: SupabaseService = Depends(get_supabase_service),
):
    """
    Generate Google OAuth URL for Gmail and return it.
    Frontend should redirect the user to this URL.
    """
    from google_auth_oauthlib.flow import Flow

    settings = get_settings()
    if not settings.google_client_id or not settings.google_client_secret or not settings.google_redirect_uri:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Gmail integration is not configured",
        )
    flow = Flow.from_client_config(
        {
            "web": {
                "client_id": settings.google_client_id,
                "client_secret": settings.google_client_secret,
                "auth_uri": "https://accounts.google.com/o/oauth2/auth",
                "token_uri": "https://oauth2.googleapis.com/token",
                "redirect_uris": [settings.google_redirect_uri],
            }
        },
        scopes=GMAIL_SCOPES,
    )
    flow.redirect_uri = settings.google_redirect_uri
    authorization_url, _ = flow.authorization_url(
        access_type="offline",
        prompt="consent",
        state=base64.urlsafe_b64encode(user_id.encode()).decode(),
    )
    return {"url": authorization_url}


@router.get("/gmail/callback")
async def gmail_callback(
    code: str | None = None,
    state: str | None = None,
    error: str | None = None,
    supabase: SupabaseService = Depends(get_supabase_service),
):
    """
    Google OAuth callback. Exchange code for tokens, save to DB, redirect to frontend.
    """
    from datetime import datetime, timezone

    from google_auth_oauthlib.flow import Flow

    settings = get_settings()
    frontend_url = (settings.frontend_url or "").strip().rstrip("/")
    if not frontend_url:
        frontend_url = "http://localhost:3000"

    if error:
        logger.warning("Gmail OAuth error: %s", error)
        return RedirectResponse(url=f"{frontend_url}/integrations?gmail_error=1", status_code=302)

    if not code or not state:
        return RedirectResponse(url=f"{frontend_url}/integrations?gmail_error=2", status_code=302)

    try:
        user_id = base64.urlsafe_b64decode(state.encode()).decode()
    except Exception:
        logger.warning("Invalid state in Gmail callback")
        return RedirectResponse(url=f"{frontend_url}/integrations?gmail_error=3", status_code=302)

    if not settings.google_client_id or not settings.google_client_secret or not settings.google_redirect_uri:
        return RedirectResponse(url=f"{frontend_url}/integrations?gmail_error=4", status_code=302)

    flow = Flow.from_client_config(
        {
            "web": {
                "client_id": settings.google_client_id,
                "client_secret": settings.google_client_secret,
                "auth_uri": "https://accounts.google.com/o/oauth2/auth",
                "token_uri": "https://oauth2.googleapis.com/token",
                "redirect_uris": [settings.google_redirect_uri],
            }
        },
        scopes=GMAIL_SCOPES,
    )
    flow.redirect_uri = settings.google_redirect_uri
    try:
        flow.fetch_token(code=code)
    except Exception as e:
        logger.exception("Gmail fetch_token failed: %s", e)
        return RedirectResponse(url=f"{frontend_url}/integrations?gmail_error=5", status_code=302)

    credentials = flow.credentials
    token_expiry = None
    if credentials.expiry:
        token_expiry = credentials.expiry
        # Keep timezone-aware so DB gets an ISO string with timezone (avoids naive/aware comparison later)
        if token_expiry.tzinfo is None:
            token_expiry = token_expiry.replace(tzinfo=timezone.utc)
        else:
            token_expiry = token_expiry.astimezone(timezone.utc)
    # Convert to ISO string with timezone before saving so Supabase stores it correctly (e.g. "2025-02-17T12:00:00+00:00")
    token_expiry_iso = token_expiry.isoformat() if token_expiry else None

    # Fetch Gmail profile email so we can store it (no extra API call needed later)
    gmail_email = None
    try:
        from googleapiclient.discovery import build
        service = build("gmail", "v1", credentials=credentials)
        profile = service.users().getProfile(userId="me").execute()
        gmail_email = profile.get("emailAddress")
    except Exception as e:
        logger.warning("Could not fetch Gmail profile for email: %s", e)

    now_utc = datetime.now(timezone.utc)
    print(f"Saving token_expiry: {token_expiry}, type: {type(token_expiry)}")  # noqa: T201
    await supabase.upsert_gmail_tokens(
        user_id=user_id,
        access_token=credentials.token or "",
        refresh_token=credentials.refresh_token,
        token_expiry=token_expiry_iso,
        last_connected_at=now_utc,
        email=gmail_email,
    )
    return RedirectResponse(url=f"{frontend_url}/integrations", status_code=302)


@router.delete("/gmail")
async def gmail_disconnect(
    user_id: str = Depends(get_current_user_id),
    supabase: SupabaseService = Depends(get_supabase_service),
):
    """Remove Gmail tokens for the current user."""
    await supabase.delete_gmail_tokens(user_id)
    return MessageResponse(message="Gmail disconnected", success=True)
