"""Shared fixtures."""

from __future__ import annotations

from collections.abc import Generator
from unittest.mock import patch

import pytest
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.whatsapp.const import CONF_API_KEY, CONF_URL, DOMAIN

GATEWAY_URL = "http://gateway.test:8099"
API_KEY = "test-api-key-0123456789abcdef"

STATUS_OPEN = {
    "state": "open",
    "connected": True,
    "me": {"jid": "15555550123@s.whatsapp.net", "name": "Gateway"},
    "pairing": None,
    "last_error": None,
    "since": "2026-01-01T12:00:00.000Z",
    "version": "0.1.0",
}


@pytest.fixture(autouse=True)
def auto_enable_custom_integrations(enable_custom_integrations: None) -> None:
    """Enable loading of custom integrations in all tests."""


@pytest.fixture
def gateway_url() -> str:
    """Return the placeholder gateway URL."""
    return GATEWAY_URL


@pytest.fixture
def api_key() -> str:
    """Return the placeholder API key."""
    return API_KEY


@pytest.fixture
def mock_config_entry() -> MockConfigEntry:
    """Return a config entry for the gateway."""
    return MockConfigEntry(
        domain=DOMAIN,
        title="WhatsApp Gateway",
        data={CONF_URL: GATEWAY_URL, CONF_API_KEY: API_KEY},
        unique_id=GATEWAY_URL,
    )


@pytest.fixture
def mock_setup_entry() -> Generator[None]:
    """Avoid setting up the entry when finishing a config flow."""
    with patch("custom_components.whatsapp.async_setup_entry", return_value=True):
        yield
