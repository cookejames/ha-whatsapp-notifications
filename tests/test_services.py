"""Tests for the whatsapp.send_message and whatsapp.list_groups services."""

from __future__ import annotations

import base64
from pathlib import Path
from typing import Any
from unittest.mock import patch

import aiohttp
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError, ServiceValidationError
from homeassistant.helpers import entity_registry as er
import pytest
from pytest_homeassistant_custom_component.common import MockConfigEntry
from pytest_homeassistant_custom_component.test_util.aiohttp import AiohttpClientMocker
import voluptuous as vol

from custom_components.whatsapp import async_setup
from custom_components.whatsapp.const import CONF_API_KEY, CONF_URL, DOMAIN

from .conftest import API_KEY, GATEWAY_URL, STATUS_OPEN

SEND_URL = f"{GATEWAY_URL}/send"
GROUPS_URL = f"{GATEWAY_URL}/groups"

RECIPIENTS = [
    {"id": "alice", "name": "Alice", "target": "+15555550123", "kind": "person"},
    {
        "id": "family",
        "name": "Family",
        "target": "120363000000000000@g.us",
        "kind": "group",
    },
]

OK_RESULT = {"to": "+15555550123", "jid": "15555550123@s.whatsapp.net", "id": "ID1"}
ERR_RESULT = {
    "to": "group:Nope",
    "error": {"code": "unknown_group", "message": "No such group"},
}


@pytest.fixture
async def entry(
    hass: HomeAssistant, aioclient_mock: AiohttpClientMocker
) -> MockConfigEntry:
    """Set up an entry with two recipients and registered notify entities."""
    aioclient_mock.get(f"{GATEWAY_URL}/status", json=STATUS_OPEN)
    config_entry = MockConfigEntry(
        domain=DOMAIN,
        title="WhatsApp Gateway",
        data={CONF_URL: GATEWAY_URL, CONF_API_KEY: API_KEY},
        options={"recipients": RECIPIENTS},
        unique_id=GATEWAY_URL,
    )
    config_entry.add_to_hass(hass)
    registry = er.async_get(hass)
    for rec in RECIPIENTS:
        registry.async_get_or_create(
            "notify",
            DOMAIN,
            f"{config_entry.entry_id}_{rec['id']}",
            config_entry=config_entry,
            suggested_object_id=f"whatsapp_{rec['id']}",
        )
    assert await hass.config_entries.async_setup(config_entry.entry_id)
    await hass.async_block_till_done()
    return config_entry


async def _call(
    hass: HomeAssistant, data: dict[str, Any], service: str = "send_message"
) -> Any:
    return await hass.services.async_call(
        DOMAIN, service, data, blocking=True, return_response=True
    )


def _posts(aioclient_mock: AiohttpClientMocker) -> list[Any]:
    return [c for c in aioclient_mock.mock_calls if c[0] == "POST"]


def _sent_body(aioclient_mock: AiohttpClientMocker) -> dict[str, Any]:
    posts = _posts(aioclient_mock)
    assert posts
    return posts[-1][2]


async def test_entity_targets_and_passthrough(
    hass: HomeAssistant, aioclient_mock: AiohttpClientMocker, entry: MockConfigEntry
) -> None:
    """notify entities map to recipient targets; other items pass through."""
    aioclient_mock.post(SEND_URL, json={"results": [OK_RESULT]})
    result = await _call(
        hass,
        {
            "target": ["notify.whatsapp_alice", "notify.whatsapp_family", "group:X"],
            "message": "Hello",
            "title": "Door",
        },
    )
    assert result == {"results": [OK_RESULT]}
    body = _sent_body(aioclient_mock)
    assert body["to"] == ["+15555550123", "120363000000000000@g.us", "group:X"]
    assert body["message"] == "*Door*\nHello"
    assert "image" not in body
    assert "document" not in body


async def test_single_string_target(
    hass: HomeAssistant, aioclient_mock: AiohttpClientMocker, entry: MockConfigEntry
) -> None:
    """A single string target is accepted."""
    aioclient_mock.post(SEND_URL, json={"results": [OK_RESULT]})
    await _call(hass, {"target": "+15555550123", "message": "Hi"})
    assert _sent_body(aioclient_mock)["to"] == ["+15555550123"]


async def test_foreign_entity_target(
    hass: HomeAssistant, aioclient_mock: AiohttpClientMocker, entry: MockConfigEntry
) -> None:
    """Entities from other integrations, or unknown ones, raise target_error."""
    er.async_get(hass).async_get_or_create(
        "notify", "other", "abc", suggested_object_id="other_thing"
    )
    for target in ("notify.other_thing", "notify.does_not_exist"):
        with pytest.raises(ServiceValidationError) as exc:
            await _call(hass, {"target": [target], "message": "Hi"})
        assert exc.value.translation_key == "target_error"
    assert not _posts(aioclient_mock)


