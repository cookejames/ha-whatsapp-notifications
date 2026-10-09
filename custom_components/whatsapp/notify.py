"""Notify entities. Stub: owned by ticket T09."""

from __future__ import annotations

from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from . import WhatsAppConfigEntry


async def async_setup_entry(
    hass: HomeAssistant,
    entry: WhatsAppConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    """Set up notify entities (none until T09)."""
