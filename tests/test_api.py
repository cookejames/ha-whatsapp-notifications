"""Tests for the gateway API client."""

from __future__ import annotations

import aiohttp
from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession
import pytest
from pytest_homeassistant_custom_component.test_util.aiohttp import AiohttpClientMocker

from custom_components.whatsapp.api import (
    GatewayAuthError,
    GatewayConnectionError,
    GatewayError,
    WhatsAppGatewayClient,
)

from .conftest import API_KEY, GATEWAY_URL, STATUS_OPEN


@pytest.fixture
async def client(
    aioclient_mock: AiohttpClientMocker, hass: HomeAssistant
) -> WhatsAppGatewayClient:
    """Return a client using the mocked session."""
    return WhatsAppGatewayClient(
        async_get_clientsession(hass), GATEWAY_URL + "/", API_KEY
    )


async def test_status(
    client: WhatsAppGatewayClient, aioclient_mock: AiohttpClientMocker
) -> None:
    """status() returns the parsed body and sends the bearer token."""
    aioclient_mock.get(f"{GATEWAY_URL}/status", json=STATUS_OPEN)
    assert await client.status() == STATUS_OPEN
    headers = aioclient_mock.mock_calls[0][3]
    assert headers["Authorization"] == f"Bearer {API_KEY}"


async def test_groups(
    client: WhatsAppGatewayClient, aioclient_mock: AiohttpClientMocker
) -> None:
    """groups() returns the list and supports refresh."""
    groups = [{"jid": "120363000000000000@g.us", "name": "Family", "participants": 5}]
    aioclient_mock.get(
        f"{GATEWAY_URL}/groups", json={"groups": groups, "refreshed": False}
    )
    assert await client.groups() == groups
    assert aioclient_mock.mock_calls[0][1].query == {}

    await client.groups(refresh=True)
    assert aioclient_mock.mock_calls[1][1].query == {"refresh": "true"}


async def test_send(
    client: WhatsAppGatewayClient, aioclient_mock: AiohttpClientMocker
) -> None:
    """send() posts the body and returns results."""
    results = [{"to": "+15555550123", "jid": "15555550123@s.whatsapp.net", "id": "1"}]
    aioclient_mock.post(f"{GATEWAY_URL}/send", json={"results": results})
    assert await client.send(["+15555550123"], message="Hi") == results
    assert aioclient_mock.mock_calls[0][2] == {"to": ["+15555550123"], "message": "Hi"}


async def test_send_media_body(
    client: WhatsAppGatewayClient, aioclient_mock: AiohttpClientMocker
) -> None:
    """Image and document payloads are included in the body."""
    aioclient_mock.post(f"{GATEWAY_URL}/send", json={"results": []})
    image = {"url": "http://example.test/a.png", "caption": "c"}
    document = {"base64": "AAAA", "filename": "r.pdf"}
    await client.send("+15555550123", image=image)
    await client.send("+15555550123", document=document)
    assert aioclient_mock.mock_calls[0][2] == {"to": "+15555550123", "image": image}
    assert aioclient_mock.mock_calls[1][2] == {
        "to": "+15555550123",
        "document": document,
    }


@pytest.mark.parametrize("status", [401, 403])
async def test_auth_errors(
    client: WhatsAppGatewayClient,
    aioclient_mock: AiohttpClientMocker,
    status: int,
) -> None:
    """401 and 403 map to GatewayAuthError."""
    aioclient_mock.get(
        f"{GATEWAY_URL}/status",
        status=status,
        json={"error": {"code": "unauthorized", "message": "nope"}},
    )
    with pytest.raises(GatewayAuthError):
        await client.status()


async def test_error_envelope(
    client: WhatsAppGatewayClient, aioclient_mock: AiohttpClientMocker
) -> None:
    """Error envelopes become GatewayError(code, message)."""
    aioclient_mock.post(
        f"{GATEWAY_URL}/send",
        status=503,
        json={"error": {"code": "not_connected", "message": "WhatsApp is down"}},
    )
    with pytest.raises(GatewayError) as err:
        await client.send(["+15555550123"], message="Hi")
    assert err.value.code == "not_connected"
    assert err.value.message == "WhatsApp is down"


async def test_error_without_envelope(
    client: WhatsAppGatewayClient, aioclient_mock: AiohttpClientMocker
) -> None:
    """Non-JSON error bodies become an 'unknown' GatewayError."""
    aioclient_mock.get(f"{GATEWAY_URL}/status", status=500, text="boom")
    with pytest.raises(GatewayError) as err:
        await client.status()
    assert err.value.code == "unknown"


async def test_unexpected_success_body(
    client: WhatsAppGatewayClient, aioclient_mock: AiohttpClientMocker
) -> None:
    """A 200 with a non-object body is rejected."""
    aioclient_mock.get(f"{GATEWAY_URL}/status", text="not json")
    with pytest.raises(GatewayError) as err:
        await client.status()
    assert err.value.code == "invalid_response"


@pytest.mark.parametrize("exc", [TimeoutError(), aiohttp.ClientError("down")])
async def test_connection_errors(
    client: WhatsAppGatewayClient,
    aioclient_mock: AiohttpClientMocker,
    exc: Exception,
) -> None:
    """Timeouts and connection errors map to GatewayConnectionError."""
    aioclient_mock.get(f"{GATEWAY_URL}/status", exc=exc)
    with pytest.raises(GatewayConnectionError):
        await client.status()
