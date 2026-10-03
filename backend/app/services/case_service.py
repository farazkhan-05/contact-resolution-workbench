import csv
import io
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.orm import Session, joinedload

from app.core.constants import (
    ACTOR_SYSTEM,
    AuditEventType,
    ContradictionSeverity,
    ReviewDecision,
    RoutingStatus,
)
from app.core.observability import annotate, traced
from app.models.audit import AuditLog
from app.models.case import CandidateRecord, Case, Contradiction, MatchEvidence
from app.models.source import SourceIngestion
from app.schemas.api import (
    AuditLogResponse,
    CandidateDetailResponse,
    CaseDetailResponse,
    CaseSummaryResponse,
    ContradictionResponse,
    CsvIngestResponse,
    DecisionRequest,
    MatchEvidenceResponse,
    SampleIngestResponse,
)
from app.schemas.resolution import CaseQuery, CaseResolution
from app.services.csv_importer import parse_and_validate_csv
from app.services.fixtures import BENCHMARK_CASES
from app.services.normalizer import (
    normalize_email,
    normalize_employer,
    normalize_location,
    normalize_name,
    normalize_phone,
    parse_name_parts,
)
from app.services.resolution_service import ResolutionService


def _to_utc_naive(dt: datetime | None = None) -> datetime:
    if dt is None:
        return datetime.now(UTC).replace(tzinfo=None)
    if dt.tzinfo is not None:
        return dt.astimezone(UTC).replace(tzinfo=None)
    return dt


def _datetime_sort_key(dt: datetime | None) -> datetime:
    if dt is None:
        return datetime.min
    return _to_utc_naive(dt)


def persist_case_resolution(
    db: Session,
    workspace_id: str,
    case_number: str,
    source_identifier: str | None,
    query: CaseQuery,
    resolution: CaseResolution,
    source_type: str = "sample",
) -> Case:
    """Add/flush a resolved Case and its records; the caller owns commit/rollback."""
    name_parts = parse_name_parts(query.name)

    case = Case(
        workspace_id=workspace_id,
        case_number=case_number,
        source_identifier=source_identifier,
        raw_name=query.name or "",
        normalized_name=normalize_name(query.name),
        name_prefix=name_parts.get("prefix"),
        first_name=query.first_name or name_parts.get("first_name"),
        middle_name=query.middle_name or name_parts.get("middle_name"),
        last_name=query.last_name or name_parts.get("last_name"),
        name_suffix=query.name_suffix or name_parts.get("suffix"),
        raw_email=query.email,
        normalized_email=normalize_email(query.email) or None,
        raw_phone=query.phone,
        normalized_phone=normalize_phone(query.phone) or None,
        raw_employer=query.employer,
        normalized_employer=normalize_employer(query.employer) or None,
        raw_location=query.location,
        normalized_location=normalize_location(query.location) or None,
        routing_status=resolution.routing_status.value,
        review_decision=ReviewDecision.PENDING.value,
        selected_candidate_id=None,
        reviewer_notes=None,
        reviewed_at=None,
        created_at=_to_utc_naive(),
    )
    db.add(case)
    db.flush()  # Populates case.id

    for cand_res in resolution.candidates:
        cand_data = cand_res.candidate
        cand_parts = parse_name_parts(cand_data.name)

        cand_record = CandidateRecord(
            case_id=case.id,
            provider_source=cand_data.provider_source,
            provider_record_id=cand_data.provider_record_id,
            name=cand_data.name,
            first_name=cand_data.first_name or cand_parts.get("first_name"),
            middle_name=cand_data.middle_name or cand_parts.get("middle_name"),
            last_name=cand_data.last_name or cand_parts.get("last_name"),
            name_suffix=cand_data.name_suffix or cand_parts.get("suffix"),
            email=cand_data.email,
            phone=cand_data.phone,
            employer=cand_data.employer,
            job_title=cand_data.job_title,
            location=cand_data.location,
            total_score=cand_res.total_score,
            name_score=cand_res.name_score,
            email_score=cand_res.email_score,
            phone_score=cand_res.phone_score,
            employer_score=cand_res.employer_score,
            location_score=cand_res.location_score,
            has_serious_contradiction=cand_res.has_serious_contradiction,
            provenance_summary=cand_data.provenance_summary,
        )
        db.add(cand_record)
        db.flush()  # Populates cand_record.id

        for ev in cand_res.field_evidence:
            evidence_record = MatchEvidence(
                candidate_id=cand_record.id,
                field_name=ev.field_name,
                source_value=ev.source_value,
                candidate_value=ev.candidate_value,
                points_awarded=ev.points_awarded,
                max_points=ev.max_points,
                match_method=ev.match_method,
                explanation=ev.explanation,
            )
            db.add(evidence_record)

        for cont in cand_res.contradictions:
            contradiction_record = Contradiction(
                candidate_id=cand_record.id,
                contradiction_type=cont.contradiction_type,
                severity=cont.severity.value,
                description=cont.description,
                blocks_likely_match=cont.blocks_likely_match,
            )
            db.add(contradiction_record)

    # Initial append-only audit events
    audit_ingested = AuditLog(
        case_id=case.id,
        event_type=AuditEventType.CASE_INGESTED.value,
        actor=ACTOR_SYSTEM,
        payload={"case_number": case_number, "source": source_type},
        created_at=_to_utc_naive(),
    )
    audit_routed = AuditLog(
        case_id=case.id,
        event_type=AuditEventType.SCORED_AND_ROUTED.value,
        actor=ACTOR_SYSTEM,
        payload={
            "top_score": resolution.top_score,
            "routing_status": resolution.routing_status.value,
            "candidate_count": len(resolution.candidates),
        },
        created_at=_to_utc_naive(),
    )
    db.add_all([audit_ingested, audit_routed])
    return case


