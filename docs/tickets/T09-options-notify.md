---
id: T09
title: Recipients options flow and notify entities
status: todo
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
