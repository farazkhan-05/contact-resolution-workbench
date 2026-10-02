"""Fail-closed smoke guards must run before any network or application imports."""

import importlib.util
import sys
from pathlib import Path

import pytest


def load_smoke():
    path = Path(__file__).with_name("staging_smoke.py")
    spec = importlib.util.spec_from_file_location("staging_smoke", path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_requires_staging_confirmation(monkeypatch):
    monkeypatch.setattr(sys, "argv", ["staging_smoke.py"])
    with pytest.raises(RuntimeError, match="confirm-staging"):
        load_smoke().main()


def test_rejects_render_target_without_network(monkeypatch):
    monkeypatch.setattr(sys, "argv", ["staging_smoke.py", "--confirm-staging"])
    monkeypatch.setenv("STAGING_API_URL", "https://stable-demo.onrender.com")
    monkeypatch.setenv("EXPECTED_STAGING_API_HOST", "stable-demo.onrender.com")
    with pytest.raises(RuntimeError, match="Northflank staging HTTPS"):
        load_smoke().main()


def test_rejects_shared_production_branch_without_network(monkeypatch):
    monkeypatch.setattr(sys, "argv", ["staging_smoke.py", "--confirm-staging"])
    monkeypatch.setenv("STAGING_API_URL", "https://synthetic.code.run")
    monkeypatch.setenv("EXPECTED_STAGING_API_HOST", "synthetic.code.run")
    monkeypatch.setenv("STAGING_DATABASE_URL", "postgresql://synthetic@synthetic.neon.tech/demo")
    monkeypatch.setenv("EXPECTED_STAGING_NEON_HOST", "synthetic.neon.tech")
    monkeypatch.setenv("STAGING_NEON_BRANCH_ID", "br-synthetic")
    monkeypatch.setenv("PRODUCTION_NEON_BRANCH_ID", "br-synthetic")
    with pytest.raises(RuntimeError, match="separate Neon branch"):
        load_smoke().main()


def test_rejects_public_redis_without_network(monkeypatch):
    monkeypatch.setattr(sys, "argv", ["staging_smoke.py", "--confirm-staging"])
    monkeypatch.setenv("STAGING_API_URL", "https://synthetic.code.run")
    monkeypatch.setenv("EXPECTED_STAGING_API_HOST", "synthetic.code.run")
    monkeypatch.setenv("STAGING_DATABASE_URL", "postgresql://synthetic@synthetic.neon.tech/demo")
    monkeypatch.setenv("EXPECTED_STAGING_NEON_HOST", "synthetic.neon.tech")
    monkeypatch.setenv("STAGING_NEON_BRANCH_ID", "br-synthetic-staging")
    monkeypatch.setenv("PRODUCTION_NEON_BRANCH_ID", "br-synthetic-production")
    monkeypatch.setenv("STAGING_BROKER_URL", "redis://public.example.com:6379/0")
    with pytest.raises(RuntimeError, match="private Redis DNS"):
        load_smoke().main()


def test_accepts_private_northflank_redis_dns(monkeypatch):
    smoke = load_smoke()
    monkeypatch.setattr(
        smoke.socket,
        "getaddrinfo",
        lambda *_args, **_kwargs: [(None, None, None, None, ("10.0.0.8", 6379))],
    )
    assert smoke.is_private_redis_host("redis-addon.project.internal")


def test_rejects_publicly_resolved_redis_dns(monkeypatch):
    smoke = load_smoke()
    monkeypatch.setattr(
        smoke.socket,
        "getaddrinfo",
        lambda *_args, **_kwargs: [(None, None, None, None, ("8.8.8.8", 6379))],
    )
    assert not smoke.is_private_redis_host("redis.example.com")
