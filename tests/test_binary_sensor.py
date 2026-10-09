"""Tests for the connectivity binary sensor."""

from __future__ import annotations

from datetime import timedelta

import aiohttp
from homeassistant.const import STATE_OFF, STATE_ON, STATE_UNAVAILABLE
from homeassistant.core import HomeAssistant
from homeassistant.helpers import device_registry as dr
from homeassistant.helpers import entity_registry as er
from homeassistant.util import dt as dt_util
from pytest_homeassistant_custom_component.common import (
    MockConfigEntry,
    async_fire_time_changed,
)
from pytest_homeassistant_custom_component.test_util.aiohttp import AiohttpClientMocker

from custom_components.whatsapp.binary_sensor import mask_jid
from custom_components.whatsapp.const import DOMAIN

from .conftest import GATEWAY_URL, STATUS_OPEN

ENTITY_ID = "binary_sensor.whatsapp_gateway_connected"
STATUS_CLOSED = {
    **STATUS_OPEN,
    "state": "closed",
    "connected": False,
    "me": None,
}


async def _setup(
    hass: HomeAssistant,
    aioclient_mock: AiohttpClientMocker,
    entry: MockConfigEntry,
    status: dict,
) -> None:
    aioclient_mock.get(f"{GATEWAY_URL}/status", json=status)
    entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()


async def _poll(hass: HomeAssistant) -> None:
    async_fire_time_changed(hass, dt_util.utcnow() + timedelta(seconds=61))
    await hass.async_block_till_done()


async def test_on_with_attributes_and_device(
    hass: HomeAssistant,
    aioclient_mock: AiohttpClientMocker,
    mock_config_entry: MockConfigEntry,
) -> None:
    """Connected gateway gives on, masked account and the service device."""
    await _setup(hass, aioclient_mock, mock_config_entry, STATUS_OPEN)
    state = hass.states.get(ENTITY_ID)
    assert state is not None
    assert state.state == STATE_ON
    assert state.attributes["device_class"] == "connectivity"
    assert state.attributes["state"] == "open"
    assert state.attributes["since"] == STATUS_OPEN["since"]
    assert state.attributes["me"] == "1555****123"
    assert "15555550123" not in str(state.attributes)

    entity = er.async_get(hass).async_get(ENTITY_ID)
    assert entity is not None
    device = dr.async_get(hass).async_get(entity.device_id)
    assert device is not None
    assert (DOMAIN, mock_config_entry.entry_id) in device.identifiers
    assert device.name == "WhatsApp Gateway"
    assert device.entry_type is dr.DeviceEntryType.SERVICE


async def test_off_when_not_open(
    hass: HomeAssistant,
    aioclient_mock: AiohttpClientMocker,
    mock_config_entry: MockConfigEntry,
) -> None:
    """Reachable but not open gives off, with no account."""
    await _setup(hass, aioclient_mock, mock_config_entry, STATUS_CLOSED)
    state = hass.states.get(ENTITY_ID)
    assert state is not None
    assert state.state == STATE_OFF
    assert state.attributes["state"] == "closed"
    assert state.attributes["me"] is None


async def test_unavailable_when_coordinator_fails(
    hass: HomeAssistant,
    aioclient_mock: AiohttpClientMocker,
    mock_config_entry: MockConfigEntry,
) -> None:
    """A failing poll makes the sensor unavailable, and it recovers."""
    await _setup(hass, aioclient_mock, mock_config_entry, STATUS_OPEN)
    assert hass.states.get(ENTITY_ID).state == STATE_ON

    aioclient_mock.clear_requests()
    aioclient_mock.get(f"{GATEWAY_URL}/status", exc=aiohttp.ClientError())
    await _poll(hass)
    assert hass.states.get(ENTITY_ID).state == STATE_UNAVAILABLE

    aioclient_mock.clear_requests()
    aioclient_mock.get(f"{GATEWAY_URL}/status", json=STATUS_OPEN)
    await _poll(hass)
    assert hass.states.get(ENTITY_ID).state == STATE_ON


def test_mask_jid() -> None:
    """JIDs are masked to first four and last three digits."""
    assert mask_jid("15555550123@s.whatsapp.net") == "1555****123"
    assert mask_jid("15555550123:7@s.whatsapp.net") == "1555****123"
    assert mask_jid("12345@lid") == "****"
    assert mask_jid(None) is None
    assert mask_jid("") is None
