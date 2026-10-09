---
id: T07
title: Ingress status page
status: done
depends_on: [T05, T06]
wave: 4
---
## Goal
Build the admin-facing status page served through the HA ingress proxy.

## Spec refs
spec §3.10; api.md ingress routes

## Files
- `whatsapp_gateway/src/ingress.ts`: `createIngressServer({client, resetAuth, ipFilter, logger, apiKeyConfigured})` returns an `http.Server`
- `whatsapp_gateway/test/ingress.test.ts`

## Acceptance criteria
- Only relative URLs; works under any `X-Ingress-Path` prefix.
- No external assets. The QR code is rendered server-side as inline SVG via `qrcode`.
- Shows the state badge, pairing code with instructions (or QR), the API key warning, the groups table with Copy JID buttons, refresh groups, and reset pairing (with a JS confirm, prominent in the `logged_out`/`conflict` states).
- Auto-refreshes every 5 seconds only while the state is `pairing` or `connecting`.
- All dynamic text is HTML-escaped. Group names are attacker-controlled, so tests include `<script>` in a group name.
- POST routes return 303 to `./`. IP filter: only `172.30.32.2` and loopback.

## Tests to write
Rendering per state, escaping, QR SVG present, POST actions call through, and a non-ingress IP gets 403.

## Out of scope
API routes, wiring.

## Questions / notes

- `IngressIpFilter` is declared structurally in `ingress.ts` (`{ isAllowed(remoteAddress) }`) because T06 owns `ipfilter.ts`. T14 must pass the real filter (172.30.32.2 plus loopback) and the add-on's `apiKeyConfigured` boolean.
- Ambiguity: the spec doesn't say what the page shows for `closed`/`starting`; it just shows the badge. Reset pairing sits under "Advanced" in every state except `logged_out`/`conflict`.
- `resetAuth()` is awaited before the 303, so the redirect may be slow; errors from it and from `refreshGroups()` are logged (message only) and still redirect.

## Implementation notes
- `ingress.ts` exports `createIngressServer`, `IngressIpFilter`, plus `renderPage`/`escapeHtml`. Plain `node:http`; the IP filter runs first (403), then routing: `GET|HEAD /`, `POST /refresh-groups`, `POST /reset-pairing` (303 to `./`), 405 for wrong methods, 404 otherwise, 500 on render failure.
- Page: inline CSS with light/dark via `prefers-color-scheme`, state badge plus `since`, pairing code or server-rendered inline SVG QR, API key warning, member-only groups sorted case-insensitively with Copy JID buttons (`data-jid`, small inline script), refresh form, reset form with JS confirm. `<meta http-equiv="refresh" content="5">` only in `pairing`/`connecting`.
- All dynamic text goes through `escapeHtml`. The API key and message content are never rendered or logged.
- Verification: lint, typecheck, test and test:coverage pass; `ingress.ts` is 100% lines.
