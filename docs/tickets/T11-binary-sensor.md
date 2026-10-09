---
id: T11
title: Connected binary sensor
status: done
depends_on: [T08]
wave: 3
---
## Goal
Build a connectivity binary sensor driven by the status coordinator.

## Spec refs
spec §4.7

## Files
- `custom_components/whatsapp/binary_sensor.py`: replaces the stub
- `tests/test_binary_sensor.py`

## Acceptance criteria
- `device_class: connectivity`, on the shared service device. It is on when `connected`, off when the gateway is reachable but not open, and unavailable when the coordinator fails.
- Attributes: `state`, `since`, and `me` masked as `1555****123`.

## Tests to write
On, off, unavailable, masking.

## Out of scope
Everything else.

## Questions / notes
- `strings.json` has no `entity` translation section for the sensor, and it is a shared file. The sensor therefore uses `_attr_has_entity_name = True` with `_attr_name = "Connected"` on the "WhatsApp Gateway" device, which gives `binary_sensor.whatsapp_gateway_connected`. If translated entity names are wanted later, T08 `strings.json` needs an `entity.binary_sensor.connected` key (owner decision).
- `me` is masked as first 4 + last 3 digits of the JID user part (device suffix `:N` stripped). User parts of 7 characters or fewer become `****`. A missing `me` gives `None`.

## Implementation notes
- `binary_sensor.py`: `WhatsAppConnectedSensor(CoordinatorEntity[WhatsAppStatusCoordinator], BinarySensorEntity)`, `unique_id` `<entry_id>_connected`, device info `{(DOMAIN, entry_id)}`, name "WhatsApp Gateway", `DeviceEntryType.SERVICE`, matching T09. `is_on` reads `connected`. Unavailability comes from `CoordinatorEntity` when the last update failed. The module-level helper `mask_jid` is unit-tested.
- Tests cover on (with attributes, masking and device), off, unavailable and recovery, and masking edge cases.
- Verified on Python 3.14.7: `ruff check .`, `ruff format --check .`, `pytest` (27 passed, `binary_sensor.py` 100% coverage).

- Orchestrator follow-up: added `entity.binary_sensor.connected` to the strings and switched the sensor to `_attr_translation_key`.
