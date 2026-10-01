from fastapi import APIRouter

from app.api.auth import router as auth_router
from app.api.cases import router as cases_router
from app.api.export import router as export_router
from app.api.ingest import router as ingest_router
from app.api.investigations import router as investigations_router
from app.api.jobs import router as jobs_router
from app.api.usage import router as usage_router

api_v1_router = APIRouter(prefix="/api/v1")
api_v1_router.include_router(auth_router)
api_v1_router.include_router(ingest_router)
api_v1_router.include_router(jobs_router)
api_v1_router.include_router(investigations_router)
api_v1_router.include_router(cases_router)
api_v1_router.include_router(export_router)
api_v1_router.include_router(usage_router)

__all__ = ["api_v1_router"]
