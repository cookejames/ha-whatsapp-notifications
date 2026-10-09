---
id: T09
title: Recipients options flow and notify entities
status: done
depends_on: [T08]
wave: 3
---
## Goal
Users manage person and group recipients, and each recipient becomes a `notify` entity.

## Spec refs
spec §4.4, §4.5, §5

## Files
- `custom_components/whatsapp/options_flow.py`: replaces the stub
- `custom_components/whatsapp/notify.py`: replaces the stub
- `tests/test_options_flow.py`, `tests/test_notify.py`

## Acceptance criteria
- Menu: add person, add group, remove recipient.
- Phone validation matches spec §3.7 step 4 (error `invalid_phone`).
- The group step fetches `groups()` live and shows a `SelectSelector` of names whose values are JIDs. It aborts with `no_groups` when the list is empty, and shows `cannot_connect` on an API failure.
- Recipients are stored as `{id, name, target, kind}` in options.
- Entity per recipient: unique id `<entry_id>_<recipient_id>`, name from the recipient, one shared service device, and `NotifyEntityFeature.TITLE`.
- Title formatting: `*{title}*\n{message}`.
- Errors are translated as `not_connected` or `target_error`.
- Removing a recipient removes its entity from the entity registry.
- Uses only the translation keys already in `strings.json`. If a key is missing, note it here and don't edit `strings.json`.

## Tests to write
Each flow path, entity creation for a person and a group, a send with and without a title, error mapping, and removal.

## Out of scope
Services, the binary sensor.

## Questions / notes
- Entity ids: with `_attr_has_entity_name` and the service device named "WhatsApp Gateway", ids come out as `notify.whatsapp_gateway_alice`, not the `notify.whatsapp_alice` in spec §4.5. Services must resolve via the registry unique_id, not the entity id pattern.
- The Remove menu entry is hidden when there are no recipients (no translation key exists for an empty-remove abort).
- `tests/test_config_flow.py::test_options_flow_stub` tested the T08 stub (a form on init) and could not pass once the menu landed, so it was deleted. This is a T09 edit to a T08 file; the new tests cover the options flow.

## Implementation notes
- `options_flow.py`: `OptionsFlow` without a custom `__init__` argument (uses `self.config_entry`). Menu steps `add_person`, `add_group`, `remove`; phone check is `normalize_phone()`. The group step calls `runtime_data.client.groups()` each time; empty list aborts `no_groups`; auth, connection and other API errors show the `invalid_auth`, `cannot_connect` and `unknown` errors under `base` on an empty form. The group `name` is optional and falls back to the group name. Saving writes `{"recipients": [...]}` and the update listener reloads the entry.
- `notify.py`: `WhatsAppNotifyEntity` (unique id `<entry_id>_<recipient_id>`, `NotifyEntityFeature.TITLE`, shared service device with identifiers `(DOMAIN, entry_id)`). Stale notify registry entries for the entry are removed during platform setup. Errors: `not_connected`; other gateway errors and per-target error results become `target_error`; auth and connection errors use the existing `invalid_auth` and `cannot_connect` exception keys.
- Verified: `ruff check`, `ruff format --check`, `pytest` (44 passed, 100% coverage including `notify.py` and `options_flow.py`).

- Orchestrator follow-up: the shared device is named "WhatsApp" (`DEVICE_NAME`), so ids are `notify.whatsapp_<recipient>` and `binary_sensor.whatsapp_connected`. The config entry title stays "WhatsApp Gateway".
