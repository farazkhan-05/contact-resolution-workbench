from app.core.constants import ContradictionSeverity
from app.schemas.resolution import CaseQuery, ContradictionResult, RawCandidate
from app.services.normalizer import (
    normalize_employer,
    parse_location_parts,
    parse_name_parts,
)


def evaluate_contradictions(
    query: CaseQuery,
    candidate: RawCandidate,
) -> list[ContradictionResult]:
    contradictions: list[ContradictionResult] = []

    # 1. SERIOUS: INCOMPATIBLE_NAME_SUFFIX
    src_name_parts = parse_name_parts(query.name)
    cand_name_parts = parse_name_parts(candidate.name)

    src_suffix = query.name_suffix or src_name_parts.get("suffix")
    cand_suffix = candidate.name_suffix or cand_name_parts.get("suffix")

    if src_suffix and cand_suffix:
        norm_src_suf = src_suffix.lower().rstrip(".")
        norm_cand_suf = cand_suffix.lower().rstrip(".")
        if norm_src_suf != norm_cand_suf:
            contradictions.append(
                ContradictionResult(
                    contradiction_type="INCOMPATIBLE_NAME_SUFFIX",
                    severity=ContradictionSeverity.SERIOUS,
                    description=(
                        f"Incompatible name suffixes detected ('{src_suffix}' vs '{cand_suffix}')."
                    ),
                    blocks_likely_match=True,
                )
            )

    # 2. SERIOUS: CONFLICTING_FULL_MIDDLE_NAME
    src_mid = query.middle_name or src_name_parts.get("middle_name")
    cand_mid = candidate.middle_name or cand_name_parts.get("middle_name")

    if src_mid and cand_mid:
        clean_src_mid = src_mid.strip().rstrip(".").lower()
        clean_cand_mid = cand_mid.strip().rstrip(".").lower()
        # Only trigger if both are full middle names (length > 1) and differ
        if len(clean_src_mid) > 1 and len(clean_cand_mid) > 1 and clean_src_mid != clean_cand_mid:
            contradictions.append(
                ContradictionResult(
                    contradiction_type="CONFLICTING_FULL_MIDDLE_NAME",
                    severity=ContradictionSeverity.SERIOUS,
                    description=(
                        f"Explicit conflicting full middle names ('{src_mid}' vs '{cand_mid}')."
                    ),
                    blocks_likely_match=True,
                )
            )

    # 3. MODERATE: DIFFERING_EMPLOYER
    if query.employer and candidate.employer:
        norm_src_emp = normalize_employer(query.employer)
        norm_cand_emp = normalize_employer(candidate.employer)
        if norm_src_emp and norm_cand_emp and norm_src_emp != norm_cand_emp:
            # Check if there is token overlap
            from rapidfuzz import fuzz

            if fuzz.token_set_ratio(norm_src_emp, norm_cand_emp) < 85.0:
                contradictions.append(
                    ContradictionResult(
                        contradiction_type="DIFFERING_EMPLOYER",
                        severity=ContradictionSeverity.MODERATE,
                        description=(
                            f"Differing employer ('{query.employer}' vs '{candidate.employer}')."
                        ),
                        blocks_likely_match=False,
                    )
                )

    # 4. MODERATE: DIFFERING_GEOGRAPHY
    if query.location and candidate.location:
        _, src_state = parse_location_parts(query.location)
        _, cand_state = parse_location_parts(candidate.location)
        if src_state and cand_state and src_state != cand_state:
            contradictions.append(
                ContradictionResult(
                    contradiction_type="DIFFERING_GEOGRAPHY",
                    severity=ContradictionSeverity.MODERATE,
                    description=(
                        f"Differing locations ('{query.location}' vs '{candidate.location}')."
                    ),
                    blocks_likely_match=False,
                )
            )

    return contradictions
