---
id: T05
title: Baileys client and group cache
status: review
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
- `fetchLatestBaileysVersion()` (v7 rc14) never throws: on failure it returns `{version, isLatest: false, error}`. It reads the version constant from Baileys' master `Defaults/index.ts`, not WhatsApp Web itself (`fetchLatestWaWebVersion()` does that). I followed spec §3.5 (`fetchLatestBaileysVersion`) and treat a returned `error` as a failure. The spec could mention `fetchLatestWaWebVersion` as an alternative.
- v7 `group-participants.update` carries `participants: GroupParticipant[]` (objects with `id`, optional `lid`, `phoneNumber`), not `string[]`. Removal detection matches the account's `sock.user.id` and `sock.user.lid` against all three, with `:device` suffixes stripped. Spec §3.6 should say so.
- Groups that disappear from a full `groupFetchAllParticipating()` result are kept with `isMember: false` (so names still resolve) rather than deleted. The spec is silent; this is the conservative reading.
- Attempt counting: the generic backoff uses a 0-based `attempt` (first retry 1s, then 2s, 4s, capped at 60s); the 428-during-pairing backoff is 1-based (2s, 4s, capped at 15s). "During pairing" means `creds.registered` is false. A failed or timed-out pairing code request ends the socket and reconnects with the pairing backoff.
- `FALLBACK_WA_VERSION` is `[2, 3000, 1043857760]`, the version bundled with the pinned Baileys 7.0.0-rc14. Revisit on every Baileys bump.

## Implementation notes
- `src/whatsapp.ts`: `BaileysClient` plus `buildSocketConfig`, `defaultSocketFactory` and the `SocketLike` / `SocketFactory` types. The constructor takes `{dataDir, pairingPhoneNumber?, logger, socketFactory?, deps?}`; `deps` is a test seam (auth loader, version fetch, clock, jitter RNG, group cache). Each socket belongs to a generation number. Handling a `close` (or a pairing failure) bumps the generation immediately, so later events from that socket are ignored, and there is a single reconnect timer. `stop()` and `resetAuth()` also bump it.
- `src/groups.ts`: `GroupCache` with `applyFetch`, `applyUpdate`, `applyParticipants`, `metadata`, `list`, `load`/`save` (atomic write, mode 0600), and scheduling (`attach`/`detach`, `refresh` with a 60s cooldown and in-flight coalescing, `scheduleRefresh` with a 5s debounce that waits out the cooldown, 6h periodic). Only `{jid, name, participants, isMember}` is persisted.
- Tests: `test/whatsapp.test.ts` and `test/groups.test.ts`, using a fake socket and vitest fake timers; no network.
- No handler for `messages.upsert` or any message event is registered (asserted in a test).
- Coverage: whatsapp.ts 94% stmts / 80.8% branches / 98.7% lines; groups.ts 98.6% / 92.6% / 99.2%.
