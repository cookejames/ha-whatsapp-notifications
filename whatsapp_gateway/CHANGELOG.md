# Changelog

## 0.1.2

- **Fix:** Baileys warned at startup that disabling all history sync prevents it from learning phone-number/LID mappings, which can make the session unstable. The gateway now allows only the small `INITIAL_BOOTSTRAP`, `PUSH_NAME` and `NON_BLOCKING_DATA` syncs. Bulk message history (`FULL`, `RECENT`, `ON_DEMAND`) and status sync stay off, and nothing from any sync is stored.
- **Docs:** the security model now says plainly that add-ons using host networking share Home Assistant Core's internal address. The source-IP check cannot exclude them, so the API key is the only barrier for those add-ons.

## 0.1.1

- **Fix:** the add-on failed to start on Home Assistant OS with `/bin/sh: can't open '/init': Permission denied`. The AppArmor profile now allows s6-overlay's start-up (`/init`, `/package`, `/command`, `/run`) plus the capabilities, signals and unix sockets it uses.
- **CI:** a new job runs the add-on under its AppArmor profile and fails on any denial.

## 0.1.0

Initial release.

- Links to WhatsApp as a companion device using Baileys (`@whiskeysockets/baileys` 7.0.0-rc14, pinned exactly), with pairing by code or QR.
- Authenticated HTTP API for sending text, images and documents to people and groups, with a source-IP allowlist, bearer API key, rate-limited send queue and optional target allowlist.
- Ingress status page with pairing, groups table and reset pairing.
- No host ports. Incoming messages are never read or stored.
