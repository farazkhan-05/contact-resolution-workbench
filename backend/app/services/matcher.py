from rapidfuzz import fuzz

from app.core.constants import (
    SCORE_MAX_EMAIL,
    SCORE_MAX_EMPLOYER,
    SCORE_MAX_LOCATION,
    SCORE_MAX_NAME,
    SCORE_MAX_PHONE,
    SCORE_MAX_TOTAL,
)
from app.schemas.resolution import CaseQuery, MatchEvidenceResult, RawCandidate
from app.services.normalizer import (
    normalize_email,
    normalize_employer,
    normalize_location,
    normalize_name,
    normalize_phone,
    parse_location_parts,
    parse_name_parts,
)

NAME_HIGH_THRESHOLD = 90.0
NAME_MODERATE_THRESHOLD = 70.0
EMPLOYER_HIGH_THRESHOLD = 85.0


def score_name(source_name: str | None, cand_name: str | None) -> MatchEvidenceResult:
    norm_src = normalize_name(source_name)
    norm_cand = normalize_name(cand_name)

    if not norm_src or not norm_cand:
        return MatchEvidenceResult(
            field_name="name",
            source_value=source_name,
            candidate_value=cand_name,
            points_awarded=0,
            max_points=SCORE_MAX_NAME,
            match_method="MISSING",
            explanation="Subject or candidate name is missing.",
        )

    if norm_src == norm_cand:
        return MatchEvidenceResult(
            field_name="name",
            source_value=source_name,
            candidate_value=cand_name,
            points_awarded=SCORE_MAX_NAME,
            max_points=SCORE_MAX_NAME,
            match_method="EXACT_MATCH",
            explanation="Normalized full names are identical.",
        )

    src_parts = parse_name_parts(source_name)
    cand_parts = parse_name_parts(cand_name)

    # Check for base name match (first and last match) with middle initial or suffix variation
    if (
        src_parts["first_name"]
        and cand_parts["first_name"]
        and src_parts["last_name"]
        and cand_parts["last_name"]
        and src_parts["first_name"].lower() == cand_parts["first_name"].lower()
        and src_parts["last_name"].lower() == cand_parts["last_name"].lower()
    ):
        src_mid = src_parts["middle_name"]
        cand_mid = cand_parts["middle_name"]
        src_suf = src_parts["suffix"]
        cand_suf = cand_parts["suffix"]

        # If base name matches with suffix variation
        if (src_suf or cand_suf) and (
            not src_mid
            or not cand_mid
            or src_mid.lower() == cand_mid.lower()
            or len(src_mid) <= 2
            or len(cand_mid) <= 2
        ):
            return MatchEvidenceResult(
                field_name="name",
                source_value=source_name,
                candidate_value=cand_name,
                points_awarded=20,
                max_points=SCORE_MAX_NAME,
                match_method="HIGH_SIMILARITY",
                explanation="Base name matches with suffix variation.",
            )

        # Case where one has middle initial/name and other does not, or one is single letter
        if not src_mid or not cand_mid or len(src_mid) <= 2 or len(cand_mid) <= 2:
            return MatchEvidenceResult(
                field_name="name",
                source_value=source_name,
                candidate_value=cand_name,
                points_awarded=20,
                max_points=SCORE_MAX_NAME,
                match_method="MIDDLE_INITIAL_VARIATION",
                explanation="First and last names match exactly with middle initial variation.",
            )

    sim = float(fuzz.token_sort_ratio(norm_src, norm_cand))
    if sim >= NAME_HIGH_THRESHOLD:
        return MatchEvidenceResult(
            field_name="name",
            source_value=source_name,
            candidate_value=cand_name,
            points_awarded=20,
            max_points=SCORE_MAX_NAME,
            match_method="HIGH_SIMILARITY",
            explanation=f"Name has high deterministic token similarity ({sim:.0f}%).",
        )
    elif sim >= NAME_MODERATE_THRESHOLD:
        return MatchEvidenceResult(
            field_name="name",
            source_value=source_name,
            candidate_value=cand_name,
            points_awarded=10,
            max_points=SCORE_MAX_NAME,
            match_method="MODERATE_SIMILARITY",
            explanation=f"Name has moderate deterministic token similarity ({sim:.0f}%).",
        )

    return MatchEvidenceResult(
        field_name="name",
        source_value=source_name,
        candidate_value=cand_name,
        points_awarded=0,
        max_points=SCORE_MAX_NAME,
        match_method="DIFFERENT",
        explanation=f"Names differ (similarity {sim:.0f}% is below threshold).",
    )


def score_email(source_email: str | None, cand_email: str | None) -> MatchEvidenceResult:
    norm_src = normalize_email(source_email)
    norm_cand = normalize_email(cand_email)

    if not norm_src or not norm_cand:
        return MatchEvidenceResult(
            field_name="email",
            source_value=source_email,
            candidate_value=cand_email,
            points_awarded=0,
            max_points=SCORE_MAX_EMAIL,
            match_method="MISSING",
            explanation="Email address is missing from source or candidate record.",
        )

    if norm_src == norm_cand:
        return MatchEvidenceResult(
            field_name="email",
            source_value=source_email,
            candidate_value=cand_email,
            points_awarded=SCORE_MAX_EMAIL,
            max_points=SCORE_MAX_EMAIL,
            match_method="EXACT_MATCH",
            explanation="Normalized email addresses are identical.",
        )

    return MatchEvidenceResult(
        field_name="email",
        source_value=source_email,
        candidate_value=cand_email,
        points_awarded=0,
        max_points=SCORE_MAX_EMAIL,
        match_method="DIFFERENT",
        explanation="Email addresses differ.",
    )


