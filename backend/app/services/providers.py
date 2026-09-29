from dataclasses import dataclass
from typing import Protocol

from app.schemas.resolution import CaseQuery, RawCandidate
from app.services.extractor import GeminiExtractor
from app.services.normalizer import normalize_name


@dataclass
class UnstructuredEvidenceRecord:
    provider_source: str
    provider_record_id: str
    raw_evidence_text: str
    provenance_title: str


class CandidateProvider(Protocol):
    provider_id: str
    provider_name: str

    def search(self, query: CaseQuery) -> list[RawCandidate]:
        """Search local synthetic records matching query."""
        ...


# Benchmark provider candidate datasets
CRM_ARCHIVE_FIXTURES: list[RawCandidate] = [
    # Case 1 Candidate (Claire Reynolds)
    RawCandidate(
        provider_source="CRM_ARCHIVE",
        provider_record_id="CRM-1001",
        name="Claire Reynolds",
        first_name="Claire",
        last_name="Reynolds",
        email="claire.reynolds@acmehealth.demo",
        phone="+1 (202) 555-0123",
        employer="Acme Health Group Inc",
        job_title="Clinical Director",
        location="Chicago, Illinois",
        provenance_summary="Synthetic CRM Archive (Verified 2025 Export)",
    ),
    # Case 4 Candidate A (Robert Taylor)
    RawCandidate(
        provider_source="CRM_ARCHIVE",
        provider_record_id="CRM-1004",
        name="Robert Taylor",
        first_name="Robert",
        last_name="Taylor",
        email="robert.taylor@summittech.demo",
        phone="+1 202-555-0133",
        employer="Summit Technologies",
        job_title="Software Architect",
        location="Seattle, WA",
        provenance_summary="Synthetic CRM Archive (Historical Employee Record)",
    ),
    # Case 5 Candidate (Arthur James Pendelton Sr.)
    RawCandidate(
        provider_source="CRM_ARCHIVE",
        provider_record_id="CRM-1005",
        name="Arthur James Pendelton Sr.",
        first_name="Arthur",
        middle_name="James",
        last_name="Pendelton",
        name_suffix="Sr.",
        email="a.pendelton@beacon-financial.demo",
        phone="+1 (202) 555-0155",
        employer="Beacon Financial Corp",
        job_title="Senior Managing Director",
        location="New York, NY",
        provenance_summary="Synthetic CRM Archive (Historical Account Holder)",
    ),
]

DIRECTORY_B2B_FIXTURES: list[RawCandidate] = [
    # Case 2 Candidate (David Mitchell)
    RawCandidate(
        provider_source="SYNTHETIC_DIR_B2B",
        provider_record_id="B2B-2002",
        name="David Mitchell",
        first_name="David",
        last_name="Mitchell",
        email="dmitchell@crestviewlogistics.demo",
        phone="+1 202-555-0199",
        employer="Crestview Logistics LLC",
        job_title="Logistics Manager",
        location="Denver, CO",
        provenance_summary="Synthetic B2B Directory (2025 Active Profile)",
    ),
    # Case 4 Candidate B (Robert J. Taylor)
    RawCandidate(
        provider_source="SYNTHETIC_DIR_B2B",
        provider_record_id="B2B-2004",
        name="Robert J. Taylor",
        first_name="Robert",
        middle_name="J.",
        last_name="Taylor",
        email="rtaylor@summittech.demo",
        phone="+1 202-555-0144",
        employer="Summit Technologies",
        job_title="Systems Engineer",
        location="Portland, OR",
        provenance_summary="Synthetic B2B Directory (Regional Profile)",
    ),
    # Case 6 Candidate (Marcus Sterling)
    RawCandidate(
        provider_source="SYNTHETIC_DIR_B2B",
        provider_record_id="B2B-2006",
        name="Marcus Sterling",
        first_name="Marcus",
        last_name="Sterling",
        email="msterling@apexsupply.demo",
        phone="+1 202-555-0188",
        employer="Orion Energy Partners",
        job_title="Operations Analyst",
        location="Atlanta, GA",
        provenance_summary="Synthetic B2B Directory (Recent Update)",
    ),
    # Case 8 Candidate (Tariq Mansour)
    RawCandidate(
        provider_source="SYNTHETIC_DIR_B2B",
        provider_record_id="B2B-2008",
        name="Tariq Mansour",
        first_name="Tariq",
        last_name="Mansour",
        email="tmansour@globalcorp.demo",
        phone="+1 202-555-0177",
        employer="Global Synergy Corp",
        job_title="Business Development Lead",
        location="Miami, FL",
        provenance_summary="Synthetic B2B Directory (Unrelated Record)",
    ),
]

