from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from app.api import api_v1_router
from app.core.config import settings
from app.core.observability import initialize_observability

initialize_observability(settings)


class HealthResponse(BaseModel):
    status: str


app = FastAPI(
    title=settings.PROJECT_NAME,
    version="0.1.0",
    docs_url="/docs",
    redoc_url=None,
)

if settings.CORS_ORIGINS:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.CORS_ORIGINS,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

app.include_router(api_v1_router)


@app.get("/api/health", response_model=HealthResponse)
def health_check() -> HealthResponse:
    """Return basic service health status."""
    return HealthResponse(status="ok")
