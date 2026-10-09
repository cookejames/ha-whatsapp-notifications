# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is
A public, open-source WhatsApp notification service for Home Assistant. It has two parts that ship from one repo:
- `whatsapp_gateway/`: a Home Assistant **add-on**. TypeScript on Node 22, using Baileys. It links to WhatsApp as a companion device and exposes an authenticated HTTP API on the Supervisor's internal network, plus an ingress status page.
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
Commands are filled in as the tickets land. The expected commands are:
- Gateway (run in `whatsapp_gateway/`): `npm ci`, `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`
- Integration (repo root): `pip install -r requirements_test.txt`, `ruff check .`, `ruff format --check .`, `pytest`
- Smoke test: `scripts/smoke.sh` (needs Docker; runs the add-on with `GATEWAY_FAKE=1`)

## CI
GitHub Actions, in `.github/workflows/ci.yml`: gateway, integration, hassfest, HACS, add-on lint, add-on build test, gitleaks.
