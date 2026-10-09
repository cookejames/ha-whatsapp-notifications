---
id: T06
title: HTTP API server, IP filter, auth
status: todo
depends_on: [T03, T04]
wave: 4
---
## Goal
Build the API listener exactly as defined in api.md, using `node:http` with no web framework.

## Spec refs
spec §2.1; api.md (all routes, envelopes and codes)

## Files
- `whatsapp_gateway/src/ipfilter.ts`: `createIpFilter({allow: string[] /* IPs or CIDRs */, resolveHosts?: string[], refreshMs, resolver?})`, which exposes `isAllowed(remoteAddress)`, `refresh()` and `stop()`. IPv4-mapped IPv6 is normalised. Loopback is always allowed.
- `whatsapp_gateway/src/http.ts`: `createApiServer({client, queue, options, ipFilter, logger, version})` returns an `http.Server`
- `whatsapp_gateway/test/ipfilter.test.ts`, `test/http.test.ts`

## Acceptance criteria
- Order of checks: IP filter (403), then auth (401, constant-time compare), then routing (404/405).
- `/health`, `/status`, `/groups` (including `refresh=true` and the cooldown flag) and `/send` match api.md byte-for-byte on field names.
- `/send`: schema validation, the 24 MiB body cap, `503 not_connected` before resolving targets, media loaded once, per-target resolution and allowlist errors, deduplicating targets that resolve to the same JID, and results in input order. A text message plus media with a caption gives two sends with the last id reported.
- The raw QR string is never present in `/status`.
- The logger never receives the key, auth header or message body. Recipients go through `maskJid`.
- Coverage ≥ 85%.

## Tests to write
- Every row of the api.md error table that applies to the API.
- Happy paths using `FakeWhatsAppClient`.
- Source-IP filtering via an injected `remoteAddress` function (Core allowed, another add-on IP refused, a `trusted_sources` CIDR allowed).
- The `homeassistant` hostname resolved through an injected resolver.

## Out of scope
Ingress (T07), `index.ts` wiring (T14).

## Questions / notes
