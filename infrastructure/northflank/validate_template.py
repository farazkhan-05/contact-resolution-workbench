"""Validate against Northflank's published native schema without account access.

Run with: uv run --with jsonschema==4.26.0 python validate_template.py
"""

import argparse
import hashlib
import json
import re
import urllib.request
from pathlib import Path

from jsonschema import Draft202012Validator

SCHEMA_URL = "https://api.northflank.com/v1/schemas/template"
TEMPLATE = Path(__file__).with_name("staging.template.json")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--schema", type=Path, help="Previously downloaded official schema")
    args = parser.parse_args()
    raw = (
        args.schema.read_bytes()
        if args.schema
        else urllib.request.urlopen(SCHEMA_URL, timeout=30).read()
    )
    schema = json.loads(raw)
    template = json.loads(TEMPLATE.read_text())
    # $schema selects the editor schema; the official payload schema excludes it.
    assert template.pop("$schema") == SCHEMA_URL
    arguments = template["arguments"]
    assert arguments["PROJECT_ID"] == "crw-staging", "Image selectors use crw-staging"
    for key in ("DATABASE_URL", "FIREBASE_SERVICE_ACCOUNT_JSON", "GEMINI_API_KEY"):
        assert arguments[key] == "", f"Secret argument {key} must remain empty"
    assert "argumentOverrides" not in template
    Draft202012Validator(schema).validate(template)
    for match in re.finditer(r"\$\{args\.([A-Z_]+)\}", json.dumps(template)):
        assert match[1] in arguments, f"Missing argument {match[1]}"
    steps = template["spec"]["spec"]["steps"]
    # Check references are available before use in this sequential workflow.
    refs: set[str] = set()
    for node in steps:
        for match in re.finditer(r"\$\{refs\.([a-zA-Z]+)\.", json.dumps(node)):
            assert match[1] in refs, f"Forward/unknown reference {match[1]}"
        if "ref" in node:
            assert node["ref"] not in refs
            refs.add(node["ref"])
    resources = [
        n
        for n in steps
        if n["kind"] in {"CombinedService", "DeploymentService", "Job", "Addon", "SecretGroup"}
        and n.get("updateMode") != "patch"
    ]
    for node in resources:
        print(f"{node['kind']}: {node['spec']['name']}")
    redis = next(n["spec"] for n in resources if n["kind"] == "Addon")
    assert redis["type"] == "redis" and not redis["externalAccessEnabled"]
    assert not redis["typeSpecificSettings"]["redisSentinelEnabled"]
    print(f"Official native schema PASS; SHA256 {hashlib.sha256(raw).hexdigest()}")
    print("No resources applied. Account plans and authenticated server dry-run remain required.")


if __name__ == "__main__":
    main()
