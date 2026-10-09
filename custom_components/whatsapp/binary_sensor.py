"""Connectivity binary sensor for the WhatsApp gateway."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from homeassistant.components.binary_sensor import (
    BinarySensorDeviceClass,
    BinarySensorEntity,
)
from homeassistant.core import HomeAssistant
from homeassistant.helpers.device_registry import DeviceEntryType, DeviceInfo
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from . import WhatsAppConfigEntry
from .const import DEFAULT_TITLE, DOMAIN
from .coordinator import WhatsAppStatusCoordinator


def mask_jid(jid: str | None) -> str | None:
    """Mask the user part of a JID as ``1555****123`` (first 4, last 3)."""
    if not jid:
        return None
    user = jid.split("@", 1)[0].split(":", 1)[0]
    if len(user) <= 7:
        return "****"
    return f"{user[:4]}****{user[-3:]}"


async def async_setup_entry(
    hass: HomeAssistant,
    entry: WhatsAppConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    """Set up the connectivity binary sensor."""
    async_add_entities([WhatsAppConnectedSensor(entry.runtime_data.coordinator, entry)])


class WhatsAppConnectedSensor(
    CoordinatorEntity[WhatsAppStatusCoordinator], BinarySensorEntity
):
    """On when WhatsApp is open on the gateway."""

    _attr_has_entity_name = True
    _attr_translation_key = "connected"
    _attr_device_class = BinarySensorDeviceClass.CONNECTIVITY

    def __init__(
        self, coordinator: WhatsAppStatusCoordinator, entry: WhatsAppConfigEntry
    ) -> None:
        """Initialise the sensor."""
        super().__init__(coordinator)
        self._attr_unique_id = f"{entry.entry_id}_connected"
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, entry.entry_id)},
            name=DEFAULT_TITLE,
            entry_type=DeviceEntryType.SERVICE,
        )

    @property
    def is_on(self) -> bool:
        """Return True when the gateway reports WhatsApp as open."""
        return bool(self.coordinator.data.get("connected"))

    @property
    def extra_state_attributes(self) -> Mapping[str, Any]:
        """Return the connection state, start time and masked account."""
        data = self.coordinator.data
        me = data.get("me") or {}
        return {
            "state": data.get("state"),
            "since": data.get("since"),
            "me": mask_jid(me.get("jid")),
        }
