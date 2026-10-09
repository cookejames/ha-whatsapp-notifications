---
id: T06
title: HTTP API server, IP filter, auth
status: done
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
- `/groups?refresh=true` cooldown: the `WhatsAppClient` interface (and `GroupCache.refresh()`) cannot signal that the 60 s cooldown was hit; it silently returns the cached list. `http.ts` therefore tracks its own 60 s cooldown (`GROUP_COOLDOWN_MS`) and answers `refreshed:false` without calling the client while it is active. Limitation: if the client's own cooldown is active because of an automatic refresh, the route still reports `refreshed:true`. Suggest a future change so `refreshGroups()` returns `{groups, refreshed}`.
- api.md does not say where `suggestions` sits in an error result. It is placed inside the `error` object (`{to, error: {code, message, suggestions}}`). Please confirm; T10 / the Python client should read it from there.
- A non-http(s) or unparsable `image.url` / `document.url` is rejected as `400 invalid_request` during schema validation (api.md says `url` is http/https), rather than `422 media_fetch_failed`.
- `message: ""` with no media is treated as missing (`400`). Unknown extra body fields are ignored.
- Per-target error results carry `jid` when the target resolved (for example `target_not_allowed`, send errors) and omit it when resolution failed.
- Auth runs before routing, so unknown paths and wrong methods need a valid key first (api.md order of checks). `405` responses include an `Allow` header; `401` includes `WWW-Authenticate: Bearer`.

## Implementation notes
- `src/ipfilter.ts`: `createIpFilter({allow, resolveHosts?, refreshMs, resolver?})` returns `{isAllowed, refresh, stop}`; also exports the structural `IpFilter` type and `normaliseAddress`. Uses `node:net` `BlockList`; loopback is always allowed; IPv4-mapped IPv6 and zone ids are normalised; invalid `allow` entries are ignored (deny). The default resolver is `dns.lookup(all)`. A failed lookup keeps that host's previous addresses. The timer is unref'd. The filter does not resolve at construction: the caller (T14) should `await filter.refresh()` before listening.
- `src/http.ts`: `createApiServer({client, queue, options: {apiKey, allowedTargets}, ipFilter, logger, version, remoteAddress?, fetchImpl?, now?})` returns an `http.Server` (not listening). `remoteAddress`, `fetchImpl` and `now` are test seams. Re-exports `IpFilter`; exports the `HttpErrorCode` and `TargetErrorCode` unions and the limit constants.
- Auth compares SHA-256 digests with `timingSafeEqual`. Body cap is 24 MiB (declared length checked first, then streamed; the stream is paused rather than destroyed so the 413 reaches the client).
- `/send`: per target, text goes out before media; the last id is reported; a failed text send skips the media. Targets resolving to the same JID share one outcome and are sent once. Media is loaded once with 16 MiB / 15 s.
- Logging: only masked JIDs, counts and media kind at `info`; unhandled errors log only the error name (parser and fetch errors can echo request content). A test asserts the key, auth header, body, caption and full JIDs never appear in logs.
- Verification: lint, typecheck clean; 227 tests pass; coverage http.ts 98.4% lines, ipfilter.ts 100% lines.
