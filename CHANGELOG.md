# Changelog

## 0.1.1

- **Fix:** the add-on failed to start on Home Assistant OS with `/bin/sh: can't open '/init': Permission denied`. The AppArmor profile now allows s6-overlay's start-up (`/init`, `/package`, `/command`, `/run`) plus the capabilities, signals and unix sockets it uses.
- **CI:** a new job runs the add-on under its AppArmor profile and fails on any denial.

## 0.1.0

Initial release.

- **WhatsApp Gateway add-on:** links to WhatsApp as a companion device using Baileys (`@whiskeysockets/baileys` 7.0.0-rc14, pinned exactly). Pairing by code or QR, authenticated API, rate-limited send queue, ingress status page.
- **WhatsApp (Gateway) integration:** config flow with reauth, notify entities per person or group, `whatsapp.send_message` (text, image URL or path, document, captions) and `whatsapp.list_groups` services, and a connectivity binary sensor.