def ingest_sample_cases(
    db: Session,
    workspace_id: str,
    resolution_service: ResolutionService | None = None,
) -> SampleIngestResponse:
    """Ingest 8 synthetic benchmark cases idempotently."""
    resolver = resolution_service or ResolutionService()
    case_ids: list[str] = []
    created_count = 0
    existing_count = 0

    for fixture in BENCHMARK_CASES:
        case_num = str(fixture["case_number"])
        query = fixture["query"]
        if not isinstance(query, CaseQuery):
            continue

        existing_case = db.scalar(
            select(Case).where(Case.workspace_id == workspace_id, Case.case_number == case_num)
        )
        if existing_case:
            case_ids.append(existing_case.id)
            existing_count += 1
        else:
            resolution = resolver.resolve(query)
            new_case = persist_case_resolution(
                db=db,
                workspace_id=workspace_id,
                case_number=case_num,
                source_identifier="BENCHMARK_SEED",
                query=query,
                resolution=resolution,
                source_type="sample",
            )
            case_ids.append(new_case.id)
            created_count += 1

    db.commit()
    return SampleIngestResponse(
        ingested_count=len(BENCHMARK_CASES),
        created_count=created_count,
        existing_count=existing_count,
        case_ids=case_ids,
    )


def ingest_csv(
    db: Session,
    file_content: str,
    workspace_id: str,
    resolution_service: ResolutionService | None = None,
    commit: bool = True,
) -> CsvIngestResponse:
    """Validate, resolve, and persist records from uploaded CSV."""
    records = parse_and_validate_csv(file_content, db, workspace_id)
    from app.services.source_service import workspace_resolver

    resolver = resolution_service or workspace_resolver(db, workspace_id)
    case_ids: list[str] = []

    try:
        for case_number, source_id, query in records:
            resolution = resolver.resolve(query)
            new_case = persist_case_resolution(
                db=db,
                workspace_id=workspace_id,
                case_number=case_number,
                source_identifier=source_id,
                query=query,
                resolution=resolution,
                source_type="csv_upload",
            )
            case_ids.append(new_case.id)
        db.flush()
        persisted_ids = db.scalars(
            select(Case.id).where(Case.workspace_id == workspace_id, Case.id.in_(case_ids))
        ).all()
        if len(persisted_ids) != len(records):
            raise RuntimeError("CSV batch persistence count mismatch")
        if commit:
            db.commit()
    except Exception:
        db.rollback()
        raise

    return CsvIngestResponse(
        ingested_count=len(records),
        created_count=len(persisted_ids),
        case_ids=case_ids,
    )


def list_cases(
    db: Session,
    workspace_id: str,
    routing_status: RoutingStatus | None = None,
    review_decision: ReviewDecision | None = None,
    search: str | None = None,
) -> list[CaseSummaryResponse]:
    """Retrieve filtered case summaries for the queue view."""
    stmt = (
        select(Case)
        .options(
            joinedload(Case.candidates),
            joinedload(Case.audit_logs),
        )
        .execution_options(populate_existing=True)
    )
    stmt = stmt.where(Case.workspace_id == workspace_id)

    if routing_status:
        stmt = stmt.where(Case.routing_status == routing_status.value)
    if review_decision:
        stmt = stmt.where(Case.review_decision == review_decision.value)
    if search:
        search_pattern = f"%{search.strip()}%"
        stmt = stmt.where(
            (Case.case_number.ilike(search_pattern))
            | (Case.raw_name.ilike(search_pattern))
            | (Case.raw_employer.ilike(search_pattern))
        )

    # Order newest first, then case_number
    stmt = stmt.order_by(Case.created_at.desc(), Case.case_number.asc())
    cases = db.scalars(stmt).unique().all()

    summaries: list[CaseSummaryResponse] = []
    for c in cases:
        top_cand = c.candidates[0] if c.candidates else None
        last_activity = c.audit_logs[0].created_at if c.audit_logs else c.created_at

        summaries.append(
            CaseSummaryResponse(
                id=c.id,
                case_number=c.case_number,
                source_identifier=c.source_identifier,
                person_name=c.raw_name,
                employer=c.raw_employer,
                location=c.raw_location,
                routing_status=RoutingStatus(c.routing_status),
                review_decision=ReviewDecision(c.review_decision),
                top_score=top_cand.total_score if top_cand else 0,
                top_candidate_name=top_cand.name if top_cand else None,
                has_serious_contradiction=top_cand.has_serious_contradiction if top_cand else False,
                candidate_count=len(c.candidates),
                last_activity_at=last_activity,
                created_at=c.created_at,
            )
        )

    return summaries


