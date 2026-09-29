import uuid
from datetime import UTC, datetime

from sqlalchemy import DateTime, String
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class UsageEvent(Base):
    __tablename__ = "usage_events"

    id: Mapped[str] = mapped_column(
        String(36),
        primary_key=True,
        default=lambda: str(uuid.uuid4()),
    )
    event_name: Mapped[str] = mapped_column(
        String(50),
        nullable=False,
        index=True,
    )
    anonymous_session_id: Mapped[str] = mapped_column(
        String(64),
        nullable=False,
        index=True,
    )
    ref_code: Mapped[str | None] = mapped_column(
        String(64),
        nullable=True,
        index=True,
    )
    case_number: Mapped[str | None] = mapped_column(
        String(64),
        nullable=True,
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(UTC),
        nullable=False,
        index=True,
    )
