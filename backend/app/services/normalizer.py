import re

US_STATES: dict[str, str] = {
    "al": "alabama",
    "ak": "alaska",
    "az": "arizona",
    "ar": "arkansas",
    "ca": "california",
    "co": "colorado",
    "ct": "connecticut",
    "de": "delaware",
    "fl": "florida",
    "ga": "georgia",
    "hi": "hawaii",
    "id": "idaho",
    "il": "illinois",
    "in": "indiana",
    "ia": "iowa",
    "ks": "kansas",
    "ky": "kentucky",
    "la": "louisiana",
    "me": "maine",
    "md": "maryland",
    "ma": "massachusetts",
    "mi": "michigan",
    "mn": "minnesota",
    "ms": "mississippi",
    "mo": "missouri",
    "mt": "montana",
    "ne": "nebraska",
    "nv": "nevada",
    "nh": "new hampshire",
    "nj": "new jersey",
    "nm": "new mexico",
    "ny": "new york",
    "nc": "north carolina",
    "nd": "north dakota",
    "oh": "ohio",
    "ok": "oklahoma",
    "or": "oregon",
    "pa": "pennsylvania",
    "ri": "rhode island",
    "sc": "south carolina",
    "sd": "south dakota",
    "tn": "tennessee",
    "tx": "texas",
    "ut": "utah",
    "vt": "vermont",
    "va": "virginia",
    "wa": "washington",
    "wv": "west virginia",
    "wi": "wisconsin",
    "wy": "wyoming",
}

# Reverse lookup for state names to 2-letter codes
STATE_NAME_TO_CODE = {v: k for k, v in US_STATES.items()}

KNOWN_SUFFIXES = {"jr", "jr.", "sr", "sr.", "ii", "iii", "iv", "v"}
KNOWN_PREFIXES = {"dr", "dr.", "mr", "mr.", "ms", "ms.", "mrs", "mrs.", "prof", "prof."}
LEGAL_SUFFIXES = [
    "incorporated",
    "corporation",
    "limited",
    "group",
    "corp",
    "inc",
    "llc",
    "ltd",
]


def normalize_whitespace(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def normalize_name(name: str | None) -> str:
    if not name:
        return ""
    cleaned = normalize_whitespace(name.lower())
    # Remove surrounding non-word characters except dots or hyphens
    cleaned = re.sub(r"^[^\w]+|[^\w\.]+$", "", cleaned)
    return cleaned


def parse_name_parts(name: str | None) -> dict[str, str | None]:
    """Parse name into prefix, first_name, middle_name, last_name, name_suffix."""
    if not name:
        return {
            "prefix": None,
            "first_name": None,
            "middle_name": None,
            "last_name": None,
            "suffix": None,
        }

    tokens = normalize_whitespace(name).split(" ")
    if not tokens:
        return {
            "prefix": None,
            "first_name": None,
            "middle_name": None,
            "last_name": None,
            "suffix": None,
        }

    prefix: str | None = None
    suffix: str | None = None

    if len(tokens) > 1 and tokens[0].lower().rstrip(".") in [p.rstrip(".") for p in KNOWN_PREFIXES]:
        prefix = tokens.pop(0)

    if len(tokens) > 1 and tokens[-1].lower().rstrip(".") in [
        s.rstrip(".") for s in KNOWN_SUFFIXES
    ]:
        suffix = tokens.pop(-1)

    first_name: str | None = None
    middle_name: str | None = None
    last_name: str | None = None

    if len(tokens) == 1:
        first_name = tokens[0]
    elif len(tokens) == 2:
        first_name = tokens[0]
        last_name = tokens[1]
    elif len(tokens) >= 3:
        first_name = tokens[0]
        middle_name = " ".join(tokens[1:-1])
        last_name = tokens[-1]

    return {
        "prefix": prefix,
        "first_name": first_name,
        "middle_name": middle_name,
        "last_name": last_name,
        "suffix": suffix,
    }


def normalize_email(email: str | None) -> str:
    if not email:
        return ""
    return normalize_whitespace(email.lower())


def normalize_phone(phone: str | None) -> str:
    """Strip formatting characters and extract complete digit string."""
    if not phone:
        return ""
    return re.sub(r"\D", "", phone)


def normalize_employer(employer: str | None) -> str:
    """Normalize employer and strip standard legal suffixes."""
    if not employer:
        return ""
    cleaned = normalize_whitespace(employer.lower())
    # Strip common punctuation like commas and periods
    cleaned = re.sub(r"[,.]", "", cleaned)
    tokens = cleaned.split(" ")

    while tokens and tokens[-1] in LEGAL_SUFFIXES:
        tokens.pop()

    return " ".join(tokens).strip()


def parse_location_parts(location: str | None) -> tuple[str | None, str | None]:
    """Parse city and normalized state code from location string."""
    if not location:
        return None, None
    cleaned = normalize_whitespace(location.lower())
    # Remove country if USA / US at the end
    cleaned = re.sub(r",?\s*(usa|us|united states)$", "", cleaned).strip()

    if "," in cleaned:
        parts = [p.strip() for p in cleaned.split(",") if p.strip()]
        city = parts[0] if parts else None
        raw_state = parts[1] if len(parts) > 1 else None
    else:
        parts = cleaned.split(" ")
        city = " ".join(parts[:-1]) if len(parts) > 1 else cleaned
        raw_state = parts[-1] if len(parts) > 1 else None

    state_code: str | None = None
    if raw_state:
        raw_state_clean = raw_state.strip()
        if raw_state_clean in US_STATES:
            state_code = raw_state_clean
        elif raw_state_clean in STATE_NAME_TO_CODE:
            state_code = STATE_NAME_TO_CODE[raw_state_clean]

    return city, state_code


def normalize_location(location: str | None) -> str:
    """Normalize location to 'city, state_code' or canonical form."""
    if not location:
        return ""
    city, state = parse_location_parts(location)
    if city and state:
        return f"{city}, {state}"
    if state:
        return state
    if city:
        return city
    return normalize_whitespace(location.lower())
