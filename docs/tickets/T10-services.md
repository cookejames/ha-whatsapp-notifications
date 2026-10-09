---
id: T10
title: send_message and list_groups services
status: review
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
- `notify.*` targets that are not a recipient entity of the selected entry raise `target_error` (not `entity_not_found`, which stays unused by T10), with the error text "not a WhatsApp recipient entity".
- Spec says a title is "formatted as in 4.5"; with no message text (media only) the title is ignored.
- No changes needed in shared files.

## Implementation notes
- `services.py` registers both services in `async_setup_services` (called from `async_setup`). `send_message` uses `SupportsResponse.OPTIONAL`, `list_groups` uses `ONLY`.
- Validation order: `multiple_media`, `message_required` (both `ServiceValidationError`), then config entry lookup (`config_entry_not_found`, `multiple_config_entries`), then target resolution, then file loading.
- Entity targets resolve through the entity registry (platform == DOMAIN, same config entry, unique_id `<entry_id>_<recipient_id>`) and `entry.options["recipients"]`.
- Files: `is_allowed_path`, then read in an executor capped at `MAX_MEDIA_BYTES + 1` bytes (`file_too_large`; OS errors give `file_read_error`), then base64. Document mimetype comes from `mimetypes`, defaulting to `application/octet-stream`.
- Gateway errors map to `not_connected`, `invalid_auth`, `cannot_connect`, `gateway_error`. If every result has an `error`, `all_targets_failed` is raised.
- Verified: ruff check/format clean, 46 tests pass, `services.py` coverage 100%, hassfest reports 0 invalid integrations.