PARTNER_REGISTRY_FIXTURES: list[RawCandidate] = [
    # Case 3 Candidate (Elena Rostova)
    RawCandidate(
        provider_source="PARTNER_REGISTRY_MOCK",
        provider_record_id="PR-3003",
        name="Elena Rostova",
        first_name="Elena",
        last_name="Rostova",
        email="erostova@vanguard-analytics.demo",
        phone="+1 (202) 555-0144",
        employer="Vanguard Analytics Inc",
        job_title="Principal Researcher",
        location="Boston, MA",
        provenance_summary="Partner Registry Mock (Verified Contact Record)",
    ),
    # Case 7 Candidate (Karen Miller)
    RawCandidate(
        provider_source="PARTNER_REGISTRY_MOCK",
        provider_record_id="PR-3007",
        name="Karen Miller",
        first_name="Karen",
        last_name="Miller",
        email="karen.m@solaris-labs.demo",
        phone=None,
        employer="Solaris Labs Inc",
        job_title="Product Lead",
        location=None,
        provenance_summary="Partner Registry Mock (Partial Listing)",
    ),
]


def _match_query(query: CaseQuery, candidate: RawCandidate) -> bool:
    """Helper to check if synthetic candidate belongs in query's candidate pool."""
    if not query.name:
        return False
    norm_q = normalize_name(query.name)
    norm_c = normalize_name(candidate.name)

    # Allow if names share first/last or have partial token overlap
    q_tokens = set(norm_q.split(" "))
    c_tokens = set(norm_c.split(" "))
    return len(q_tokens.intersection(c_tokens)) > 0 or (
        query.email is not None and candidate.email == query.email
    )


class MockCrmArchiveProvider:
    provider_id: str = "CRM_ARCHIVE"
    provider_name: str = "CRM Historical Archive"

    def search(self, query: CaseQuery) -> list[RawCandidate]:
        return [cand for cand in CRM_ARCHIVE_FIXTURES if _match_query(query, cand)]


class MockDirectoryB2BProvider:
    provider_id: str = "SYNTHETIC_DIR_B2B"
    provider_name: str = "Synthetic B2B Directory"

    def search(self, query: CaseQuery) -> list[RawCandidate]:
        return [cand for cand in DIRECTORY_B2B_FIXTURES if _match_query(query, cand)]


class MockPartnerRegistryProvider:
    provider_id: str = "PARTNER_REGISTRY_MOCK"
    provider_name: str = "Partner Registry Mock"

    def search(self, query: CaseQuery) -> list[RawCandidate]:
        return [cand for cand in PARTNER_REGISTRY_FIXTURES if _match_query(query, cand)]


UNSTRUCTURED_EVIDENCE_FIXTURES: list[UnstructuredEvidenceRecord] = [
    UnstructuredEvidenceRecord(
        provider_source="SYNTHETIC_FIELD_NOTES",
        provider_record_id="UNSTRUCT-4001",
        raw_evidence_text=(
            "Spoke with Claire Reynolds — now at Northstar Analytics as Senior Data Analyst "
            "in Seattle. Best email appears to be claire.reynolds@example.demo; "
            "mobile +1 202-555-0101."
        ),
        provenance_title="Synthetic Field Notes (Call Log 2025)",
    ),
    UnstructuredEvidenceRecord(
        provider_source="SYNTHETIC_RECRUITER_NOTES",
        provider_record_id="UNSTRUCT-4002",
        raw_evidence_text=(
            "Candidate brief: David Mitchell, Logistics Manager at Crestview Logistics LLC "
            "based out of Denver, CO. Contact: dmitchell@crestviewlogistics.demo, "
            "cell +1 202-555-0199."
        ),
        provenance_title="Recruiter Outreach Notes",
    ),
    UnstructuredEvidenceRecord(
        provider_source="SYNTHETIC_CONFERENCE_ROSTER",
        provider_record_id="UNSTRUCT-4003",
        raw_evidence_text=(
            "Meeting attendee note: Elena Rostova (Principal Researcher) affiliated with "
            "Vanguard Analytics Inc in Boston, MA. Direct telephone +1 (202) 555-0144."
        ),
        provenance_title="Conference Participant Transcript",
    ),
]


class GeminiUnstructuredEvidenceProvider:
    provider_id: str = "SYNTHETIC_UNSTRUCTURED_NOTES"
    provider_name: str = "Synthetic Unstructured Notes (Gemini Extracted)"

    def __init__(
        self,
        extractor: GeminiExtractor | None = None,
        fixtures: list[UnstructuredEvidenceRecord] | None = None,
    ) -> None:
        self.extractor = extractor or GeminiExtractor()
        self.fixtures = fixtures if fixtures is not None else UNSTRUCTURED_EVIDENCE_FIXTURES

    def search(self, query: CaseQuery) -> list[RawCandidate]:
        candidates: list[RawCandidate] = []
        if not query.name:
            return candidates

        norm_q = normalize_name(query.name)
        q_tokens = [t for t in norm_q.split(" ") if len(t) > 2]

        for record in self.fixtures:
            norm_text = record.raw_evidence_text.lower()
            if any(token in norm_text for token in q_tokens):
                extracted_candidate = self.extractor.extract_candidate_from_evidence(
                    provider_source=record.provider_source,
                    provider_record_id=record.provider_record_id,
                    raw_evidence_text=record.raw_evidence_text,
                    provenance_title=record.provenance_title,
                )
                candidates.append(extracted_candidate)

        return candidates
