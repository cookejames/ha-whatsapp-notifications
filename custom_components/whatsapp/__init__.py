"""The WhatsApp (Gateway) integration."""

from __future__ import annotations

from dataclasses import dataclass

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.typing import ConfigType

from . import services
from .api import WhatsAppGatewayClient
from .const import CONF_API_KEY, CONF_URL, DOMAIN, PLATFORMS
from .coordinator import WhatsAppStatusCoordinator

CONFIG_SCHEMA = cv.config_entry_only_config_schema(DOMAIN)


@dataclass
class WhatsAppRuntimeData:
    """Runtime data stored on the config entry."""

    client: WhatsAppGatewayClient
    coordinator: WhatsAppStatusCoordinator


type WhatsAppConfigEntry = ConfigEntry[WhatsAppRuntimeData]


async def async_setup(hass: HomeAssistant, config: ConfigType) -> bool:
    """Register the integration services."""
    services.async_setup_services(hass)
    return True


async def async_setup_entry(hass: HomeAssistant, entry: WhatsAppConfigEntry) -> bool:
    """Set up WhatsApp (Gateway) from a config entry."""
    client = WhatsAppGatewayClient(
        async_get_clientsession(hass), entry.data[CONF_URL], entry.data[CONF_API_KEY]
    )
    coordinator = WhatsAppStatusCoordinator(hass, entry, client)
    await coordinator.async_config_entry_first_refresh()

    entry.runtime_data = WhatsAppRuntimeData(client=client, coordinator=coordinator)

    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    entry.async_on_unload(entry.add_update_listener(_async_update_listener))
    return True


async def async_unload_entry(hass: HomeAssistant, entry: WhatsAppConfigEntry) -> bool:
    """Unload a config entry."""
    return await hass.config_entries.async_unload_platforms(entry, PLATFORMS)


async def _async_update_listener(
    hass: HomeAssistant, entry: WhatsAppConfigEntry
) -> None:
    """Reload the entry when options (recipients) change."""
    await hass.config_entries.async_reload(entry.entry_id)