def get_case_detail(db: Session, workspace_id: str, case_id: str) -> CaseDetailResponse | None:
    """Retrieve full investigation detail for a single case."""
    stmt = (
        select(Case)
        .options(
            joinedload(Case.candidates).joinedload(CandidateRecord.evidence),
            joinedload(Case.candidates).joinedload(CandidateRecord.contradictions),
            joinedload(Case.audit_logs),
        )
        .where(Case.id == case_id, Case.workspace_id == workspace_id)
    )
    case = db.scalar(stmt)
    if not case:
        return None

    # Routing explanation based on status
    if case.routing_status == RoutingStatus.LIKELY_MATCH.value:
        explanation = "Strong evidence score with no blocking contradiction."
    elif case.routing_status == RoutingStatus.NEEDS_REVIEW.value:
        top_cand = case.candidates[0] if case.candidates else None
        if top_cand and top_cand.has_serious_contradiction:
            explanation = (
                "High evidence score blocked by a serious contradiction requiring human review."
            )
        else:
            explanation = "Partial evidence requires human review."
    else:
        explanation = "Available evidence is insufficient for a reliable match."

    cand_details: list[CandidateDetailResponse] = []
    for cand in case.candidates:
        ev_list = [
            MatchEvidenceResponse(
                id=ev.id,
                field_name=ev.field_name,
                source_value=ev.source_value,
                candidate_value=ev.candidate_value,
                points_awarded=ev.points_awarded,
                max_points=ev.max_points,
                match_method=ev.match_method,
                explanation=ev.explanation,
            )
            for ev in cand.evidence
        ]
        cont_list = [
            ContradictionResponse(
                id=ct.id,
                contradiction_type=ct.contradiction_type,
                severity=ContradictionSeverity(ct.severity),
                description=ct.description,
                blocks_likely_match=ct.blocks_likely_match,
            )
            for ct in cand.contradictions
        ]
        cand_details.append(
            CandidateDetailResponse(
                id=cand.id,
                provider_source=cand.provider_source,
                provider_record_id=cand.provider_record_id,
                name=cand.name,
                first_name=cand.first_name,
                middle_name=cand.middle_name,
                last_name=cand.last_name,
                name_suffix=cand.name_suffix,
                email=cand.email,
                phone=cand.phone,
                employer=cand.employer,
                job_title=cand.job_title,
                location=cand.location,
                total_score=cand.total_score,
                name_score=cand.name_score,
                email_score=cand.email_score,
                phone_score=cand.phone_score,
                employer_score=cand.employer_score,
                location_score=cand.location_score,
                has_serious_contradiction=cand.has_serious_contradiction,
                provenance_summary=cand.provenance_summary,
                evidence=ev_list,
                contradictions=cont_list,
            )
        )

    # Sort candidate details: highest score first, stable tie-breaker
    cand_details.sort(
        key=lambda c: (
            -c.total_score,
            f"{c.provider_source}:{c.provider_record_id}",
        )
    )

    audit_list = [
        AuditLogResponse(
            id=a.id,
            event_type=a.event_type,
            actor=a.actor,
            payload=a.payload,
            created_at=a.created_at,
        )
        for a in sorted(
            case.audit_logs, key=lambda x: _datetime_sort_key(x.created_at), reverse=True
        )
    ]

    ingestion = db.get(SourceIngestion, case.ingestion_id) if case.ingestion_id else None
    return CaseDetailResponse(
        id=case.id,
        case_number=case.case_number,
        source_identifier=case.source_identifier,
        received_at=ingestion.created_at if ingestion else case.created_at,
        ingestion_mechanism="source_api" if case.ingestion_id else "manual",
        source_id=case.source_id,
        ingestion_id=case.ingestion_id,
        external_record_id=case.external_record_id,
        raw_name=case.raw_name,
        normalized_name=case.normalized_name,
        name_prefix=case.name_prefix,
        first_name=case.first_name,
        middle_name=case.middle_name,
        last_name=case.last_name,
        name_suffix=case.name_suffix,
        raw_email=case.raw_email,
        normalized_email=case.normalized_email,
        raw_phone=case.raw_phone,
        normalized_phone=case.normalized_phone,
        raw_employer=case.raw_employer,
        normalized_employer=case.normalized_employer,
        raw_location=case.raw_location,
        normalized_location=case.normalized_location,
        routing_status=RoutingStatus(case.routing_status),
        routing_explanation=explanation,
        review_decision=ReviewDecision(case.review_decision),
        selected_candidate_id=case.selected_candidate_id,
        reviewer_notes=case.reviewer_notes,
        reviewed_at=case.reviewed_at,
        created_at=case.created_at,
        candidates=cand_details,
        audit_logs=audit_list,
    )


