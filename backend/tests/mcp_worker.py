"""Test-only broker task: real production execution with a deterministic model.

Loaded explicitly by integration workers; excluded from the production image.
"""

from unittest.mock import patch

from app.celery_app import celery_app
from app.schemas.investigation import Operation
from app.tasks import investigate_evidence
from tests.test_investigations import FakeExtractor


@celery_app.task(name="tests.investigate_mcp_fixture")
def investigate_mcp_fixture(run_id: str) -> None:
    with patch(
        "app.services.investigation_graph.GeminiExtractor",
        lambda: FakeExtractor(Operation.HUMAN_INPUT),
    ):
        investigate_evidence.run(run_id)
