---
id: T11
title: Connected binary sensor
status: todo
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
