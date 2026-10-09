---
id: T13
title: "User docs: README, DOCS.md, CHANGELOG"
status: todo
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
