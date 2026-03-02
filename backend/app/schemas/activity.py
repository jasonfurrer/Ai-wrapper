"""
Activity schema (API contract). Kept in sync with frontend types/Activity.
"""

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict

# Sort options for activity list
ActivitySortOption = Literal[
    "due_date_newest",
    "due_date_oldest",
    "last_touch_newest",
    "last_touch_oldest",
    "priority_high_low",
    "priority_low_high",
]


class ActivityBase(BaseModel):
    type: str | None = None
    subject: str | None = None
    body: str | None = None
    due_date: datetime | None = None
    completed: bool = False
    contact_ids: list[str] = []
    company_ids: list[str] = []
    hubspot_id: str | None = None


class ActivityCreate(ActivityBase):
    """Request body for creating an activity."""
    pass


class ActivityUpdate(BaseModel):
    """Request body for partial update."""
    type: str | None = None
    subject: str | None = None
    body: str | None = None
    due_date: datetime | None = None
    completed: bool | None = None
    contact_ids: list[str] | None = None
    company_ids: list[str] | None = None


def _response_priority(hubspot_value: str | None) -> str:
    """Map HubSpot hs_task_priority (LOW/MEDIUM/HIGH or empty) to app priority: none | low | medium | high."""
    if not hubspot_value or not hubspot_value.strip():
        return "none"
    v = hubspot_value.strip().upper()
    if v == "LOW":
        return "low"
    if v == "MEDIUM":
        return "medium"
    if v == "HIGH":
        return "high"
    return "none"


class Activity(ActivityBase):
    """Response schema; matches frontend Activity interface."""
    model_config = ConfigDict(from_attributes=True)

    id: str
    created_at: datetime | None = None
    updated_at: datetime | None = None
    priority: str = "none"  # none | low | medium | high (from HubSpot hs_task_priority)


class ContactInfo(BaseModel):
    """Minimal contact info for activity enrichment."""
    id: str
    email: str | None = None
    first_name: str | None = None
    last_name: str | None = None
    hubspot_id: str | None = None
    phone: str | None = None
    mobile_phone: str | None = None
    company_name: str | None = None


class CompanyInfo(BaseModel):
    """Minimal company info for activity enrichment."""
    id: str
    name: str | None = None
    domain: str | None = None
    hubspot_id: str | None = None


class ActivityResponse(Activity):
    """Activity with optional contact and company details."""
    contacts: list[ContactInfo] = []
    companies: list[CompanyInfo] = []


class ActivityListResponse(BaseModel):
    """List of activities (with optional contact/company info)."""
    activities: list[ActivityResponse]


class SyncStatusResponse(BaseModel):
    """Response for force-sync endpoint."""
    synced: bool
    message: str
    tasks_count: int = 0


# ---------------------------------------------------------------------------
# Activity page: process notes (LLM) and submit
# ---------------------------------------------------------------------------

class ProcessNotesRequest(BaseModel):
    """Request body for POST /activities/{id}/process-notes."""
    note_text: str = ""


class ProcessDraftRequest(BaseModel):
    """Request body for POST /activities/process-draft (no activity id; e.g. new activity)."""
    note_text: str = ""
    previous_notes: str = ""


class RecognisedDateOut(BaseModel):
    date: str | None = None  # YYYY-MM-DD
    label: str | None = None
    confidence: int = 0


class RecommendedTouchDateOut(BaseModel):
    date: str  # YYYY-MM-DD
    label: str = ""
    rationale: str = ""


class ExtractedMetadataOut(BaseModel):
    subject: str = ""
    questions_raised: str = ""
    urgency: Literal["low", "medium", "high"] = "medium"
    subject_confidence: int = 0
    questions_confidence: int = 0


class DraftOut(BaseModel):
    text: str
    confidence: int = 0


class ProcessNotesResponse(BaseModel):
    """Response from process-notes: summary, dates, metadata, drafts."""
    summary: str = ""
    recognised_date: RecognisedDateOut = RecognisedDateOut()
    recommended_touch_date: RecommendedTouchDateOut | None = None
    metadata: ExtractedMetadataOut = ExtractedMetadataOut()
    drafts: dict[str, DraftOut] = {}  # keys: original, formal, concise, warm, detailed


def _hubspot_priority(value: str | None) -> str | None:
    """Map app priority ('none'|'low'|'medium'|'high') to HubSpot hs_task_priority (LOW/MEDIUM/HIGH). None/none omitted."""
    if not value or value.strip().lower() == "none":
        return None
    v = value.strip().lower()
    if v == "low":
        return "LOW"
    if v == "medium":
        return "MEDIUM"
    if v == "high":
        return "HIGH"
    return None


class ActivitySubmitRequest(BaseModel):
    """Request body for POST /activities/{id}/submit and POST /activities/create-and-submit."""
    mark_complete: bool = False
    meeting_notes: str | None = None  # selected draft text to prepend to task body
    activity_date: str | None = None  # YYYY-MM-DD; date the task was performed (used for note prefix)
    due_date: str | None = None  # YYYY-MM-DD; task due date in HubSpot
    subject: str | None = None  # task title
    contact_id: str | None = None
    company_id: str | None = None
    priority: str | None = None  # none | low | medium | high -> HubSpot hs_task_priority (LOW/MEDIUM/HIGH)


class CreateAndSubmitResponse(BaseModel):
    """Response for POST /activities/create-and-submit (new activity)."""
    message: str
    id: str  # new task id


class RegenerateDraftRequest(BaseModel):
    """Request body for POST /activities/{id}/regenerate-draft."""
    tone: str  # original, formal, concise, warm, detailed
    current_note: str = ""
    previous_notes: str = ""


class CommunicationSummaryResponse(BaseModel):
    """Response for GET /activities/{id}/communication-summary (from DB or newly generated)."""
    summary: str = ""
    times_contacted: str = ""
    relationship_status: str = ""