async def test_entity_with_removed_recipient(
    hass: HomeAssistant, entry: MockConfigEntry
) -> None:
    """A registry entry whose recipient is no longer in the options is rejected."""
    er.async_get(hass).async_get_or_create(
        "notify",
        DOMAIN,
        f"{entry.entry_id}_gone",
        config_entry=entry,
        suggested_object_id="whatsapp_gone",
    )
    with pytest.raises(ServiceValidationError) as exc:
        await _call(hass, {"target": ["notify.whatsapp_gone"], "message": "Hi"})
    assert exc.value.translation_key == "target_error"


@pytest.mark.parametrize(
    ("data", "key"),
    [
        ({"target": ["+1555"]}, "message_required"),
        (
            {
                "target": ["+1555"],
                "message": "x",
                "image_url": "https://example.com/a.jpg",
                "document_path": "/x.pdf",
            },
            "multiple_media",
        ),
    ],
)
async def test_validation_errors(
    hass: HomeAssistant, entry: MockConfigEntry, data: dict[str, Any], key: str
) -> None:
    """Message and media rules from spec 4.6."""
    with pytest.raises(ServiceValidationError) as exc:
        await _call(hass, data)
    assert exc.value.translation_key == key


async def test_schema_errors(hass: HomeAssistant, entry: MockConfigEntry) -> None:
    """Target is required and non-empty."""
    with pytest.raises(vol.Invalid):
        await _call(hass, {"message": "x"})
    with pytest.raises(vol.Invalid):
        await _call(hass, {"target": [], "message": "x"})


async def test_config_entry_selection(
    hass: HomeAssistant, aioclient_mock: AiohttpClientMocker, entry: MockConfigEntry
) -> None:
    """config_entry_id is validated; it is required with several entries."""
    aioclient_mock.post(SEND_URL, json={"results": [OK_RESULT]})
    base = {"target": ["+1555"], "message": "Hi"}
    await _call(hass, {**base, "config_entry_id": entry.entry_id})

    other = MockConfigEntry(domain="other")
    other.add_to_hass(hass)
    for bad in ("nope", other.entry_id):
        with pytest.raises(ServiceValidationError) as exc:
            await _call(hass, {**base, "config_entry_id": bad})
        assert exc.value.translation_key == "config_entry_not_found"

    second = MockConfigEntry(
        domain=DOMAIN,
        data={CONF_URL: "http://other.test:8099", CONF_API_KEY: API_KEY},
        unique_id="http://other.test:8099",
    )
    second.add_to_hass(hass)
    with pytest.raises(ServiceValidationError) as exc:
        await _call(hass, base)
    assert exc.value.translation_key == "multiple_config_entries"


async def test_no_entries(hass: HomeAssistant) -> None:
    """With no config entries the call fails cleanly."""
    await async_setup(hass, {})
    with pytest.raises(ServiceValidationError) as exc:
        await _call(hass, {"target": ["+1555"], "message": "Hi"})
    assert exc.value.translation_key == "config_entry_not_found"


async def test_image_url(
    hass: HomeAssistant, aioclient_mock: AiohttpClientMocker, entry: MockConfigEntry
) -> None:
    """image_url is passed as a URL with its caption."""
    aioclient_mock.post(SEND_URL, json={"results": [OK_RESULT]})
    await _call(
        hass,
        {
            "target": ["+15555550123"],
            "image_url": "https://example.com/snap.jpg",
            "caption": "Front door",
        },
    )
    body = _sent_body(aioclient_mock)
    assert body["image"] == {
        "url": "https://example.com/snap.jpg",
        "caption": "Front door",
    }
    assert "message" not in body


async def test_image_path(
    hass: HomeAssistant,
    aioclient_mock: AiohttpClientMocker,
    entry: MockConfigEntry,
    tmp_path: Path,
) -> None:
    """A local image is base64 encoded."""
    hass.config.allowlist_external_dirs.add(str(tmp_path))
    image = tmp_path / "snap.jpg"
    image.write_bytes(b"\xff\xd8jpeg")
    aioclient_mock.post(SEND_URL, json={"results": [OK_RESULT]})
    await _call(hass, {"target": ["+1555"], "message": "Hi", "image_path": str(image)})
    body = _sent_body(aioclient_mock)
    assert base64.b64decode(body["image"]["base64"]) == b"\xff\xd8jpeg"
    assert body["message"] == "Hi"


async def test_document(
    hass: HomeAssistant,
    aioclient_mock: AiohttpClientMocker,
    entry: MockConfigEntry,
    tmp_path: Path,
) -> None:
    """A document gets its basename and a guessed mimetype."""
    hass.config.allowlist_external_dirs.add(str(tmp_path))
    pdf = tmp_path / "report.pdf"
    pdf.write_bytes(b"%PDF-1")
    unknown = tmp_path / "blob.zzzunknown"
    unknown.write_bytes(b"x")
    aioclient_mock.post(SEND_URL, json={"results": [OK_RESULT]})

    await _call(
        hass,
        {"target": ["+1555"], "document_path": str(pdf), "caption": "Daily report"},
    )
    doc = _sent_body(aioclient_mock)["document"]
    assert doc["filename"] == "report.pdf"
    assert doc["mimetype"] == "application/pdf"
    assert doc["caption"] == "Daily report"
    assert base64.b64decode(doc["base64"]) == b"%PDF-1"

    await _call(hass, {"target": ["+1555"], "document_path": str(unknown)})
    mimetype = _sent_body(aioclient_mock)["document"]["mimetype"]
    assert mimetype == "application/octet-stream"


