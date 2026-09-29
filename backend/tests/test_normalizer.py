from app.services.normalizer import (
    normalize_email,
    normalize_employer,
    normalize_location,
    normalize_name,
    normalize_phone,
    parse_location_parts,
    parse_name_parts,
)


def test_normalize_name() -> None:
    assert normalize_name("  Jane   Doe  ") == "jane doe"
    assert normalize_name("Dr. Eleanor Vance, Jr.") == "dr. eleanor vance, jr."
    assert normalize_name("") == ""
    assert normalize_name(None) == ""


def test_parse_name_parts() -> None:
    parts = parse_name_parts("Dr. Arthur James Pendelton Jr.")
    assert parts["prefix"] == "Dr."
    assert parts["first_name"] == "Arthur"
    assert parts["middle_name"] == "James"
    assert parts["last_name"] == "Pendelton"
    assert parts["suffix"] == "Jr."

    simple_parts = parse_name_parts("Robert Taylor")
    assert simple_parts["first_name"] == "Robert"
    assert simple_parts["last_name"] == "Taylor"
    assert simple_parts["middle_name"] is None
    assert simple_parts["suffix"] is None


def test_normalize_email() -> None:
    assert normalize_email("  User.Test@Demo-Domain.COM ") == "user.test@demo-domain.com"
    assert normalize_email("") == ""
    assert normalize_email(None) == ""


def test_normalize_phone() -> None:
    assert normalize_phone("+1 (202) 555-0123") == "12025550123"
    assert normalize_phone("202-555-0123") == "2025550123"
    assert normalize_phone("+1 202 555 0123 ext. 4") == "120255501234"
    assert normalize_phone(None) == ""


def test_normalize_employer() -> None:
    assert normalize_employer("Acme Health Group Inc") == "acme health"
    assert normalize_employer("Vanguard Analytics, LLC.") == "vanguard analytics"
    assert normalize_employer("Summit Technologies Corporation") == "summit technologies"
    assert normalize_employer("Apex Supply Chain Ltd") == "apex supply chain"
    assert normalize_employer("Solaris Labs") == "solaris labs"
    assert normalize_employer(None) == ""


def test_parse_and_normalize_location() -> None:
    city, state = parse_location_parts("Chicago, IL")
    assert city == "chicago"
    assert state == "il"

    city2, state2 = parse_location_parts("Chicago, Illinois, USA")
    assert city2 == "chicago"
    assert state2 == "il"

    assert normalize_location("Chicago, IL") == "chicago, il"
    assert normalize_location("Denver, Colorado") == "denver, co"
    assert normalize_location("Austin, Texas, USA") == "austin, tx"
    assert normalize_location(None) == ""
