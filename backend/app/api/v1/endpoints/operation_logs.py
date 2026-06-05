"""
Operation log endpoints. List granular API and LLM operation logs for the Integrations page.
"""

from fastapi import APIRouter, Depends, Query

from app.core.security import get_current_user_id
from app.schemas.operation_log import OperationLogEntry, OperationLogListResponse
from app.services.supabase_service import SupabaseService, get_supabase_service

router = APIRouter(prefix="/operation-logs", tags=["operation-logs"])


@router.get(
    "",
    response_model=OperationLogListResponse,
    summary="List operation logs",
    description=(
        "Paginated list of granular operation log entries for the current user. "
        "Filter by entity_type (contact, company, task, llm_call) and status."
    ),
)
async def list_operation_logs(
    user_id: str = Depends(get_current_user_id),
    supabase: SupabaseService = Depends(get_supabase_service),
    entity_type: str = Query(
        "all",
        description="Filter by entity type: all | contact | company | task | llm_call",
    ),
    status: str = Query(
        "all",
        description="Filter by status: all | success | error",
    ),
    page: int = Query(1, ge=1, description="Page number (1-based)"),
    page_size: int = Query(20, ge=1, le=100, description="Items per page"),
) -> OperationLogListResponse:
    """GET /api/v1/operation-logs — list operation log entries with optional filters."""
    offset = (page - 1) * page_size
    rows, total = await supabase.list_operation_logs(
        user_id=user_id,
        entity_type=entity_type if entity_type != "all" else None,
        status_filter=status if status != "all" else None,
        limit=page_size,
        offset=offset,
    )
    entries = [
        OperationLogEntry(
            id=r["id"],
            entity_type=r["entity_type"],
            operation=r["operation"],
            entity_id=r.get("entity_id"),
            entity_name=r.get("entity_name"),
            status=r["status"],
            http_status_code=r.get("http_status_code"),
            error_code=r.get("error_code"),
            error_message=r.get("error_message"),
            response_summary=r.get("response_summary"),
            metadata=r.get("metadata") or {},
            duration_ms=r.get("duration_ms", 0),
            created_at=r["created_at"],
        )
        for r in rows
    ]
    return OperationLogListResponse(
        entries=entries,
        total=total,
        page=page,
        page_size=page_size,
    )