async def test_path_not_allowed(
    hass: HomeAssistant,
    aioclient_mock: AiohttpClientMocker,
    entry: MockConfigEntry,
    tmp_path: Path,
) -> None:
    """Paths outside allowlist_external_dirs are refused."""
    secret = tmp_path / "secret.txt"
    secret.write_text("x")
    with pytest.raises(ServiceValidationError) as exc:
        await _call(hass, {"target": ["+1555"], "document_path": str(secret)})
    assert exc.value.translation_key == "path_not_allowed"
    assert not _posts(aioclient_mock)


async def test_file_too_large(
    hass: HomeAssistant, entry: MockConfigEntry, tmp_path: Path
) -> None:
    """Files over the limit are refused."""
    hass.config.allowlist_external_dirs.add(str(tmp_path))
    big = tmp_path / "big.bin"
    big.write_bytes(b"x" * 11)
    with (
        patch("custom_components.whatsapp.services.MAX_MEDIA_BYTES", 10),
        pytest.raises(ServiceValidationError) as exc,
    ):
        await _call(hass, {"target": ["+1555"], "document_path": str(big)})
    assert exc.value.translation_key == "file_too_large"


async def test_file_read_error(
    hass: HomeAssistant, entry: MockConfigEntry, tmp_path: Path
) -> None:
    """A missing file raises file_read_error."""
    hass.config.allowlist_external_dirs.add(str(tmp_path))
    with pytest.raises(HomeAssistantError) as exc:
        await _call(
            hass, {"target": ["+1555"], "image_path": str(tmp_path / "missing.jpg")}
        )
    assert exc.value.translation_key == "file_read_error"


async def test_partial_failure_returns_results(
    hass: HomeAssistant, aioclient_mock: AiohttpClientMocker, entry: MockConfigEntry
) -> None:
    """If at least one target succeeds the results are returned."""
    aioclient_mock.post(SEND_URL, json={"results": [OK_RESULT, ERR_RESULT]})
    result = await _call(
        hass, {"target": ["+15555550123", "group:Nope"], "message": "x"}
    )
    assert result == {"results": [OK_RESULT, ERR_RESULT]}


async def test_total_failure_raises(
    hass: HomeAssistant, aioclient_mock: AiohttpClientMocker, entry: MockConfigEntry
) -> None:
    """If every target failed the service raises."""
    aioclient_mock.post(SEND_URL, json={"results": [ERR_RESULT]})
    with pytest.raises(HomeAssistantError) as exc:
        await _call(hass, {"target": ["group:Nope"], "message": "x"})
    assert exc.value.translation_key == "all_targets_failed"
    assert "No such group" in exc.value.translation_placeholders["errors"]


def _err(status: int, code: str) -> dict[str, Any]:
    return {"status": status, "json": {"error": {"code": code, "message": "m"}}}


@pytest.mark.parametrize(
    ("kwargs", "key"),
    [
        (_err(503, "not_connected"), "not_connected"),
        (_err(400, "invalid_request"), "gateway_error"),
        (_err(401, "unauthorized"), "invalid_auth"),
        ({"exc": aiohttp.ClientError()}, "cannot_connect"),
    ],
)
async def test_gateway_errors(
    hass: HomeAssistant,
    aioclient_mock: AiohttpClientMocker,
    entry: MockConfigEntry,
    kwargs: dict[str, Any],
    key: str,
) -> None:
    """Client errors map to translated exceptions."""
    aioclient_mock.post(SEND_URL, **kwargs)
    with pytest.raises(HomeAssistantError) as exc:
        await _call(hass, {"target": ["+1555"], "message": "x"})
    assert exc.value.translation_key == key


async def test_list_groups(
    hass: HomeAssistant, aioclient_mock: AiohttpClientMocker, entry: MockConfigEntry
) -> None:
    """list_groups returns name, jid and participants."""
    group = {"jid": "120363000000000000@g.us", "name": "Family", "participants": 5}
    aioclient_mock.get(GROUPS_URL, json={"groups": [group], "refreshed": False})
    result = await _call(hass, {}, "list_groups")
    assert result == {"groups": [group]}


async def test_list_groups_error(
    hass: HomeAssistant, aioclient_mock: AiohttpClientMocker, entry: MockConfigEntry
) -> None:
    """Gateway failures surface as translated errors."""
    aioclient_mock.get(GROUPS_URL, exc=aiohttp.ClientError())
    with pytest.raises(HomeAssistantError) as exc:
        await _call(hass, {}, "list_groups")
    assert exc.value.translation_key == "cannot_connect"
