"""Notify entities: one per recipient."""

from __future__ import annotations

from homeassistant.components.notify import NotifyEntity, NotifyEntityFeature
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers import entity_registry as er
from homeassistant.helpers.device_registry import DeviceEntryType, DeviceInfo
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from . import WhatsAppConfigEntry
from .api import (
    GatewayAuthError,
    GatewayConnectionError,
    GatewayError,
    WhatsAppGatewayClient,
)
from .const import CONF_RECIPIENTS, DEFAULT_TITLE, DOMAIN

PARALLEL_UPDATES = 1


async def async_setup_entry(
    hass: HomeAssistant,
    entry: WhatsAppConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    """Create a notify entity per recipient and drop removed ones."""
    recipients = entry.options.get(CONF_RECIPIENTS, [])

    wanted = {f"{entry.entry_id}_{r['id']}" for r in recipients}
    registry = er.async_get(hass)
    for reg_entry in er.async_entries_for_config_entry(registry, entry.entry_id):
        if reg_entry.domain == "notify" and reg_entry.unique_id not in wanted:
            registry.async_remove(reg_entry.entity_id)

    async_add_entities(
        WhatsAppNotifyEntity(entry, entry.runtime_data.client, recipient)
        for recipient in recipients
    )


class WhatsAppNotifyEntity(NotifyEntity):
    """Sends WhatsApp messages to one recipient."""

    _attr_has_entity_name = True
    _attr_supported_features = NotifyEntityFeature.TITLE

    def __init__(
        self,
        entry: WhatsAppConfigEntry,
        client: WhatsAppGatewayClient,
        recipient: dict[str, str],
    ) -> None:
        """Initialise the entity."""
        self._client = client
        self._target = recipient["target"]
        self._attr_name = recipient["name"]
        self._attr_unique_id = f"{entry.entry_id}_{recipient['id']}"
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, entry.entry_id)},
            name=DEFAULT_TITLE,
            entry_type=DeviceEntryType.SERVICE,
        )

    async def async_send_message(self, message: str, title: str | None = None) -> None:
        """Send a message, with the title in bold above it."""
        text = f"*{title}*\n{message}" if title else message
        try:
            results = await self._client.send(to=[self._target], message=text)
        except GatewayError as err:
            if err.code == "not_connected":
                raise HomeAssistantError(
                    translation_domain=DOMAIN, translation_key="not_connected"
                ) from err
            raise self._target_error(err.message) from err
        except GatewayAuthError as err:
            raise HomeAssistantError(
                translation_domain=DOMAIN, translation_key="invalid_auth"
            ) from err
        except GatewayConnectionError as err:
            raise HomeAssistantError(
                translation_domain=DOMAIN, translation_key="cannot_connect"
            ) from err

        for result in results:
            if error := result.get("error"):
                raise self._target_error(error.get("message", error.get("code", "")))

    def _target_error(self, error: str) -> HomeAssistantError:
        return HomeAssistantError(
            translation_domain=DOMAIN,
            translation_key="target_error",
            translation_placeholders={"target": self._attr_name or "", "error": error},
        )
