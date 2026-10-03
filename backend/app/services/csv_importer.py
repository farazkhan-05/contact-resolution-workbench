import csv
import io
from typing import cast

from sqlalchemy import String, select
from sqlalchemy.orm import Session

from app.models.case import Case
from app.schemas.resolution import CaseQuery
from app.services.normalizer import (
    normalize_email,
    normalize_employer,
    normalize_location,
    normalize_name,
    normalize_phone,
    parse_name_parts,
)

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


def _storage_limit(column: str) -> int:
    limit = cast(String, Case.__table__.c[column].type).length
    assert limit is not None
    return limit


class CsvValidationError(Exception):
    """Raised when CSV validation fails."""

    def __init__(self, message: str, total_rows: int | None = None) -> None:
        super().__init__(message)
        self.total_rows = total_rows


def parse_and_validate_csv(
    file_content: str,
    db: Session,
    workspace_id: str,
) -> list[tuple[str, str | None, CaseQuery]]:
    """Validate and parse CSV content. Returns list of (case_number, source_identifier, CaseQuery).

    Raises CsvValidationError with descriptive message if validation fails.
    """
    if not file_content.strip():
        raise CsvValidationError("Uploaded CSV file is empty.")

    # A plain reader preserves blank records and overflow cells. DictReader silently
    # ignores blank lines and collapses duplicate headers before we can validate them.
    reader = csv.reader(io.StringIO(file_content.removeprefix("\ufeff")), strict=True)
    try:
        headers = next(reader, [])
        rows = list(reader)
    except csv.Error as exc:
        raise CsvValidationError(
            f"CSV could not be read near line {reader.line_num}. Check quoting and field sizes."
        ) from exc
    if not headers:
        raise CsvValidationError("CSV has no readable columns or header row.")

    total_rows = len(rows)
    headers = [header.strip() for header in headers]
    if any(not header for header in headers):
        raise CsvValidationError("CSV contains an empty column header.", total_rows)
    if len(set(headers)) != len(headers):
        raise CsvValidationError("CSV contains duplicate column headers.", total_rows)
    fieldnames = set(headers)
    missing_required = REQUIRED_HEADERS - fieldnames
    if missing_required:
        sorted_missing = sorted(list(missing_required))
        raise CsvValidationError(
            f"CSV is missing required column: {', '.join(sorted_missing)}.", total_rows
        )
    if fieldnames - ALLOWED_HEADERS:
        raise CsvValidationError(
            "CSV contains unsupported columns. Use only case_number, full_name, "
            "source_identifier, old_email, old_phone, employer, location.",
            total_rows,
        )

    if not rows:
        raise CsvValidationError("Uploaded CSV contains no data rows.", 0)

    if len(rows) > MAX_CSV_ROWS:
        raise CsvValidationError(f"CSV exceeds maximum limit of {MAX_CSV_ROWS} rows.", total_rows)

    seen_case_numbers: set[str] = set()
    validated_records: list[tuple[str, str | None, CaseQuery]] = []

    for index, raw_row in enumerate(rows, start=2):
        if not raw_row or all(not value.strip() for value in raw_row):
            raise CsvValidationError(f"Row {index}: remove the blank row.", total_rows)
        if len(raw_row) != len(headers):
            raise CsvValidationError(
                f"Row {index}: the number of values must match the column headers.", total_rows
            )
        row = dict(zip(headers, (value.strip() for value in raw_row), strict=True))

        case_number = row.get("case_number", "")
        if not case_number:
            raise CsvValidationError(f"Row {index}: case_number is required.", total_rows)

        if case_number in seen_case_numbers:
            raise CsvValidationError(
                f"Row {index}: duplicate case_number found in upload.", total_rows
            )
        seen_case_numbers.add(case_number)

        full_name = row.get("full_name", "")
        if not full_name:
            raise CsvValidationError(f"Row {index}: full_name is required.", total_rows)

        columns = {
            "case_number": "case_number",
            "source_identifier": "source_identifier",
            "full_name": "raw_name",
            "old_email": "raw_email",
            "old_phone": "raw_phone",
            "employer": "raw_employer",
            "location": "raw_location",
        }
        for header, column in columns.items():
            value = row.get(header, "")
            limit = _storage_limit(column)
            if "\x00" in value or len(value) > limit:
                raise CsvValidationError(
                    f"Row {index}: {header} must contain at most {limit} characters "
                    "and no null characters.",
                    total_rows,
                )

        derived = {
            "normalized_name": normalize_name(full_name),
            "normalized_email": normalize_email(row.get("old_email")),
            "normalized_phone": normalize_phone(row.get("old_phone")),
            "normalized_employer": normalize_employer(row.get("employer")),
            "normalized_location": normalize_location(row.get("location")),
            **{
                ("name_" + k if k in {"prefix", "suffix"} else k): v
                for k, v in parse_name_parts(full_name).items()
            },
        }
        for column, derived_value in derived.items():
            if derived_value and len(derived_value) > _storage_limit(column):
                raise CsvValidationError(
                    f"Row {index}: a name or contact value is too long to save.", total_rows
                )

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
    existing_case_numbers = set(existing_cases)
    for index, record in enumerate(validated_records, start=2):
        if record[0] in existing_case_numbers:
            raise CsvValidationError(
                f"Row {index}: a case_number already exists in database.", total_rows
            )

    return validated_records
