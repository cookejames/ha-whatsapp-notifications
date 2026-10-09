---
id: T13
title: "User docs: README, DOCS.md, CHANGELOG"
status: review
depends_on: [T05, T06, T07, T09, T10, T11]
wave: 5
---
## Goal
Write the end-user documentation, using only placeholders.

## Spec refs
spec §1, §2, §4, §5; api.md

## Files
- `README.md`: what it is; the unofficial-client and ban-risk disclaimer; architecture diagram; install (add the add-on repo URL, install and configure the add-on, pair, add the HACS custom repo, install the integration, add recipients); usage examples for `notify.send_message`, `whatsapp.send_message` (text, image URL, camera snapshot via a file under an allowlisted dir, document, group by name), and `whatsapp.list_groups`; group discovery; security model; troubleshooting (logged out, conflict 440, not connected, not a member)
- `whatsapp_gateway/DOCS.md`: add-on configuration reference (every option), pairing walkthrough, finding the add-on hostname, network exposure explanation, reset pairing
- `whatsapp_gateway/CHANGELOG.md` and the root `CHANGELOG.md`: `0.1.0` initial release, noting the pinned Baileys version

## Acceptance criteria
- Every option, service field and error code in the spec is documented.
- Every example uses only the placeholders from spec §1.
- No mention of any private project or person.

## Tests to write
None.

## Out of scope
Code changes.

## Questions / notes
- Discrepancy: the config flow pre-fills `http://local-whatsapp-gateway:8099` (`DEFAULT_URL` in `const.py`, spec §4.3), but an add-on installed from a repository has a hostname like `50eb1446-whatsapp-gateway`. The docs tell users to replace the default with the hostname from the add-on's Info page. Consider changing the default (T08 owner).
- The `50eb1446` hostname prefix comes from the coordinator's brief and was not verified on a live system. The docs say "usually" and tell users to confirm on the Info page.
- `docs/tickets/README.md` index still shows T13 as `todo`; not edited because this ticket does not own it.
- The README says `/config/www` and `/media` are normally in Home Assistant's default allowed paths (HA Core behaviour, not checked in this repo).
- No other code/spec conflicts found; entity ids (`notify.whatsapp_<name>`, `binary_sensor.whatsapp_connected`) match the T09/T11 follow-ups.

## Implementation notes
- `README.md`: disclaimer, architecture, 4-step install, usage examples (notify, mixed targets, camera snapshot, image URL, document, response variable, `list_groups`), group discovery, security model, troubleshooting table.
- `whatsapp_gateway/DOCS.md`: every option from `config.yaml`, pairing, connection states, reset pairing, hostname, network exposure, limits, error codes.
- Both changelogs: `0.1.0`, Baileys `7.0.0-rc14` (from `package.json`).
- All 11 YAML snippets parsed with Ruby `YAML.safe_load`. Only spec §1 placeholders are used.
