# WhatsApp Gateway

Links Home Assistant to WhatsApp as a companion device ("Linked device") and exposes a small authenticated API to the WhatsApp integration. See the [project README](https://github.com/cookejames/ha-whatsapp-notifications) for the integration and usage examples.

**Unofficial client.** This add-on uses Baileys, an unofficial WhatsApp Web library. It may break WhatsApp's Terms of Service, and the linked number could be restricted or banned. Use a number you can afford to lose. Not affiliated with WhatsApp or Meta.

## Quick start

1. Set an **API key** (at least 16 characters) and, ideally, a **pairing phone number**, then start the add-on.
2. Open the **Web UI** and pair (below).
3. Install the integration via HACS and enter this add-on's URL and your API key.

## Configuration

| Option | Default | Description |
|---|---|---|
| `api_key` | empty | Required. A secret of at least 16 characters that the integration uses to call the gateway. Generate one with a password manager or `openssl rand -hex 24`. If it is empty or too short, the API does not start, the log shows an error, and the Web UI says "Set an API key in the add-on configuration (at least 16 characters)". |
| `pairing_phone_number` | empty | The number you are linking, digits only, with country code and no `+` (for example `15555550123`). If set, a pairing code is shown. If empty, a QR code is shown. |
| `allowed_targets` | empty list | Restricts who can be messaged. Each entry is a phone number, a JID, or `group:Name`. An empty list allows everyone. Messages to anything else fail with `target_not_allowed`. |
| `rate_limit_per_minute` | `10` | Maximum messages sent in any rolling 60 second window (1 to 60). A short random delay is also added between messages. Keep it low to reduce ban risk. |
| `trusted_sources` | empty list | Extra IP addresses or CIDR ranges (for example `192.0.2.10` or `192.0.2.0/24`) allowed to call the API, in addition to Home Assistant. Leave empty unless you know you need it. |
| `log_level` | `info` | One of `debug`, `info`, `warning`, `error`. API keys and message bodies are never logged at any level. |

Example:

```yaml
api_key: "replace-with-a-long-random-string"
pairing_phone_number: "15555550123"
allowed_targets:
  - "+15555550123"
  - "group:Family"
rate_limit_per_minute: 10
trusted_sources: []
log_level: info
```

Restart the add-on after changing options.

## Pairing

Open the add-on's **Web UI** (the Open Web UI button on the Info page). The page shows the connection state and, while pairing, either:

- **A pairing code** (when `pairing_phone_number` is set). It is also written to the add-on log. On the phone that owns the number: WhatsApp > **Settings > Linked devices > Link a device > Link with phone number instead**, then enter the code.
- **A QR code** (when no phone number is set). Scan it from WhatsApp > **Settings > Linked devices > Link a device**.

The page refreshes itself every 5 seconds while pairing. When the state becomes `open`, you are linked. The link survives add-on restarts and updates.

### Connection states

| State | Meaning |
|---|---|
| `starting` / `connecting` | Starting up or reaching WhatsApp. |
| `pairing` | Waiting for you to enter the code or scan the QR. |
| `open` | Connected and ready to send. |
| `closed` | Disconnected. The gateway reconnects automatically with backoff. |
| `logged_out` | WhatsApp unlinked this device. Use **Reset pairing** and pair again. |
| `conflict` | The session is in use elsewhere (WhatsApp error 440). Retried once after 30 seconds. If it persists, use **Reset pairing**. |

### Reset pairing

The Web UI has a **Reset pairing** button (prominent in `logged_out` and `conflict`, otherwise under "Advanced"). It deletes the stored session and restarts the link so you can pair again. Also remove the old entry from WhatsApp > Linked devices on the phone.

## Groups

The Web UI lists the groups the linked number belongs to, with a **Copy JID** button and a **Refresh groups** button. The number must be a member of a group before you can message it. Groups refresh automatically, with at least 60 seconds between refreshes.

## Finding the add-on hostname

The integration reaches the add-on by hostname on Home Assistant's internal network. Open the add-on's **Info** page and look for **Hostname**. For an add-on installed from this repository it is usually `50eb1446-whatsapp-gateway`, so the Gateway URL is:

```
http://50eb1446-whatsapp-gateway:8099
```

Use whatever hostname your Info page shows.

## Network exposure

- The add-on declares **no ports**, so nothing is published on your host, LAN or the internet.
- The **API** listens on port 8099 on the internal Supervisor network. Only Home Assistant Core's address (re-resolved every 5 minutes) and anything in `trusted_sources` can connect. Other sources get `403`. This check runs before the API key is examined.
- **Limit of the IP check:** on Home Assistant OS, Core runs with host networking and reaches add-ons from the Supervisor network's gateway address (usually `172.30.32.1`). Every other add-on with `host_network: true` (for example DNS, Matter or MCP add-ons) connects from that same address, so the IP check lets them through too. Only add-ons on the normal internal network (`172.30.33.x`) are refused. For host-network add-ons the API key is the only protection, so use a long random key.
- Every API route except `/health` requires `Authorization: Bearer <api_key>`.
- The **Web UI** (ingress, port 8098) only accepts connections from the Supervisor ingress proxy. Home Assistant has already authenticated an admin user at that point, so it needs no key.
- **Incoming messages are never read or stored.** Only the WhatsApp session and a group list (names, JIDs, member counts) are kept in the add-on's data folder, which is included in Home Assistant backups. Keep backups private: the session lets whoever holds it send as the linked number.

## Limits

- At most 20 targets per request; message text up to 4096 characters; captions up to 1024.
- Images and documents up to 16 MiB. Images must be JPEG, PNG, WebP or GIF.
- A downloaded URL must respond within 15 seconds and may redirect at most 3 times.
- The send queue holds 100 messages, and a queued message waits at most 2 minutes before failing with `timeout`.

## Error codes

Request-level errors:

| Code | Meaning |
|---|---|
| `invalid_request` | Malformed request. |
| `unauthorized` | Missing or wrong API key. |
| `forbidden_source` | The caller's IP address is not allowed. |
| `not_found` / `method_not_allowed` | Unknown route or wrong method. |
| `payload_too_large` | Body or media too large. |
| `unsupported_media` | Image type not supported. |
| `media_fetch_failed` | The image or document URL could not be downloaded. |
| `not_connected` | WhatsApp is not connected. |
| `internal_error` | Unexpected failure. Check the log. |

Per-target errors (inside the send result):

| Code | Meaning |
|---|---|
| `invalid_target` | Not a valid phone number or JID. |
| `unknown_group` / `ambiguous_group` | No group, or several groups, with that name. |
| `not_a_member` | The linked number is not in that group. |
| `target_not_allowed` | The target is not in `allowed_targets`. |
| `queue_full` / `timeout` | Send queue full, or the message waited too long. |
| `send_failed` | WhatsApp rejected or failed the send. |

## Troubleshooting

- **No pairing code appears:** check `pairing_phone_number` is digits only with the country code, and that the log shows no errors. Clear the number to use a QR code instead.
- **Pairing fails repeatedly:** use **Reset pairing**, and make sure the host has internet access.
- **Integration cannot connect:** check the hostname on the Info page and that the add-on is running.
- **Integration reports invalid auth:** the key in the integration differs from `api_key`.
