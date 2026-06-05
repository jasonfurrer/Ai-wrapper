"""Operation log schema (API contract). Used by the Integrations page operation log UI."""

from typing import Any

from pydantic import BaseModel, ConfigDict


class OperationLogEntry(BaseModel):
    """Single operation log entry returned by the API."""

    model_config = ConfigDict(from_attributes=True)

    id: str
    entity_type: str          # 'contact' | 'company' | 'task' | 'llm_call'
    operation: str            # 'create' | 'update' | 'delete' | 'generate_summary' | etc.
    entity_id: str | None = None
    entity_name: str | None = None
    status: str               # 'success' | 'error'
    http_status_code: int | None = None
    error_code: str | None = None
    error_message: str | None = None
    response_summary: str | None = None
    metadata: dict[str, Any] = {}
    duration_ms: int
    created_at: str


class OperationLogListResponse(BaseModel):
    """Paginated operation log list."""

    entries: list[OperationLogEntry]
    total: int
    page: int
    page_size: int
