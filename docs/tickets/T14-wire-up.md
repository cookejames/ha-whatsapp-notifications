---
id: T14
title: Wire-up, Docker build, smoke test
status: review
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

## Implementation notes
- `index.ts` exports `startGateway(env)` (testable, returns `{apiPort, ingressPort, client, stop}`); `main()` runs only when the file is the process entry point. It reads `OPTIONS_PATH`, `DATA_DIR` and `GATEWAY_FAKE=1`, and listens on `0.0.0.0`.
- Ingress always starts on 8098 (filter: `172.30.32.2` plus loopback). The API starts on 8099 only when `loadOptions` succeeds; the API filter allows `trusted_sources` plus a 5-minute refresh of `homeassistant`, and is refreshed once before listening. With an invalid key, only ingress runs and shows the warning.
- Version is read from `package.json` at runtime (0.1.0, equal to `config.yaml`).
- Fake mode seeds an `open` client with groups `Family` and `Garden Club`; its `resetAuth` is a no-op that re-sets the state to open.
- Shutdown on SIGTERM/SIGINT: close servers, stop queue, stop filters, stop client, exit 0; a 5 s timer forces exit 0 as a backstop. The smoke test confirms `docker stop -t 5` ends with exit code 0 (not 137).
- `scripts/smoke.sh` passes locally on arm64 (build, /health, /status with and without key, /groups, /send to a phone and `group:Family`, clean stop).

## Questions / notes
- **Dockerfile change (needed, proven by smoke test):** the HA base image runs s6-overlay `/init`, which drops the container environment for `CMD`. `GATEWAY_FAKE`, `DATA_DIR` and `OPTIONS_PATH` never reached node, so the real Baileys client started. The `CMD` is now `["with-contenv", "node", "dist/index.js"]`. T02 owns the Dockerfile; please confirm this edit.
- Pre-existing flake (T06, not changed here): `test/http.test.ts` "413 for a declared body over 24 MiB" fails intermittently with `ECONNRESET` on macOS (about 1 in 3 runs).
