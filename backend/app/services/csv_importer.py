import csv
import io

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.case import Case
from app.schemas.resolution import CaseQuery

MAX_CSV_ROWS = 100
REQUIRED_HEADERS = {"case_number", "full_name"}
ALLOWED_HEADERS = {
    "case_number",
    "full_name",
    "source_identifier",
    "old_email",
    "old_phone",
    "employer",
    "location",
}


class CsvValidationError(Exception):
    """Raised when CSV validation fails."""

    pass


def parse_and_validate_csv(
    file_content: str,
    db: Session,
    workspace_id: str,
) -> list[tuple[str, str | None, CaseQuery]]:
    """Validate and parse CSV content. Returns list of (case_number, source_identifier, CaseQuery).

    Raises CsvValidationError with descriptive message if validation fails.
    """
    cleaned_content = file_content.strip()
    if not cleaned_content:
        raise CsvValidationError("Uploaded CSV file is empty.")

    reader = csv.DictReader(io.StringIO(cleaned_content))
    if not reader.fieldnames:
        raise CsvValidationError("CSV has no readable columns or header row.")

    fieldnames = {f.strip() for f in reader.fieldnames if f}
    missing_required = REQUIRED_HEADERS - fieldnames
    if missing_required:
        sorted_missing = sorted(list(missing_required))
        raise CsvValidationError(f"CSV is missing required column: {', '.join(sorted_missing)}.")

    rows: list[dict[str, str]] = list(reader)
    if not rows:
        raise CsvValidationError("Uploaded CSV contains no data rows.")

    if len(rows) > MAX_CSV_ROWS:
        raise CsvValidationError(f"CSV exceeds maximum limit of {MAX_CSV_ROWS} rows.")

    seen_case_numbers: set[str] = set()
    validated_records: list[tuple[str, str | None, CaseQuery]] = []

    for index, raw_row in enumerate(rows, start=2):
        row = {k.strip(): (v.strip() if v is not None else "") for k, v in raw_row.items() if k}

        case_number = row.get("case_number", "")
        if not case_number:
            raise CsvValidationError(f"Row {index}: case_number is required.")

        if case_number in seen_case_numbers:
            raise CsvValidationError(
                f"Row {index}: duplicate case_number '{case_number}' found in upload."
            )
        seen_case_numbers.add(case_number)

        full_name = row.get("full_name", "")
        if not full_name:
            raise CsvValidationError(f"Row {index}: full_name is required.")

        source_id = row.get("source_identifier") or None
        old_email = row.get("old_email") or None
        old_phone = row.get("old_phone") or None
        employer = row.get("employer") or None
        location = row.get("location") or None

        query = CaseQuery(
            name=full_name,
            email=old_email,
            phone=old_phone,
            employer=employer,
            location=location,
        )
        validated_records.append((case_number, source_id, query))

    # Check for existing case numbers in database
    existing_cases = db.scalars(
        select(Case.case_number).where(
            Case.workspace_id == workspace_id, Case.case_number.in_(seen_case_numbers)
        )
    ).all()
    if existing_cases:
        first_existing = existing_cases[0]
        # Find which row it was
        for index, record in enumerate(validated_records, start=2):
            if record[0] == first_existing:
                raise CsvValidationError(
                    f"Row {index}: case_number '{first_existing}' already exists in database."
                )

    return validated_records
