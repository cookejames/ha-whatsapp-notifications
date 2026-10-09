"""Tests for the recipients options flow."""

from __future__ import annotations

import aiohttp
from homeassistant.config_entries import ConfigEntryState
from homeassistant.core import HomeAssistant
from homeassistant.data_entry_flow import FlowResultType
import pytest
from pytest_homeassistant_custom_component.common import MockConfigEntry
from pytest_homeassistant_custom_component.test_util.aiohttp import AiohttpClientMocker

from custom_components.whatsapp.options_flow import normalize_phone

from .conftest import GATEWAY_URL, STATUS_OPEN

GROUP_JID = "120363000000000000@g.us"
GROUPS = {"groups": [{"jid": GROUP_JID, "name": "Family", "participants": 4}]}
EXISTING = {
    "id": "abc123",
    "name": "Alice",
    "target": "15555550123@s.whatsapp.net",
    "kind": "user",
}


async def _setup(
    hass: HomeAssistant,
    aioclient_mock: AiohttpClientMocker,
    entry: MockConfigEntry,
) -> None:
    aioclient_mock.get(f"{GATEWAY_URL}/status", json=STATUS_OPEN)
    entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("+1 (555) 555-0123", "15555550123"),
        ("555.555.0123", "5555550123"),
        ("123456", None),
        ("1234567890123456", None),
        ("abc1234567", None),
    ],
)
def test_normalize_phone(raw: str, expected: str | None) -> None:
    """Phone numbers follow spec 3.7 step 4."""
    assert normalize_phone(raw) == expected


async def test_menu_without_recipients(
    hass: HomeAssistant,
    aioclient_mock: AiohttpClientMocker,
    mock_config_entry: MockConfigEntry,
) -> None:
    """Remove is only offered when there is something to remove."""
    await _setup(hass, aioclient_mock, mock_config_entry)
    result = await hass.config_entries.options.async_init(mock_config_entry.entry_id)
    assert result["type"] is FlowResultType.MENU
    assert result["menu_options"] == ["add_person", "add_group"]


async def test_add_person(
    hass: HomeAssistant,
    aioclient_mock: AiohttpClientMocker,
    mock_config_entry: MockConfigEntry,
) -> None:
    """A person is stored with a normalised JID."""
    await _setup(hass, aioclient_mock, mock_config_entry)
    result = await hass.config_entries.options.async_init(mock_config_entry.entry_id)
    result = await hass.config_entries.options.async_configure(
        result["flow_id"], {"next_step_id": "add_person"}
    )
    assert result["type"] is FlowResultType.FORM

    result = await hass.config_entries.options.async_configure(
        result["flow_id"], {"name": "Alice", "phone": "12"}
    )
    assert result["type"] is FlowResultType.FORM
    assert result["errors"] == {"phone": "invalid_phone"}

    result = await hass.config_entries.options.async_configure(
        result["flow_id"], {"name": "Alice", "phone": "+1 555 555 0123"}
    )
    assert result["type"] is FlowResultType.CREATE_ENTRY
    await hass.async_block_till_done()
    [recipient] = mock_config_entry.options["recipients"]
    assert recipient["name"] == "Alice"
    assert recipient["target"] == "15555550123@s.whatsapp.net"
    assert recipient["kind"] == "user"
    assert len(recipient["id"]) == 32


async def test_add_group(
    hass: HomeAssistant,
    aioclient_mock: AiohttpClientMocker,
    mock_config_entry: MockConfigEntry,
) -> None:
    """A group is picked by JID; the name defaults to the group name."""
    aioclient_mock.get(f"{GATEWAY_URL}/groups", json=GROUPS)
    await _setup(hass, aioclient_mock, mock_config_entry)
    result = await hass.config_entries.options.async_init(mock_config_entry.entry_id)
    result = await hass.config_entries.options.async_configure(
        result["flow_id"], {"next_step_id": "add_group"}
    )
    assert result["type"] is FlowResultType.FORM
    assert result["step_id"] == "add_group"

    result = await hass.config_entries.options.async_configure(
        result["flow_id"], {"group": GROUP_JID}
    )
    assert result["type"] is FlowResultType.CREATE_ENTRY
    await hass.async_block_till_done()
    [recipient] = mock_config_entry.options["recipients"]
    assert recipient["name"] == "Family"
    assert recipient["target"] == GROUP_JID
    assert recipient["kind"] == "group"


