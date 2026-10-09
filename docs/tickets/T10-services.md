---
id: T10
title: send_message and list_groups services
status: todo
depends_on: [T08]
wave: 3
---
## Goal
Build the Telegram-style service for media and ad-hoc targets, plus group discovery.

## Spec refs
spec §4.6, §5; api.md `/send`, `/groups`

## Files
- `custom_components/whatsapp/services.py`: replaces the stub
- `custom_components/whatsapp/services.yaml`: replaces the stub
- `tests/test_services.py`

## Acceptance criteria
- Field schema and validation exactly as in spec §4.6:
  - message, image or document required
  - at most one media source
  - `config_entry_id` optional only when there's a single entry
- `notify.*` entity ids in `target` resolve to their recipient's target through the entity registry and the entry options. Entity ids that aren't from this integration raise `target_error`.
- Local paths are checked with `hass.config.is_allowed_path` (`path_not_allowed`), read in an executor, with the 16 MiB limit (`file_too_large`), then base64-encoded.
- `image_url` is passed to the gateway as a URL.
- `send_message` returns `{results}` with `SupportsResponse.OPTIONAL`, and raises if every target failed.
- `list_groups` is `SupportsResponse.ONLY`, returning `{groups:[{name,jid,participants}]}`.
- Uses only the translation keys already in `strings.json`.

## Tests to write
Schema errors, entity target mapping, a disallowed path, an oversized file, a URL image, a document, partial failure versus total failure, and the `list_groups` response.

## Out of scope
The notify entities, the options flow.

## Questions / notes
