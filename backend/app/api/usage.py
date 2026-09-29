from fastapi import APIRouter, Depends, Response, status
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.models.usage import UsageEvent
from app.schemas.usage import UsageEventCreateRequest

router = APIRouter(prefix="/usage-events", tags=["usage"])


@router.post("", status_code=status.HTTP_204_NO_CONTENT)
def record_usage_event(
    payload: UsageEventCreateRequest,
    db: Session = Depends(get_db),
) -> Response:
    """Record an anonymous, privacy-safe demo usage event."""
    event = UsageEvent(
        event_name=payload.event_name.value,
        anonymous_session_id=payload.anonymous_session_id,
        ref_code=payload.ref_code,
        case_number=payload.case_number,
    )
    db.add(event)
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
