"""
Dashboard state schemas (user_dashboard_state table).
"""

from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict


class FilterState(BaseModel):
    """Filter state object (stored as JSONB). Allow extra keys for flexibility."""
    model_config = ConfigDict(extra="allow")

    def to_jsonb(self) -> dict[str, Any]:
        return self.model_dump(exclude_none=True)


# Sort option for dashboard (align with activities)
DashboardSortOption = str  # e.g. date_newest, date_oldest, etc.


class DashboardStateResponse(BaseModel):
    """Response for GET /dashboard/state."""
    selected_activity_id: str | None = None
    sort_option: str = "due_date_oldest"
    filter_state: dict[str, Any] = {}
    date_picker_value: str | None = None
    updated_at: datetime | None = None


class DashboardStateUpdate(BaseModel):
    """Request body for PUT /dashboard/state (all optional)."""
    selected_activity_id: str | None = None
    sort_option: str | None = None
    filter_state: dict[str, Any] | None = None
    date_picker_value: str | None = None