def score_phone(source_phone: str | None, cand_phone: str | None) -> MatchEvidenceResult:
    norm_src = normalize_phone(source_phone)
    norm_cand = normalize_phone(cand_phone)

    if not norm_src or not norm_cand:
        return MatchEvidenceResult(
            field_name="phone",
            source_value=source_phone,
            candidate_value=cand_phone,
            points_awarded=0,
            max_points=SCORE_MAX_PHONE,
            match_method="MISSING",
            explanation="Phone number is missing from source or candidate record.",
        )

    if norm_src == norm_cand:
        return MatchEvidenceResult(
            field_name="phone",
            source_value=source_phone,
            candidate_value=cand_phone,
            points_awarded=SCORE_MAX_PHONE,
            max_points=SCORE_MAX_PHONE,
            match_method="EXACT_MATCH",
            explanation="Normalized phone digits are identical.",
        )

    return MatchEvidenceResult(
        field_name="phone",
        source_value=source_phone,
        candidate_value=cand_phone,
        points_awarded=0,
        max_points=SCORE_MAX_PHONE,
        match_method="DIFFERENT",
        explanation="Phone numbers differ after formatting is removed.",
    )


def score_employer(source_emp: str | None, cand_emp: str | None) -> MatchEvidenceResult:
    norm_src = normalize_employer(source_emp)
    norm_cand = normalize_employer(cand_emp)

    if not norm_src or not norm_cand:
        return MatchEvidenceResult(
            field_name="employer",
            source_value=source_emp,
            candidate_value=cand_emp,
            points_awarded=0,
            max_points=SCORE_MAX_EMPLOYER,
            match_method="MISSING",
            explanation="Employer is missing from source or candidate record.",
        )

    if norm_src == norm_cand:
        return MatchEvidenceResult(
            field_name="employer",
            source_value=source_emp,
            candidate_value=cand_emp,
            points_awarded=SCORE_MAX_EMPLOYER,
            max_points=SCORE_MAX_EMPLOYER,
            match_method="EXACT_MATCH",
            explanation="Employer names match after legal suffix and whitespace normalization.",
        )

    sim = float(fuzz.token_set_ratio(norm_src, norm_cand))
    if sim >= EMPLOYER_HIGH_THRESHOLD:
        return MatchEvidenceResult(
            field_name="employer",
            source_value=source_emp,
            candidate_value=cand_emp,
            points_awarded=6,
            max_points=SCORE_MAX_EMPLOYER,
            match_method="HIGH_SIMILARITY",
            explanation=f"Employer names have high token similarity ({sim:.0f}%).",
        )

    return MatchEvidenceResult(
        field_name="employer",
        source_value=source_emp,
        candidate_value=cand_emp,
        points_awarded=0,
        max_points=SCORE_MAX_EMPLOYER,
        match_method="DIFFERENT",
        explanation="Employer names differ.",
    )


def score_location(source_loc: str | None, cand_loc: str | None) -> MatchEvidenceResult:
    norm_src = normalize_location(source_loc)
    norm_cand = normalize_location(cand_loc)

    if not norm_src or not norm_cand:
        return MatchEvidenceResult(
            field_name="location",
            source_value=source_loc,
            candidate_value=cand_loc,
            points_awarded=0,
            max_points=SCORE_MAX_LOCATION,
            match_method="MISSING",
            explanation="Location is missing from source or candidate record.",
        )

    src_city, src_state = parse_location_parts(source_loc)
    cand_city, cand_state = parse_location_parts(cand_loc)

    if norm_src == norm_cand or (
        src_city and cand_city and src_city == cand_city and src_state and src_state == cand_state
    ):
        return MatchEvidenceResult(
            field_name="location",
            source_value=source_loc,
            candidate_value=cand_loc,
            points_awarded=SCORE_MAX_LOCATION,
            max_points=SCORE_MAX_LOCATION,
            match_method="EXACT_MATCH",
            explanation="City and state locations match exactly.",
        )

    if src_state and cand_state and src_state == cand_state:
        return MatchEvidenceResult(
            field_name="location",
            source_value=source_loc,
            candidate_value=cand_loc,
            points_awarded=5,
            max_points=SCORE_MAX_LOCATION,
            match_method="SAME_STATE",
            explanation=(
                f"State locations match ({src_state.upper()}) with differing or unspecified city."
            ),
        )

    return MatchEvidenceResult(
        field_name="location",
        source_value=source_loc,
        candidate_value=cand_loc,
        points_awarded=0,
        max_points=SCORE_MAX_LOCATION,
        match_method="DIFFERENT",
        explanation="Locations differ.",
    )


def score_candidate(query: CaseQuery, candidate: RawCandidate) -> list[MatchEvidenceResult]:
    """Calculate field evidence scores between query and candidate."""
    evidence = [
        score_name(query.name, candidate.name),
        score_email(query.email, candidate.email),
        score_phone(query.phone, candidate.phone),
        score_employer(query.employer, candidate.employer),
        score_location(query.location, candidate.location),
    ]
    return evidence


def calculate_total_score(evidence: list[MatchEvidenceResult]) -> int:
    total = sum(e.points_awarded for e in evidence)
    return min(total, SCORE_MAX_TOTAL)
