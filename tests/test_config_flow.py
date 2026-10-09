"""Tests for the config flow."""

from __future__ import annotations

from unittest.mock import patch

import aiohttp
from homeassistant import config_entries
from homeassistant.core import HomeAssistant
from homeassistant.data_entry_flow import FlowResultType
import pytest
from pytest_homeassistant_custom_component.common import MockConfigEntry
from pytest_homeassistant_custom_component.test_util.aiohttp import AiohttpClientMocker

from custom_components.whatsapp.const import CONF_API_KEY, CONF_URL, DOMAIN

from .conftest import API_KEY, GATEWAY_URL, STATUS_OPEN

pytestmark = pytest.mark.usefixtures("mock_setup_entry")

USER_INPUT = {CONF_URL: GATEWAY_URL, CONF_API_KEY: API_KEY}


async def _start_user(hass: HomeAssistant) -> dict:
    result = await hass.config_entries.flow.async_init(
        DOMAIN, context={"source": config_entries.SOURCE_USER}
    )
    assert result["type"] is FlowResultType.FORM
    assert result["step_id"] == "user"
    return result


async def test_user_flow_success(
    hass: HomeAssistant, aioclient_mock: AiohttpClientMocker
) -> None:
    """A valid gateway creates an entry."""
    aioclient_mock.get(f"{GATEWAY_URL}/status", json=STATUS_OPEN)
    result = await _start_user(hass)
    result = await hass.config_entries.flow.async_configure(
        result["flow_id"], {CONF_URL: GATEWAY_URL + "/", CONF_API_KEY: API_KEY}
    )
    assert result["type"] is FlowResultType.CREATE_ENTRY
    assert result["title"] == "WhatsApp Gateway"
    assert result["data"] == USER_INPUT
    assert result["result"].unique_id == GATEWAY_URL


@pytest.mark.parametrize(
    ("kwargs", "error"),
    [
        ({"exc": aiohttp.ClientError()}, "cannot_connect"),
        ({"exc": TimeoutError()}, "cannot_connect"),
        ({"status": 401, "json": {"error": {"code": "unauthorized"}}}, "invalid_auth"),
        ({"exc": RuntimeError("boom")}, "unknown"),
    ],
)
async def test_user_flow_errors_then_recover(
    hass: HomeAssistant,
    aioclient_mock: AiohttpClientMocker,
    kwargs: dict,
    error: str,
) -> None:
    """Errors are shown on the form and the user can retry successfully."""
    aioclient_mock.get(f"{GATEWAY_URL}/status", **kwargs)
    result = await _start_user(hass)
    result = await hass.config_entries.flow.async_configure(
        result["flow_id"], USER_INPUT
    )
    assert result["type"] is FlowResultType.FORM
    assert result["errors"] == {"base": error}

    aioclient_mock.clear_requests()
    aioclient_mock.get(f"{GATEWAY_URL}/status", json=STATUS_OPEN)
    result = await hass.config_entries.flow.async_configure(
        result["flow_id"], USER_INPUT
    )
    assert result["type"] is FlowResultType.CREATE_ENTRY


async def test_user_flow_already_configured(
    hass: HomeAssistant, mock_config_entry: MockConfigEntry
) -> None:
    """The same URL cannot be configured twice."""
    mock_config_entry.add_to_hass(hass)
    result = await _start_user(hass)
    result = await hass.config_entries.flow.async_configure(
        result["flow_id"], {CONF_URL: GATEWAY_URL + "/", CONF_API_KEY: API_KEY}
    )
    assert result["type"] is FlowResultType.ABORT
    assert result["reason"] == "already_configured"


async def test_reauth_flow(
    hass: HomeAssistant,
    aioclient_mock: AiohttpClientMocker,
    mock_config_entry: MockConfigEntry,
) -> None:
    """Reauth updates the API key, retrying after an auth error."""
    mock_config_entry.add_to_hass(hass)
    result = await mock_config_entry.start_reauth_flow(hass)
    assert result["type"] is FlowResultType.FORM
    assert result["step_id"] == "reauth_confirm"

    aioclient_mock.get(f"{GATEWAY_URL}/status", status=401, json={})
    result = await hass.config_entries.flow.async_configure(
        result["flow_id"], {CONF_API_KEY: "wrong-key-0123456789"}
    )
    assert result["errors"] == {"base": "invalid_auth"}

    aioclient_mock.clear_requests()
    aioclient_mock.get(f"{GATEWAY_URL}/status", json=STATUS_OPEN)
    with patch.object(hass.config_entries, "async_schedule_reload"):
        result = await hass.config_entries.flow.async_configure(
            result["flow_id"], {CONF_API_KEY: "new-key-0123456789abcdef"}
        )
    assert result["type"] is FlowResultType.ABORT
    assert result["reason"] == "reauth_successful"
    assert mock_config_entry.data[CONF_API_KEY] == "new-key-0123456789abcdef"
    assert mock_config_entry.data[CONF_URL] == GATEWAY_URL


async def test_options_flow_stub(
    hass: HomeAssistant,
    aioclient_mock: AiohttpClientMocker,
    mock_config_entry: MockConfigEntry,
) -> None:
    """The options flow stub shows a form and saves existing options."""
    mock_config_entry.add_to_hass(hass)
    result = await hass.config_entries.options.async_init(mock_config_entry.entry_id)
    assert result["type"] is FlowResultType.FORM
    result = await hass.config_entries.options.async_configure(result["flow_id"], {})
    assert result["type"] is FlowResultType.CREATE_ENTRY
