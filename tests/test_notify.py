"""Tests for the notify entities."""

from __future__ import annotations

import aiohttp
from homeassistant.components.notify import NotifyEntityFeature
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers import device_registry as dr
from homeassistant.helpers import entity_registry as er
import pytest
from pytest_homeassistant_custom_component.common import MockConfigEntry
from pytest_homeassistant_custom_component.test_util.aiohttp import AiohttpClientMocker

from .conftest import GATEWAY_URL, STATUS_OPEN

PERSON = {
    "id": "abc123",
    "name": "Alice",
    "target": "15555550123@s.whatsapp.net",
    "kind": "user",
}
GROUP = {
    "id": "def456",
    "name": "Family",
    "target": "120363000000000000@g.us",
    "kind": "group",
}
OK_RESULT = {"results": [{"to": "x", "jid": "x", "id": "3EB0C0FFEE000001"}]}


@pytest.fixture
async def entry(
    hass: HomeAssistant, aioclient_mock: AiohttpClientMocker
) -> MockConfigEntry:
    """A loaded entry with a person and a group."""
    aioclient_mock.get(f"{GATEWAY_URL}/status", json=STATUS_OPEN)
    config_entry = MockConfigEntry(
        domain="whatsapp",
        title="WhatsApp Gateway",
        data={"url": GATEWAY_URL, "api_key": "k"},
        options={"recipients": [PERSON, GROUP]},
        unique_id=GATEWAY_URL,
    )
    config_entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(config_entry.entry_id)
    await hass.async_block_till_done()
    return config_entry


def _entity_id(hass: HomeAssistant, entry: MockConfigEntry, rid: str) -> str:
    entity_id = er.async_get(hass).async_get_entity_id(
        "notify", "whatsapp", f"{entry.entry_id}_{rid}"
    )
    assert entity_id
    return entity_id


async def test_entities_created(hass: HomeAssistant, entry: MockConfigEntry) -> None:
    """A person and a group each get an entity on one shared device."""
    registry = er.async_get(hass)
    person = registry.async_get(_entity_id(hass, entry, "abc123"))
    group = registry.async_get(_entity_id(hass, entry, "def456"))
    assert person.original_name == "Alice"
    assert group.original_name == "Family"
    assert person.supported_features == NotifyEntityFeature.TITLE
    assert person.device_id == group.device_id
    device = dr.async_get(hass).async_get(person.device_id)
    assert device.name == "WhatsApp"


async def _send(hass: HomeAssistant, entity_id: str, **data: str) -> None:
    await hass.services.async_call(
        "notify",
        "send_message",
        {"entity_id": entity_id, "message": "Hello", **data},
        blocking=True,
    )


async def test_send_without_title(
    hass: HomeAssistant, entry: MockConfigEntry, aioclient_mock: AiohttpClientMocker
) -> None:
    """The message is sent as-is to the recipient target."""
    aioclient_mock.post(f"{GATEWAY_URL}/send", json=OK_RESULT)
    await _send(hass, _entity_id(hass, entry, "abc123"))
    body = aioclient_mock.mock_calls[-1][2]
    assert body == {"to": [PERSON["target"]], "message": "Hello"}


async def test_send_with_title(
    hass: HomeAssistant, entry: MockConfigEntry, aioclient_mock: AiohttpClientMocker
) -> None:
    """A title is formatted in bold above the message."""
    aioclient_mock.post(f"{GATEWAY_URL}/send", json=OK_RESULT)
    await _send(hass, _entity_id(hass, entry, "def456"), title="Door")
    body = aioclient_mock.mock_calls[-1][2]
    assert body == {"to": [GROUP["target"]], "message": "*Door*\nHello"}


async def test_error_not_connected(
    hass: HomeAssistant, entry: MockConfigEntry, aioclient_mock: AiohttpClientMocker
) -> None:
    """503 not_connected maps to the not_connected translation."""
    aioclient_mock.post(
        f"{GATEWAY_URL}/send",
        status=503,
        json={"error": {"code": "not_connected", "message": "down"}},
    )
    with pytest.raises(HomeAssistantError) as exc:
        await _send(hass, _entity_id(hass, entry, "abc123"))
    assert exc.value.translation_key == "not_connected"


async def test_error_other_gateway_error(
    hass: HomeAssistant, entry: MockConfigEntry, aioclient_mock: AiohttpClientMocker
) -> None:
    """Other gateway errors map to target_error."""
    aioclient_mock.post(
        f"{GATEWAY_URL}/send",
        status=400,
        json={"error": {"code": "invalid_request", "message": "bad"}},
    )
    with pytest.raises(HomeAssistantError) as exc:
        await _send(hass, _entity_id(hass, entry, "abc123"))
    assert exc.value.translation_key == "target_error"
    assert exc.value.translation_placeholders == {"target": "Alice", "error": "bad"}


async def test_error_per_target_result(
    hass: HomeAssistant, entry: MockConfigEntry, aioclient_mock: AiohttpClientMocker
) -> None:
    """A failed result entry in a 200 response raises target_error."""
    aioclient_mock.post(
        f"{GATEWAY_URL}/send",
        json={
            "results": [
                {
                    "to": GROUP["target"],
                    "error": {"code": "not_a_member", "message": "Not a member"},
                }
            ]
        },
    )
    with pytest.raises(HomeAssistantError) as exc:
        await _send(hass, _entity_id(hass, entry, "def456"))
    assert exc.value.translation_key == "target_error"
    assert exc.value.translation_placeholders["error"] == "Not a member"


async def test_error_auth_and_connection(
    hass: HomeAssistant, entry: MockConfigEntry, aioclient_mock: AiohttpClientMocker
) -> None:
    """Auth and connection failures use their translation keys."""
    entity_id = _entity_id(hass, entry, "abc123")
    aioclient_mock.post(
        f"{GATEWAY_URL}/send",
        status=401,
        json={"error": {"code": "unauthorized", "message": "no"}},
    )
    with pytest.raises(HomeAssistantError) as exc:
        await _send(hass, entity_id)
    assert exc.value.translation_key == "invalid_auth"

    aioclient_mock.clear_requests()
    aioclient_mock.post(f"{GATEWAY_URL}/send", exc=aiohttp.ClientError())
    with pytest.raises(HomeAssistantError) as exc:
        await _send(hass, entity_id)
    assert exc.value.translation_key == "cannot_connect"


async def test_removed_recipient_entity_removed(
    hass: HomeAssistant, entry: MockConfigEntry
) -> None:
    """Dropping a recipient from options removes its registry entry."""
    registry = er.async_get(hass)
    gone = _entity_id(hass, entry, "abc123")
    kept = _entity_id(hass, entry, "def456")

    hass.config_entries.async_update_entry(entry, options={"recipients": [GROUP]})
    await hass.async_block_till_done()

    assert registry.async_get(gone) is None
    assert registry.async_get(kept) is not None
