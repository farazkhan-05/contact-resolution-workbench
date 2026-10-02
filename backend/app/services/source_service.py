import hashlib
import secrets

from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.models.source import ReferenceRecord, Source, SourceIngestion
from app.schemas.resolution import CaseQuery, RawCandidate
from app.schemas.source import SourceBatch
from app.services.case_service import persist_case_resolution
from app.services.normalizer import normalize_email, normalize_name, normalize_phone
from app.services.resolution_service import ResolutionService


def digest(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def rotate(source: Source) -> str:
    source.key_prefix = "crw_src_" + secrets.token_hex(12)
    key = source.key_prefix + "_" + secrets.token_urlsafe(32)
    source.key_digest = digest(key)
    return key


class WorkspaceReferenceProvider:
    provider_id = "WORKSPACE_REFERENCE"
    provider_name = "Workspace reference records"

    def __init__(self, db: Session, workspace_id: str):
        self.db = db
        self.workspace_id = workspace_id

    def search(self, query: CaseQuery) -> list[RawCandidate]:
        tokens = sorted({token for token in normalize_name(query.name).split() if len(token) > 1})[
            :8
        ]
        blocks = [
            ReferenceRecord.normalized_name.contains(token, autoescape=True) for token in tokens
        ]
        if query.email:
            blocks.append(ReferenceRecord.normalized_email == normalize_email(query.email))
        if query.phone:
            blocks.append(ReferenceRecord.normalized_phone == normalize_phone(query.phone))
        if not blocks:
            return []
        records = self.db.scalars(
            select(ReferenceRecord)
            .where(ReferenceRecord.workspace_id == self.workspace_id, or_(*blocks))
            .order_by(ReferenceRecord.id)
            .limit(100)
        )
        candidates = []
        for record in records:
            candidates.append(
                RawCandidate(
                    provider_source=self.provider_id,
                    provider_record_id=record.id,
                    name=record.full_name,
                    email=record.old_email,
                    phone=record.old_phone,
                    employer=record.employer,
                    location=record.location,
                    provenance_summary=(
                        f"Source {record.source_id}; ingestion {record.ingestion_id}"
                    ),
                )
            )
        return candidates


def workspace_resolver(db: Session, workspace_id: str) -> ResolutionService:
    resolver = ResolutionService()
    resolver.providers.append(WorkspaceReferenceProvider(db, workspace_id))
    return resolver


def process_batch(db: Session, source: Source, run: SourceIngestion, batch: SourceBatch) -> None:
    # Serialize upserts from the same Source on PostgreSQL, including different HTTP batches.
    db.scalar(select(Source).where(Source.id == source.id).with_for_update())
    resolver = workspace_resolver(db, source.workspace_id)
    for index, record in enumerate(batch.records):
        if source.source_type == "REFERENCE":
            master = db.scalar(
                select(ReferenceRecord).where(
                    ReferenceRecord.workspace_id == source.workspace_id,
                    ReferenceRecord.source_id == source.id,
                    ReferenceRecord.external_record_id == record.external_record_id,
                )
            )
            if master is None:
                master = ReferenceRecord(
                    workspace_id=source.workspace_id,
                    source_id=source.id,
                    external_record_id=record.external_record_id,
                )
                db.add(master)
            for field, value in record.model_dump().items():
                setattr(master, field, value)
            master.normalized_name = normalize_name(record.full_name)
            master.normalized_email = normalize_email(record.old_email) or None
            master.normalized_phone = normalize_phone(record.old_phone) or None
            master.ingestion_id = run.id
        else:
            query = CaseQuery(
                name=record.full_name,
                email=record.old_email,
                phone=record.old_phone,
                employer=record.employer,
                location=record.location,
            )
            case = persist_case_resolution(
                db,
                source.workspace_id,
                f"API-{run.id}-{index}",
                source.name,
                query,
                resolver.resolve(query),
                "source_api",
            )
            case.source_id = source.id
            case.ingestion_id = run.id
            case.external_record_id = record.external_record_id
    db.flush()
