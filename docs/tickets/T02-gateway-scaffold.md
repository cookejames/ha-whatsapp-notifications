---
id: T02
title: Gateway scaffold, options, client interface, fake client
status: todo
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
