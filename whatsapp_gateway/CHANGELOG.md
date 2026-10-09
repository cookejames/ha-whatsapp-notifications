# Changelog

## 0.1.0

Initial release.

- Links to WhatsApp as a companion device using Baileys (`@whiskeysockets/baileys` 7.0.0-rc14, pinned exactly), with pairing by code or QR.
- Authenticated HTTP API for sending text, images and documents to people and groups, with a source-IP allowlist, bearer API key, rate-limited send queue and optional target allowlist.
- Ingress status page with pairing, groups table and reset pairing.
- No host ports. Incoming messages are never read or stored.
