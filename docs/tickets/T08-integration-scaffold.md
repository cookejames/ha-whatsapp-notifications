---
id: T08
title: Integration scaffold, API client, config flow
status: todo
depends_on: [T01]
wave: 2
---
## Goal
Build the integration skeleton, including every shared file the later integration tickets need, so that T09, T10 and T11 only touch their own modules.

## Spec refs
spec §4.1–§4.3, §4.8, §6; api.md

## Files
- `custom_components/whatsapp/manifest.json` (spec §4.1)
- `custom_components/whatsapp/const.py`: DOMAIN, defaults, config keys, `PLATFORMS = [Platform.BINARY_SENSOR, Platform.NOTIFY]`
- `custom_components/whatsapp/api.py`: `WhatsAppGatewayClient` and the exception classes (spec §4.2), matching api.md exactly
- `custom_components/whatsapp/coordinator.py`: `WhatsAppStatusCoordinator` (polls `status()` every 60 seconds)
- `custom_components/whatsapp/__init__.py`:
  - `async_setup` calls `services.async_setup_services(hass)`
  - `async_setup_entry` creates the client and coordinator, stores runtime data (`entry.runtime_data`), forwards PLATFORMS, and reloads on an options update
  - `async_unload_entry`
- `custom_components/whatsapp/config_flow.py`: user and reauth steps. `async_get_options_flow` returns `WhatsAppOptionsFlow` imported from `.options_flow`.
- **Stubs** for later tickets to replace. Each has a module docstring saying which ticket owns it.
  - `options_flow.py`: an options flow that just shows an empty form
  - `notify.py`: `async_setup_entry` that adds nothing
  - `binary_sensor.py`: same
  - `services.py`: an `async_setup_services` that does nothing
  - `services.yaml`: empty mapping
- `custom_components/whatsapp/strings.json` and `translations/en.json`: **complete**, covering every key in spec §4.8 (config, reauth, options menu/person/group/remove steps, errors, exceptions, and the service names, descriptions and fields for `send_message` and `list_groups`)
- `custom_components/whatsapp/icons.json`: service icons
- `pyproject.toml`: ruff config, and pytest config (`asyncio_mode = auto`, testpaths)
- `requirements_test.txt`: `pytest-homeassistant-custom-component` pinned
- `tests/__init__.py`, `tests/conftest.py` (with `enable_custom_integrations`, and fixtures for a mock config entry and a gateway URL/key), `tests/test_api.py`, `tests/test_config_flow.py`, `tests/test_init.py`

## Acceptance criteria
- `ruff check . && ruff format --check . && pytest` passes.
- The config flow handles success, `cannot_connect`, `invalid_auth`, `unknown`, an already-configured URL, and reauth.
- `api.py` parses the error envelope into `GatewayError(code, message)`, maps 401/403 to `GatewayAuthError`, and maps timeouts and connection errors to `GatewayConnectionError`.
- `hassfest`-compatible manifest and strings (validated in CI by T12).
- The entry sets up and unloads cleanly with the stubs.

## Tests to write
API client against `aioclient_mock`, covering every route and error class. Config flow paths. Setup and unload.

## Out of scope
Recipients, notify, services and sensor behaviour.

## Questions / notes
