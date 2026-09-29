from app.schemas.resolution import CaseQuery
from app.services.providers import (
    MockCrmArchiveProvider,
    MockDirectoryB2BProvider,
    MockPartnerRegistryProvider,
)


def test_mock_crm_provider() -> None:
    provider = MockCrmArchiveProvider()
    query = CaseQuery(name="Claire Reynolds")
    results = provider.search(query)
    assert len(results) >= 1
    assert results[0].provider_source == "CRM_ARCHIVE"
    assert results[0].provenance_summary != ""


def test_mock_b2b_provider() -> None:
    provider = MockDirectoryB2BProvider()
    query = CaseQuery(name="David Mitchell")
    results = provider.search(query)
    assert len(results) >= 1
    assert results[0].provider_source == "SYNTHETIC_DIR_B2B"
    assert results[0].provenance_summary != ""


def test_mock_partner_provider() -> None:
    provider = MockPartnerRegistryProvider()
    query = CaseQuery(name="Elena Rostova")
    results = provider.search(query)
    assert len(results) >= 1
    assert results[0].provider_source == "PARTNER_REGISTRY_MOCK"
    assert results[0].provenance_summary != ""
