# WhatsApp Notifications for Home Assistant

Send WhatsApp messages (text, images, documents) to people and groups from Home Assistant. It works much like the Telegram integration and has two parts:

- **WhatsApp Gateway add-on:** links to WhatsApp as a companion device and exposes a small authenticated API inside your Home Assistant host.
- **WhatsApp integration** (via HACS): notify entities per recipient, plus the `whatsapp.send_message` and `whatsapp.list_groups` services.

> ⚠️ **Unofficial client.** This uses [Baileys](https://github.com/WhiskeySockets/Baileys), an unofficial WhatsApp Web library. Using it may break WhatsApp's Terms of Service, and the linked number could be restricted or banned. Link a number you can afford to lose.

Documentation coming soon. See [docs/spec.md](docs/spec.md) for the design.
