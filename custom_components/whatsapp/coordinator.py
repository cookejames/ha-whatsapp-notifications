"""Status coordinator for the WhatsApp (Gateway) integration."""

from __future__ import annotations

import logging

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import ConfigEntryAuthFailed
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator, UpdateFailed

from .api import (
    GatewayApiError,
    GatewayAuthError,
    GatewayStatus,
    WhatsAppGatewayClient,
)
from .const import DOMAIN, STATUS_SCAN_INTERVAL

_LOGGER = logging.getLogger(__name__)


class WhatsAppStatusCoordinator(DataUpdateCoordinator[GatewayStatus]):
    """Polls the gateway status every 60 seconds."""

    config_entry: ConfigEntry

    def __init__(
        self,
        hass: HomeAssistant,
        config_entry: ConfigEntry,
        client: WhatsAppGatewayClient,
    ) -> None:
        """Initialise the coordinator."""
        super().__init__(
            hass,
            _LOGGER,
            config_entry=config_entry,
            name=DOMAIN,
            update_interval=STATUS_SCAN_INTERVAL,
        )
        self.client = client

    async def _async_update_data(self) -> GatewayStatus:
        """Fetch the gateway status."""
        try:
            return await self.client.status()
        except GatewayAuthError as err:
            raise ConfigEntryAuthFailed(
                translation_domain=DOMAIN, translation_key="invalid_auth"
            ) from err
        except GatewayApiError as err:
            raise UpdateFailed(
                translation_domain=DOMAIN, translation_key="cannot_connect"
            ) from err
