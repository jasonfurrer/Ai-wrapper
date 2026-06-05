"""
Companies (accounts) endpoints. Search and create in HubSpot.
"""

import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, status

from app.core.security import get_current_user_id
from app.schemas.company import (
    CompanyCreate,
    CompanyDetailResponse,
    CompanyListResponse,
    CompanySearchResult,
)
from app.services.hubspot_service import HubSpotService, HubSpotServiceError, get_hubspot_service
from app.services.supabase_service import SupabaseService, get_supabase_service

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/companies", tags=["companies"])

# HubSpot company property names
HS_NAME = "name"
HS_DOMAIN = "domain"
HS_CITY = "city"
HS_STATE = "state"
HS_OWNER = "hubspot_owner_id"


def _hubspot_company_to_search_result(hc: dict[str, Any]) -> CompanySearchResult:
    """Transform HubSpot company object to CompanySearchResult."""
    cid = hc.get("id") or ""
    props = hc.get("properties") or {}
    return CompanySearchResult(
        id=cid,
        name=props.get(HS_NAME),
        domain=props.get(HS_DOMAIN),
        city=props.get(HS_CITY),
        state=props.get(HS_STATE),
    )


def _company_create_to_hubspot_properties(body: CompanyCreate) -> dict[str, Any]:
    """Build HubSpot company properties from CompanyCreate."""
    props: dict[str, Any] = {
        HS_NAME: body.name.strip(),
        HS_DOMAIN: body.domain.strip(),
    }
    if body.city is not None and body.city.strip():
        props[HS_CITY] = body.city.strip()
    if body.state is not None and body.state.strip():
        props[HS_STATE] = body.state.strip()
    if body.company_owner is not None and body.company_owner.strip():
        props[HS_OWNER] = body.company_owner.strip()
    return props


@router.get(
    "/search",
    response_model=CompanyListResponse,
    summary="Search companies",
    description="Search companies by name or domain. Returns suggestions for account field.",
)
async def search_companies(
    q: str = Query(..., min_length=1, description="Search query (company name or domain)"),
    hubspot: HubSpotService = Depends(get_hubspot_service),
    _user_id: str = Depends(get_current_user_id),
) -> CompanyListResponse:
    """GET /api/v1/companies/search?q= — search HubSpot companies."""
    try:
        result = hubspot.search_companies(query=q.strip(), limit=20)
        results = result.get("results") or []
        companies = [_hubspot_company_to_search_result(c) for c in results]
        return CompanyListResponse(companies=companies)
    except HubSpotServiceError as e:
        logger.warning("HubSpot company search error: %s", e.message)
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=e.message or "HubSpot search failed",
        )
    except Exception as e:
        logger.exception("Search companies error: %s", e)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to search companies",
        )


@router.post(
    "",
    response_model=CompanyDetailResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Create company",
)
async def create_company(
    body: CompanyCreate,
    user_id: str = Depends(get_current_user_id),
    hubspot: HubSpotService = Depends(get_hubspot_service),
    supabase: SupabaseService = Depends(get_supabase_service),
) -> CompanyDetailResponse:
    """POST /api/v1/companies/ — create company in HubSpot and update local cache."""
    try:
        props = _company_create_to_hubspot_properties(body)
        payload = {"properties": props}
        company_data = hubspot.create_company(payload)
        cid = company_data.get("id")
        if not cid:
            raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="HubSpot did not return company id")
        cid_str = str(cid)
        await supabase.upsert_company_cache(user_id, cid_str, company_data)
        props_out = company_data.get("properties") or {}
        await supabase.insert_operation_log(
            user_id=user_id, entity_type="company", operation="create",
            log_status="success", entity_id=cid_str, entity_name=body.name.strip(),
            response_summary="Company created in HubSpot",
        )
        return CompanyDetailResponse(
            id=cid_str,
            name=props_out.get(HS_NAME),
            domain=props_out.get(HS_DOMAIN),
            city=props_out.get(HS_CITY),
            state=props_out.get(HS_STATE),
        )
    except HubSpotServiceError as e:
        await supabase.insert_operation_log(
            user_id=user_id, entity_type="company", operation="create",
            log_status="error", entity_name=body.name.strip(),
            http_status_code=e.status_code, error_code=str(e.status_code),
            error_message=e.message or "HubSpot error",
        )
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=e.message or "HubSpot error",
        )
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Create company error: %s", e)
        await supabase.insert_operation_log(
            user_id=user_id, entity_type="company", operation="create",
            log_status="error", entity_name=body.name.strip(), error_message=str(e),
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to create company",
        )