@traced("review.decision")
def record_decision(
    db: Session,
    workspace_id: str,
    case_id: str,
    request: DecisionRequest,
    actor: str,
) -> CaseDetailResponse:
    """Record reviewer decision and append an audit event."""
    case = db.scalar(
        select(Case)
        .options(joinedload(Case.candidates))
        .where(Case.id == case_id, Case.workspace_id == workspace_id)
    )
    if not case:
        raise ValueError("Case not found.")

    if request.decision == ReviewDecision.ACCEPTED:
        if not request.selected_candidate_id:
            raise ValueError("ACCEPTED requires a candidate from this case.")
        valid_cand_ids = {c.id for c in case.candidates}
        if request.selected_candidate_id not in valid_cand_ids:
            raise ValueError("Selected candidate does not belong to this case.")
    elif request.decision in (ReviewDecision.REJECTED, ReviewDecision.NEED_MORE_EVIDENCE):
        if request.selected_candidate_id is not None:
            raise ValueError(
                f"{request.decision.value} decision must not specify a selected_candidate_id."
            )

    previous_decision = case.review_decision
    case.review_decision = request.decision.value
    case.selected_candidate_id = (
        request.selected_candidate_id if request.decision == ReviewDecision.ACCEPTED else None
    )
    case.reviewer_notes = request.notes.strip() if request.notes else None
    case.reviewed_at = _to_utc_naive()

    # Append audit event
    audit = AuditLog(
        case_id=case.id,
        event_type=AuditEventType.DECISION_RECORDED.value,
        actor=actor,
        payload={
            "previous_decision": previous_decision,
            "decision": request.decision.value,
            "selected_candidate_id": case.selected_candidate_id,
            "has_note": bool(case.reviewer_notes),
        },
        created_at=_to_utc_naive(),
    )
    db.add(audit)
    db.commit()
    annotate(**{"review.decision": request.decision.value, "operation.status": "SUCCEEDED"})

    detail = get_case_detail(db, workspace_id, case_id)
    if not detail:
        raise ValueError("Case not found after decision update.")
    return detail


def _sanitize_csv_cell(value: str | None) -> str:
    """Neutralize potential spreadsheet formula injection in exported text fields."""
    if value is None:
        return ""
    if value and value[0] in ("=", "+", "-", "@", "\t", "\r"):
        return f"'{value}"
    return value


def export_reviewed_cases_csv(db: Session, workspace_id: str) -> str:
    """Export all non-pending reviewed cases as flat CSV."""
    stmt = (
        select(Case)
        .options(joinedload(Case.candidates))
        .where(
            Case.workspace_id == workspace_id, Case.review_decision != ReviewDecision.PENDING.value
        )
        .order_by(Case.case_number.asc())
    )
    cases = db.scalars(stmt).unique().all()

    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(
        [
            "case_number",
            "person_name",
            "routing_status",
            "top_candidate_score",
            "review_decision",
            "selected_candidate_id",
            "selected_candidate_name",
            "selected_candidate_provider",
            "reviewer_notes",
            "reviewed_at",
        ]
    )

    for c in cases:
        top_cand = c.candidates[0] if c.candidates else None
        top_score = str(top_cand.total_score) if top_cand else ""

        selected_cand_name = ""
        selected_cand_provider = ""
        if c.selected_candidate_id:
            for cand in c.candidates:
                if cand.id == c.selected_candidate_id:
                    selected_cand_name = cand.name
                    selected_cand_provider = cand.provider_source
                    break

        writer.writerow(
            [
                _sanitize_csv_cell(c.case_number),
                _sanitize_csv_cell(c.raw_name),
                c.routing_status,
                top_score,
                c.review_decision,
                c.selected_candidate_id or "",
                _sanitize_csv_cell(selected_cand_name),
                _sanitize_csv_cell(selected_cand_provider),
                _sanitize_csv_cell(c.reviewer_notes),
                c.reviewed_at.isoformat() if c.reviewed_at else "",
            ]
        )

    return output.getvalue()
