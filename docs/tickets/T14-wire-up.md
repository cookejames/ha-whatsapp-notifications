---
id: T14
title: Wire-up, Docker build, smoke test
status: todo
depends_on: [T05, T06, T07]
wave: 5
---
## Goal
Wire `index.ts` together so the add-on runs end to end, and prove the image builds and serves.

## Spec refs
spec §2.1, §3.2, §3.3

## Files
- `whatsapp_gateway/src/index.ts`: final wiring
  - load options, then create the logger
  - create the client: `BaileysClient`, or `FakeWhatsAppClient` when `GATEWAY_FAKE=1`
  - create the queue and IP filters (API: resolve `homeassistant` plus `trusted_sources`; ingress: `172.30.32.2`)
  - start the ingress server on 8098 (always)
  - start the API server on 8099 only if the key is valid
  - client `start()`
  - graceful SIGTERM: stop the servers, the queue and the client
- `whatsapp_gateway/test/index.test.ts`: start-up with fake client and temp dirs, including the invalid-key path where only ingress starts
- `scripts/smoke.sh`: builds the image, runs it with `GATEWAY_FAKE=1`, a temp options file and `trusted_sources: ["0.0.0.0/0"]` (local-only), maps 8099 to localhost, then curls `/health`, `/status` (with and without the key), `/groups` and `/send`, and asserts the responses. It cleans up the container.

## Acceptance criteria
- `npm test` passes. `scripts/smoke.sh` passes locally (or the notes record that Docker is unavailable).
- The process exits 0 within 5 seconds of SIGTERM.
- With no valid key: ingress serves the warning, and nothing listens on 8099.

## Tests to write
As listed.

## Out of scope
Real WhatsApp pairing. That's a manual step done by the maintainer.

## Questions / notes