async def test_add_group_custom_name(
    hass: HomeAssistant,
    aioclient_mock: AiohttpClientMocker,
    mock_config_entry: MockConfigEntry,
) -> None:
    """An edited name is kept."""
    aioclient_mock.get(f"{GATEWAY_URL}/groups", json=GROUPS)
    await _setup(hass, aioclient_mock, mock_config_entry)
    result = await hass.config_entries.options.async_init(mock_config_entry.entry_id)
    result = await hass.config_entries.options.async_configure(
        result["flow_id"], {"next_step_id": "add_group"}
    )
    result = await hass.config_entries.options.async_configure(
        result["flow_id"], {"group": GROUP_JID, "name": "Household"}
    )
    assert result["type"] is FlowResultType.CREATE_ENTRY
    assert result["data"]["recipients"][0]["name"] == "Household"


async def test_add_group_none(
    hass: HomeAssistant,
    aioclient_mock: AiohttpClientMocker,
    mock_config_entry: MockConfigEntry,
) -> None:
    """An empty group list aborts."""
    aioclient_mock.get(f"{GATEWAY_URL}/groups", json={"groups": []})
    await _setup(hass, aioclient_mock, mock_config_entry)
    result = await hass.config_entries.options.async_init(mock_config_entry.entry_id)
    result = await hass.config_entries.options.async_configure(
        result["flow_id"], {"next_step_id": "add_group"}
    )
    assert result["type"] is FlowResultType.ABORT
    assert result["reason"] == "no_groups"


@pytest.mark.parametrize(
    ("kwargs", "error"),
    [
        (
            {
                "status": 401,
                "json": {"error": {"code": "unauthorized", "message": "x"}},
            },
            "invalid_auth",
        ),
        ({"exc": aiohttp.ClientError()}, "cannot_connect"),
        (
            {"status": 500, "json": {"error": {"code": "boom", "message": "x"}}},
            "unknown",
        ),
    ],
)
async def test_add_group_api_errors(
    hass: HomeAssistant,
    aioclient_mock: AiohttpClientMocker,
    mock_config_entry: MockConfigEntry,
    kwargs: dict,
    error: str,
) -> None:
    """Gateway failures are shown as form errors."""
    await _setup(hass, aioclient_mock, mock_config_entry)
    aioclient_mock.clear_requests()
    aioclient_mock.get(f"{GATEWAY_URL}/groups", **kwargs)
    result = await hass.config_entries.options.async_init(mock_config_entry.entry_id)
    result = await hass.config_entries.options.async_configure(
        result["flow_id"], {"next_step_id": "add_group"}
    )
    assert result["type"] is FlowResultType.FORM
    assert result["errors"] == {"base": error}


async def test_remove_recipient(
    hass: HomeAssistant,
    aioclient_mock: AiohttpClientMocker,
) -> None:
    """Removing a recipient updates the options."""
    other = {**EXISTING, "id": "def456", "name": "Bob"}
    entry = MockConfigEntry(
        domain="whatsapp",
        title="WhatsApp Gateway",
        data={"url": GATEWAY_URL, "api_key": "k"},
        options={"recipients": [EXISTING, other]},
        unique_id=GATEWAY_URL,
    )
    await _setup(hass, aioclient_mock, entry)
    result = await hass.config_entries.options.async_init(entry.entry_id)
    assert "remove" in result["menu_options"]
    result = await hass.config_entries.options.async_configure(
        result["flow_id"], {"next_step_id": "remove"}
    )
    assert result["step_id"] == "remove"
    result = await hass.config_entries.options.async_configure(
        result["flow_id"], {"recipients": ["abc123"]}
    )
    assert result["type"] is FlowResultType.CREATE_ENTRY
    await hass.async_block_till_done()
    assert entry.state is ConfigEntryState.LOADED
    assert [r["id"] for r in entry.options["recipients"]] == ["def456"]
