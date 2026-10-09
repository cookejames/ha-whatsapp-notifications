"""HTTP client for the WhatsApp Gateway add-on (contract: docs/api.md)."""

from __future__ import annotations

import asyncio
from typing import Any, TypedDict

import aiohttp

from .const import TIMEOUT_DEFAULT, TIMEOUT_SEND


class GatewayApiError(Exception):
    """Base class for all gateway client errors."""


class GatewayAuthError(GatewayApiError):
    """The gateway rejected the API key or the source address (401/403)."""


class GatewayConnectionError(GatewayApiError):
    """The gateway could not be reached or timed out."""


class GatewayError(GatewayApiError):
    """A structured error returned by the gateway."""

    def __init__(self, code: str, message: str) -> None:
        """Initialise with the API error code and human readable message."""
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message


class GatewayStatus(TypedDict, total=False):
    """Response of GET /status."""

    state: str
    connected: bool
    me: dict[str, Any] | None
    pairing: dict[str, Any] | None
    last_error: str | None
    since: str
    version: str


class GatewayGroup(TypedDict):
    """A group entry from GET /groups."""

    jid: str
    name: str
    participants: int


class WhatsAppGatewayClient:
    """Client for the gateway HTTP API."""

    def __init__(
        self, session: aiohttp.ClientSession, base_url: str, api_key: str
    ) -> None:
        """Initialise the client."""
        self._session = session
        self._base_url = base_url.rstrip("/")
        self._api_key = api_key

    async def status(self) -> GatewayStatus:
        """Return the gateway status."""
        return await self._request("GET", "/status", timeout=TIMEOUT_DEFAULT)

    async def groups(self, refresh: bool = False) -> list[GatewayGroup]:
        """Return the groups the linked account is a member of."""
        params = {"refresh": "true"} if refresh else None
        data = await self._request(
            "GET", "/groups", params=params, timeout=TIMEOUT_DEFAULT
        )
        return data["groups"]

    async def send(
        self,
        to: list[str] | str,
        message: str | None = None,
        image: dict[str, Any] | None = None,
        document: dict[str, Any] | None = None,
    ) -> list[dict[str, Any]]:
        """Send a message and return the per-target results."""
        body: dict[str, Any] = {"to": to}
        if message is not None:
            body["message"] = message
        if image is not None:
            body["image"] = image
        if document is not None:
            body["document"] = document
        data = await self._request("POST", "/send", json=body, timeout=TIMEOUT_SEND)
        return data["results"]

    async def _request(
        self,
        method: str,
        path: str,
        *,
        timeout: float,  # noqa: ASYNC109
        params: dict[str, str] | None = None,
        json: dict[str, Any] | None = None,
    ) -> Any:
        """Perform a request and map failures to the client exceptions."""
        try:
            async with asyncio.timeout(timeout):
                async with self._session.request(
                    method,
                    f"{self._base_url}{path}",
                    params=params,
                    json=json,
                    headers={"Authorization": f"Bearer {self._api_key}"},
                ) as resp:
                    payload = await self._read_json(resp)
                    status = resp.status
        except TimeoutError as err:
            raise GatewayConnectionError("Request to gateway timed out") from err
        except aiohttp.ClientError as err:
            raise GatewayConnectionError(f"Cannot reach gateway: {err}") from err

        if status in (401, 403):
            raise GatewayAuthError(_parse_error(payload, status)[1])
        if status >= 400:
            code, message = _parse_error(payload, status)
            raise GatewayError(code, message)
        if not isinstance(payload, dict):
            raise GatewayError("invalid_response", "Unexpected response from gateway")
        return payload

    @staticmethod
    async def _read_json(resp: aiohttp.ClientResponse) -> Any:
        """Decode a JSON body, returning None when it is not valid JSON."""
        try:
            return await resp.json(content_type=None)
        except ValueError:
            return None


def _parse_error(payload: Any, status: int) -> tuple[str, str]:
    """Parse the error envelope into (code, message)."""
    if isinstance(payload, dict) and isinstance(payload.get("error"), dict):
        err = payload["error"]
        return (
            str(err.get("code", "unknown")),
            str(err.get("message", f"HTTP {status}")),
        )
    return "unknown", f"HTTP {status}"
