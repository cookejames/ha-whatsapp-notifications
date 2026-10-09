# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is
A public, open-source WhatsApp notification service for Home Assistant. It has two parts that ship from one repo:
- `whatsapp_gateway/`: a Home Assistant **add-on**. TypeScript on Node 24 LTS, using Baileys. It links to WhatsApp as a companion device and exposes an authenticated HTTP API on the Supervisor's internal network, plus an ingress status page.
- `custom_components/whatsapp/`: a thin Home Assistant **custom integration** in Python, installed via HACS. It provides a config flow, notify entities per recipient, the `whatsapp.send_message` and `whatsapp.list_groups` services, and a connectivity binary sensor.

## Source of truth
- `docs/spec.md`: the full technical specification
- `docs/api.md`: the gateway HTTP contract that both halves code against. Any change to it needs changes and tests on both sides.
- `docs/tickets/`: the work breakdown. `README.md` has the index, conventions, status flow and file-ownership rules.

Read the relevant spec sections and your ticket before writing code. When the spec is ambiguous, record the question in the ticket's "Questions / notes" section; don't guess.

## Rules
- **Language:** TypeScript everywhere except `custom_components/whatsapp/` and `tests/`. HA requires Python there, so keep that layer thin. Scripts and tooling are TypeScript or POSIX shell.
- **Public repo hygiene:** never commit personal data (names, phone numbers, JIDs/LIDs, group names, real hostnames or IPs, emails, secrets). Use only the placeholders in `docs/spec.md` §1.
- **Logging:** never log API keys, auth headers or message bodies. Mask recipients with `maskJid`.
- **Security posture:** the add-on has no host ports. A source-IP allowlist runs before bearer auth. Don't weaken either.
- **Baileys** is pinned to an exact version. Bumps are deliberate and recorded in the CHANGELOG.
- **File ownership:** stay within your ticket's file list (see `docs/tickets/README.md`).

## Commands
Node comes from nvm and is pinned in the root `.nvmrc` (24). Python work always happens in a venv on Python ≥ 3.14, which current Home Assistant requires.

**Gateway** (run in `whatsapp_gateway/`, after `. "$NVM_DIR/nvm.sh" && nvm use`):
- `npm ci`
- `npm run lint` (eslint)
- `npm run typecheck` (checks src and tests)
- `npm test` (vitest); a single file: `npx vitest run test/jid.test.ts`
- `npm run test:coverage`
- `npm run build` (compiles to `dist/`)

**Integration** (repo root):
- `python3 -m venv .venv && .venv/bin/pip install -r requirements_test.txt`
- `.venv/bin/ruff check .` and `.venv/bin/ruff format --check .`
- `.venv/bin/pytest`; a single file: `.venv/bin/pytest tests/test_services.py`

**End to end:** `sh scripts/smoke.sh` builds the add-on image and runs it with `GATEWAY_FAKE=1` (no real WhatsApp). It checks `/health`, auth, `/groups`, `/send` and clean shutdown. Needs Docker.

**Running the gateway locally:** `GATEWAY_FAKE=1 OPTIONS_PATH=<options.json> DATA_DIR=<dir> node dist/index.js`. Ingress listens on 8098; the API listens on 8099, and only when the API key is at least 16 characters.

## Gateway architecture (`whatsapp_gateway/src/`)
- `index.ts`: `startGateway()` wiring and signal handling
- `options.ts`: reads `/data/options.json`
- `client.ts`: the `WhatsAppClient` interface. `whatsapp.ts` (Baileys) and `fake-client.ts` implement it.
- `groups.ts`: group cache, persisted to `groups.json`
- `jid.ts`: target resolution (phone numbers, JIDs, `group:<name>`) and the allowlist
- `queue.ts`: rate-limited serial send queue
- `media.ts`: image/document loading with limits
- `http.ts`: API server (implements `docs/api.md`)
- `ipfilter.ts`: source-IP allowlist
- `ingress.ts`: admin status page
- `logger.ts`: pino logger and `maskJid`

The Dockerfile `CMD` runs under s6 `/init` and needs `with-contenv`, otherwise environment variables don't reach Node.

## Integration architecture (`custom_components/whatsapp/`)
- `api.py`: the HTTP client
- `coordinator.py`: polls `/status`
- `config_flow.py`, `options_flow.py`: setup, and recipients (people and groups)
- `notify.py`: one entity per recipient
- `binary_sensor.py`: connectivity
- `services.py`: `send_message` and `list_groups`

Runtime data is `entry.runtime_data`. All entities share one service device named "WhatsApp". `strings.json` and `translations/en.json` must stay identical.

## CI and releases
GitHub Actions (`.github/workflows/ci.yml`) runs these jobs: gateway, integration, hassfest, HACS, add-on lint, add-on build (amd64 and aarch64), and gitleaks over the full history. Third-party actions are pinned by SHA.

To release: bump `version` in `whatsapp_gateway/config.yaml`, `whatsapp_gateway/package.json` and `custom_components/whatsapp/manifest.json`, update both CHANGELOGs, and tag `vX.Y.Z`. Review `FALLBACK_WA_VERSION` in `whatsapp.ts` on every Baileys bump.
