# WhatsApp Notifications for Home Assistant

Send WhatsApp messages (text, images, documents) to people and groups from Home Assistant. It works much like the Telegram integration and has two parts:

- **WhatsApp Gateway add-on:** links to WhatsApp as a companion device and exposes a small authenticated API inside your Home Assistant host.
- **WhatsApp integration** (installed with HACS): one notify entity per recipient, the `whatsapp.send_message` and `whatsapp.list_groups` services, and a connectivity sensor.

> **Unofficial client.** This project uses [Baileys](https://github.com/WhiskeySockets/Baileys), an unofficial WhatsApp Web library. Using it may break WhatsApp's Terms of Service, and the linked number could be restricted or banned. Link a number you can afford to lose. This project is not affiliated with, endorsed by or connected to WhatsApp or Meta.

## How it works

```
HA automation -> notify.send_message / whatsapp.send_message
      -> custom_components/whatsapp     (HTTP, Bearer API key)
      -> WhatsApp Gateway add-on        (Node + Baileys, internal hassio network)
      -> WhatsApp                       (companion device on the number you link)
```

The add-on appears in your WhatsApp "Linked devices" list, just like WhatsApp Web.

## Requirements

- Home Assistant OS or Supervised (add-ons need the Supervisor). Architectures: amd64 and aarch64.
- [HACS](https://hacs.xyz/) installed.
- A WhatsApp account to link. A spare number is best (see the disclaimer above).

## Installation

### 1. Install the add-on

1. In Home Assistant go to **Settings > Add-ons > Add-on Store**.
2. Open the three-dot menu (top right), choose **Repositories**, and add:
   `https://github.com/cookejames/ha-whatsapp-notifications`
3. Find **WhatsApp Gateway** in the store and install it, but do not start it yet.
4. Open its **Configuration** tab and set:
   - **API key:** a random string of at least 16 characters. Generate one with a password manager or `openssl rand -hex 24`. Keep it handy, you will enter it in the integration.
   - **Pairing phone number (recommended):** the number you are linking, digits only, with country code and no `+` (for example `15555550123`). This gives you a pairing code instead of a QR code.
5. Save, then start the add-on.

The add-on is built on your device on first install, so this can take a few minutes. Every option is described in the [add-on documentation](whatsapp_gateway/DOCS.md).

### 2. Pair with WhatsApp

1. Open the add-on's **Web UI**. The pairing code is shown there and is also written to the add-on **Log**.
2. On the phone that owns the number, open WhatsApp > **Settings > Linked devices > Link a device > Link with phone number instead**.
3. Enter the code. The status badge on the page changes to `open` when the link succeeds.

If you left the pairing phone number empty, the page shows a QR code instead. Scan it from **Linked devices > Link a device**.

### 3. Install the integration

1. In HACS, open the three-dot menu, choose **Custom repositories**, and add `https://github.com/cookejames/ha-whatsapp-notifications` with category **Integration**.
2. Search for **WhatsApp (Gateway)** in HACS, download it, and restart Home Assistant.
3. Go to **Settings > Devices & services > Add integration**, choose **WhatsApp (Gateway)**, and enter:
   - **Gateway URL:** usually `http://50eb1446-whatsapp-gateway:8099`. Confirm the hostname on the add-on's **Info** page. The form pre-fills this value. Change it only if the Info page shows a different hostname.
   - **API key:** the key you set in the add-on configuration.

If you change the API key later, Home Assistant asks you to re-authenticate the integration with the new one.

### 4. Add recipients

Each recipient becomes a notify entity. Open **Settings > Devices & services > WhatsApp Gateway > Configure**:

- **Add person:** a name (for example `Alice`) and a phone number in international format (`+15555550123`).
- **Add group:** pick from a dropdown of the groups the linked number belongs to. You can edit the name.
- **Remove recipient:** remove any you no longer need.

You get entities named `notify.whatsapp_<name>`, such as `notify.whatsapp_alice` and `notify.whatsapp_family`, all under one device called "WhatsApp". A sensor, `binary_sensor.whatsapp_connected`, shows whether WhatsApp is currently connected.

## Usage

### Simple notification

`notify.send_message` works with any recipient entity. A title is sent in bold above the message.

```yaml
action: notify.send_message
target:
  entity_id: notify.whatsapp_alice
data:
  title: Security
  message: Front door opened
```

### `whatsapp.send_message`

Use this for several recipients at once, for media, or for numbers and groups that are not set up as recipients.

| Field | Description |
|---|---|
| `target` | Required. A list of: `notify.whatsapp_*` entities from this integration, phone numbers (`+15555550123`), JIDs, or `group:Name`. |
| `message` | Text. Required unless you send an image or document. |
| `title` | Optional. Shown in bold above the message. |
| `image_url` | Optional. An `http` or `https` URL the gateway downloads and sends as an image (JPEG, PNG, WebP or GIF). |
| `image_path` | Optional. A local image file. The folder must be allowed (see below). |
| `document_path` | Optional. A local file sent as a document. The folder must be allowed. |
| `caption` | Optional. Caption for the image or document. If omitted, `message` is used as the caption. |
| `config_entry_id` | Optional. Only needed if you have more than one gateway. |

Give at most one of `image_url`, `image_path` and `document_path`. Media is limited to 16 MiB.

**Text to a mix of targets:**

```yaml
action: whatsapp.send_message
data:
  target:
    - notify.whatsapp_alice
    - "+15555550124"
    - "group:Family"
  title: Garage
  message: The garage door has been open for 10 minutes
```

**Camera snapshot.** Save the snapshot to a folder Home Assistant is allowed to read, then send it:

```yaml
action: camera.snapshot
target:
  entity_id: camera.front_door
data:
  filename: /config/www/tmp/snapshot.jpg
```

```yaml
action: whatsapp.send_message
data:
  target:
    - notify.whatsapp_family
  image_path: /config/www/tmp/snapshot.jpg
  caption: Someone is at the front door
```

Local files must be in a folder Home Assistant allows. `/config/www` and `/media` are normally allowed already. For any other folder, add it to `configuration.yaml` and restart:

```yaml
homeassistant:
  allowlist_external_dirs:
    - /config/snapshots
```

**Image from a URL.** The gateway downloads the image itself, so the URL must be reachable from the add-on. Home Assistant is available to add-ons at `http://homeassistant:8123`.

```yaml
action: whatsapp.send_message
data:
  target: "group:Garden Club"
  image_url: https://example.com/snapshot.jpg
  caption: This week's meeting
```

**Document:**

```yaml
action: whatsapp.send_message
data:
  target: notify.whatsapp_alice
  document_path: /config/www/report.pdf
  caption: Daily report
```

**Checking the result.** The service can return a result per target, which is useful in scripts:

```yaml
action: whatsapp.send_message
data:
  target:
    - notify.whatsapp_alice
    - "group:Famly"
  message: Hello
response_variable: sent
```

`sent.results` has one entry per target: `{to, id}` on success or `{to, error}` on failure. The action itself fails only if every target failed.

### `whatsapp.list_groups`

Returns the groups the linked number belongs to, with their JIDs.

```yaml
action: whatsapp.list_groups
response_variable: groups
```

The response looks like this:

```yaml
groups:
  - name: Family
    jid: 120363000000000000@g.us
    participants: 5
  - name: Garden Club
    jid: 120363000000000001@g.us
    participants: 12
```

You can also run it from **Developer Tools > Actions**.

## Finding groups

You never need to know a group's JID.

1. The linked number must be a member of the group. Ask a group member to add it in the usual way.
2. **Configure > Add group** shows a dropdown of group names.
3. In YAML, `target: "group:Family"` works directly (exact name, case-insensitive).
4. `whatsapp.list_groups` in Developer Tools > Actions lists names and JIDs if you want them for YAML.
5. The add-on's Web UI has a groups table with a **Copy JID** button and a **Refresh groups** button.

Recipients are stored by JID, so renaming a group does not break them. If a new group is missing, use **Refresh groups** on the Web UI.

## Security model

- The add-on opens **no ports** on your host. It cannot be reached from your LAN or the internet.
- The API only accepts connections from Home Assistant Core's internal address (by source IP). Normal add-ons are refused. **Add-ons that use host networking share Core's address**, so the IP check cannot tell them apart from Core. For those, the API key is the only barrier. The Web UI only accepts connections from the Supervisor's ingress proxy, so it sits behind your Home Assistant login.
- Every API call needs the bearer API key. Use a long random key, and keep it out of anything other add-ons can read.
- The optional `allowed_targets` add-on option limits who the gateway can message, even if something sends a request with the key.
- **Incoming messages are never read or stored.** The gateway only sends. It keeps the WhatsApp session and a list of group names, JIDs and sizes.
- API keys and message bodies are never logged, and phone numbers are masked in the log.

## Troubleshooting

Start with the add-on's **Web UI**, which shows the connection state, and `binary_sensor.whatsapp_connected`.

| Symptom | Meaning and fix |
|---|---|
| State `logged_out` | WhatsApp unlinked the device (for example it was removed from Linked devices). Open the Web UI, choose **Reset pairing**, then pair again. |
| State `conflict` (WhatsApp error 440 in the log) | The same session is in use elsewhere. The gateway retries once after 30 seconds. Make sure only one add-on instance uses this link. If it persists, **Reset pairing**. |
| `not_connected` | WhatsApp is not open. Check the add-on is running and the state in the Web UI. It usually recovers by itself after a restart or network blip. |
| `not_a_member` | The linked number is not in that group (or was removed). Add it back, then **Refresh groups**. |
| `unknown_group` / `ambiguous_group` | The group name did not match, or matched several. The error lists suggestions. |
| `invalid_target` | The phone number or JID is not valid. Use international format with 7 to 15 digits. |
| `target_not_allowed` | The target is not in the add-on's `allowed_targets` option. Add it, or empty the list. |
| `queue_full` / `timeout` | Too many messages queued. The gateway sends at most `rate_limit_per_minute` messages a minute (default 10). The queue holds 100, and each message waits at most 2 minutes. |
| "Reading ... is not allowed" | The file is in a folder Home Assistant may not read. Add the folder to `allowlist_external_dirs` (see above). |
| `unsupported_media` | Images must be JPEG, PNG, WebP or GIF. Send other types with `document_path`. |
| `media_fetch_failed` | The gateway could not download the URL (15 second limit). Check it is reachable from the add-on. |
| `payload_too_large` | Media is over 16 MiB. |
| Integration cannot connect | Check the URL (hostname on the add-on's Info page) and that the add-on is running. |
| Integration reports invalid auth | The API key differs from the add-on configuration. |

## More documentation

- [Add-on configuration, pairing and network details](whatsapp_gateway/DOCS.md)
- [Changelog](CHANGELOG.md)
- Design: [specification](docs/spec.md) and [gateway HTTP API](docs/api.md)

## License

See [LICENSE](LICENSE).
