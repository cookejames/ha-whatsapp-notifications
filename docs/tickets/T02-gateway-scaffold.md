---
id: T02
title: Gateway scaffold, options, client interface, fake client
status: done
depends_on: [T01]
wave: 2
---
## Goal
A buildable, testable TypeScript project for the add-on, with every runtime and dev dependency the later gateway tickets need already declared. Those tickets must not need to edit `package.json`.

## Spec refs
spec §3.1–§3.4, §6

## Files
- `whatsapp_gateway/package.json` and `package-lock.json`
  - runtime: `@whiskeysockets/baileys` (exact pin, latest at implementation time), `pino`, `qrcode`
  - dev: `typescript`, `@types/node`, `@types/qrcode`, `vitest`, `@vitest/coverage-v8`, `eslint`, `typescript-eslint`
  - scripts: `build`, `start`, `lint`, `typecheck`, `test`, `test:coverage`
  - `"type": "module"`, `engines.node >=22`
- `whatsapp_gateway/tsconfig.json`: strict, ES2022, NodeNext, `outDir: dist`
- `whatsapp_gateway/eslint.config.js`
- `whatsapp_gateway/vitest.config.ts`
- `whatsapp_gateway/config.yaml`: exactly as in spec §3.2, version `0.1.0`
- `whatsapp_gateway/build.yaml`: base images for amd64/aarch64
- `whatsapp_gateway/Dockerfile`: multi-stage; build with dev deps, final stage with prod deps + `dist/`; `CMD ["node", "dist/index.js"]`
- `whatsapp_gateway/apparmor.txt`: allows node, network, read on the app dir, read-write on `/data`
- `whatsapp_gateway/translations/en.yaml`: labels and descriptions for every option
- `whatsapp_gateway/icon.png` and `logo.png`: simple generic placeholder images (no WhatsApp trademark artwork)
- `whatsapp_gateway/src/client.ts`: the interface and types exactly as in spec §3.4, plus error classes `NotConnectedError` and `SendError`
- `whatsapp_gateway/src/fake-client.ts`: an in-memory `FakeWhatsAppClient` with settable state, settable groups, a record of `sent[]`, and the ability to make the next send fail
- `whatsapp_gateway/src/options.ts`: `loadOptions(path)` returns `GatewayOptions` (validated; trims; dedupes lists)
- `whatsapp_gateway/src/logger.ts`: `createLogger(level)` and `maskJid(jid)` (`15555550123@s.whatsapp.net` becomes `1555****123@s.whatsapp.net`; groups `1203****000@g.us`)
- `whatsapp_gateway/src/index.ts`: minimal for now; loads options, logs start-up (never the key), and exits cleanly on SIGTERM. Full wiring is T14.
- `whatsapp_gateway/test/options.test.ts`, `test/logger.test.ts`, `test/fake-client.test.ts`

## Acceptance criteria
- `npm ci && npm run lint && npm run typecheck && npm test` passes in `whatsapp_gateway/`.
- `docker build whatsapp_gateway` succeeds locally, if Docker is available. If it isn't, write that in the notes.
- `loadOptions` rejects an `api_key` shorter than 16 characters with a typed result (no throw), so `index.ts` can carry on and serve ingress.
- `maskJid` never reveals more than the first 4 and last 3 characters of the local part.

## Tests to write
Option parsing (defaults, invalid values, short key), masking, and the fake client's behaviour.

## Out of scope
Real Baileys logic, HTTP servers.

## Questions / notes
- Dockerfile base is pinned to Alpine 3.22 (`ghcr.io/home-assistant/amd64-base:3.22`). Alpine 3.22 ships nodejs 22.x; 3.23 and 3.24 (the newest tag available) ship Node 24, which would not match `.nvmrc`/`engines`. When moving to a newer base, check the Alpine nodejs major first. `build.yaml` uses the same tag for aarch64.
- Spec §3.2 lists no `version` key in the sample, but the ticket requires version `0.1.0`, so `config.yaml` has `version: "0.1.0"`.
- `src/index.ts` keeps the process alive with a timer until SIGTERM/SIGINT; T14 replaces it with real servers.

## Implementation notes
- Baileys pinned exactly to `7.0.0-rc14` (npm `latest`; 6.7.24 is tagged `legacy`). Published 2026-07-29.
- TypeScript is `~6.0.3` because `typescript-eslint` 8.71.1 peer range is `>=4.8.4 <6.1.0`. `@types/node` is `^22.20.5` to match the runtime.
- Extra files beyond the ticket list (needed by tooling): root `.nvmrc` (`22`, assigned to this ticket by the coordinator) and `whatsapp_gateway/tsconfig.test.json` (so `npm run typecheck` also checks `test/` and `vitest.config.ts`).
- `loadOptions(path)` and `parseOptions(raw)` both return `{ ok: true, options } | { ok: false, code, error }` and never throw. Error text never includes the key.
- `FakeWhatsAppClient` helpers: `setState`, `setGroups`, `setRefreshResult`, `failNextSend`, `sent[]`, `refreshCount`.
- `maskJid` shows at most the first 4 and last 3 local-part characters; local parts of 7 or fewer characters are fully masked.
- Verified on host Node 22.23.3: `npm ci`, `npm run lint`, `npm run typecheck`, `npm test` (30 tests) pass. `docker build --platform linux/amd64 whatsapp_gateway` succeeds; the `--platform` flag is only needed on arm64 hosts, since the default base image is amd64.

- 2026-10-09 (orchestrator): moved to Node 24 LTS. `.nvmrc` is 24, base images are Alpine 3.24 (nodejs 24.18), `engines >=24`, and `@types/node` ^24.
