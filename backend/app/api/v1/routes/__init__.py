"""
Aggregate v1 API routes.

Convention: Use "" (not "/") for the root path of a segment (e.g. @router.get(""), @router.post(""))
so the route is /api/v1/contacts not /api/v1/contacts/. This avoids 307 redirects when the
request arrives without a trailing slash (e.g. after Next.js rewrite).
"""

from fastapi import APIRouter

from app.api.v1.endpoints import activities, companies, contacts, dashboard, gmail, hubspot, llm, operation_logs, sync_logs

api_router = APIRouter()

api_router.include_router(hubspot.router, prefix="")
api_router.include_router(activities.router, prefix="")
api_router.include_router(contacts.router, prefix="")
api_router.include_router(companies.router, prefix="")
api_router.include_router(dashboard.router, prefix="")
api_router.include_router(llm.router, prefix="")
api_router.include_router(sync_logs.router, prefix="")
api_router.include_router(operation_logs.router, prefix="")
api_router.include_router(gmail.router, prefix="/gmail", tags=["Gmail"])
