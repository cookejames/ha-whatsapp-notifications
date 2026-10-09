---
id: T05
title: Baileys client and group cache
status: todo
depends_on: [T02]
wave: 3
---
## Goal
Build the real `WhatsAppClient` on Baileys: pairing, reconnect, sending, and the group cache. Write it from scratch against the Baileys docs and types.

## Spec refs
spec §3.5, §3.6, §3.4

## Files
- `whatsapp_gateway/src/whatsapp.ts`: `BaileysClient implements WhatsAppClient`, plus `resetAuth()`. Constructor takes `{dataDir, pairingPhoneNumber?, logger, socketFactory?}`, with an injectable socket factory for tests.
- `whatsapp_gateway/src/groups.ts`: `GroupCache` with `applyFetch(all)`, `applyUpdate(event)`, `metadata(jid)`, `list()`, `load()`/`save()` to `groups.json`, and cooldown and debounce logic (injectable clock)
- `whatsapp_gateway/test/groups.test.ts`, `test/whatsapp.test.ts` (both against a fake socket emitter)

## Acceptance criteria
- The socket options are exactly as in spec §3.5, with an exact Baileys pin (already in `package.json` from T02). If the pin must change, note it here rather than editing `package.json`.
- `FALLBACK_WA_VERSION` constant with an explanatory comment; the version fetch is cached for 6 hours.
- Pairing code requested about 3 seconds after the socket starts when unregistered and a phone number is set. The 20-second timeout race is handled. QR path otherwise.
- The reconnect table in spec §3.5 is implemented, including the generation counter. Tests prove a stale socket's `close` doesn't trigger a second reconnect.
- `send()` throws `NotConnectedError` unless the state is `open`, and maps content kinds correctly.
- No inbound message handlers store content.
- Group cache: refresh triggers, a 5-second debounce, a 60-second cooldown, a 6-hour periodic refresh, and the member flag cleared when the linked account is removed. Persisted file contains only `{jid, name, participants, isMember}`.
- Status events are emitted on every state change.

## Tests to write
Reconnect decisions for each status code, the generation counter, the pairing code flow (success, timeout, socket closing during pairing), send mapping, the not-connected error, and every group cache behaviour.

## Out of scope
HTTP, ingress, `index.ts` wiring (T14). No real network connection in tests.

## Questions / notes
