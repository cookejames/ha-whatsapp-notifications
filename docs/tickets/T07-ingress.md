---
id: T07
title: Ingress status page
status: todo
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
