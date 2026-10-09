# WhatsApp Notifications for Home Assistant: Specification

A general-purpose WhatsApp notification service for Home Assistant, similar in spirit to the Telegram integration. It has two parts that ship from one repository:

1. **WhatsApp Gateway add-on** (`whatsapp_gateway/`): a small Node.js service built on [Baileys](https://github.com/WhiskeySockets/Baileys). It links to WhatsApp as a companion device and exposes a tiny authenticated HTTP API on the Supervisor's internal network.
2. **WhatsApp integration** (`custom_components/whatsapp/`): a Home Assistant custom integration (installable via HACS) that provides notify entities and services backed by the gateway.

**Language rule:** TypeScript is the project language. Python is used **only** for `custom_components/whatsapp/` and its `tests/`, because Home Assistant requires custom integrations to be Python. Keep that layer thin: an HTTP client, HA glue, and no business logic that could live in the gateway. Scripts and tooling are TypeScript or POSIX shell, never Python.

The HTTP contract between them is defined in [api.md](api.md). Work is tracked in [tickets/](tickets/README.md).

> **Disclaimer to carry into user docs:** Baileys is an unofficial WhatsApp Web client. Using it may break WhatsApp's Terms of Service, and the linked number could be restricted or banned. Users should link a number they can afford to lose.

---

## 1. Public repository rules

This is a public open-source project.
- Never commit personal data: real names, phone numbers, WhatsApp JIDs/LIDs, group names, hostnames, IP addresses of a real network, email addresses, or secrets.
- Use only these placeholders in code, tests, fixtures and docs:
  - Phone: `+15555550123`, which normalises to `15555550123@s.whatsapp.net`
  - A second phone: `+15555550124`
  - Group JID: `120363000000000000@g.us`; a second one: `120363000000000001@g.us`
  - LID: `100000000000000@lid`
  - Names: `Alice`, `Bob`, group `Family`, group `Garden Club`
  - API key: `test-api-key-0123456789abcdef`; a deliberately wrong key: `wrong-key-0123456789`
- Do not log API keys or message bodies at any level. Mask recipients at `info` level and above (e.g. `1555****123@s.whatsapp.net`).

## 2. Architecture

```
HA automation → notify.send_message / whatsapp.send_message
      → custom_components/whatsapp     (HTTP, Bearer API key)
      → WhatsApp Gateway add-on        (Node + Baileys, internal hassio network)
      → WhatsApp                       (companion device on the user's chosen number)
```

### 2.1 Network exposure
- The add-on declares **no `ports:`** (and leaves `host_network` and `apparmor` at their defaults: off and on). It can't be reached from the LAN or the internet.
- Two listeners:
  - **API listener**, port `8099`, used by HA Core at `http://<addon-hostname>:8099`.
  - **Ingress listener**, port `8098` (`ingress_port`), used only by the Supervisor ingress proxy.
- **Source-IP allowlist** (checked before auth; failures get `403`):
  - API listener: the address(es) that `homeassistant` resolves to, re-resolved every 5 minutes, plus any entries in `trusted_sources` (IPs or CIDRs), plus loopback (`127.0.0.1`, `::1`) for health checks.
  - Ingress listener: only `172.30.32.2` (the Supervisor ingress proxy), plus loopback.
  - IPv4-mapped IPv6 addresses (`::ffff:a.b.c.d`) are normalised before comparison.
- **Bearer auth:** every API route except `GET /health` needs `Authorization: Bearer <api_key>`, compared in constant time. Ingress routes don't need the bearer key, because HA has already authenticated an admin user.

## 3. Add-on: `whatsapp_gateway`

### 3.1 Runtime
- TypeScript compiled to JavaScript, run on Node.js 24 (LTS). Python targets 3.14 (required by current Home Assistant).
- Base image `ghcr.io/home-assistant/{arch}-base` (Alpine) with `nodejs` and `npm`. Only production dependencies go in the final image.
- Architectures: `amd64`, `aarch64`.
- Built on the device from the Dockerfile; no prebuilt image registry.

### 3.2 `config.yaml`
```yaml
name: WhatsApp Gateway
slug: whatsapp_gateway
description: Send WhatsApp messages from Home Assistant via a linked device
url: https://github.com/cookejames/ha-whatsapp-notifications
arch: [amd64, aarch64]
init: false
ingress: true
ingress_port: 8098
panel_icon: mdi:whatsapp
options:
  api_key: ""
  pairing_phone_number: ""
  allowed_targets: []
  rate_limit_per_minute: 10
  trusted_sources: []
  log_level: info
schema:
  api_key: password
  pairing_phone_number: "match(^[0-9]{0,15}$)?"
  allowed_targets: ["str"]
  rate_limit_per_minute: "int(1,60)"
  trusted_sources: ["str"]
  log_level: "list(debug|info|warning|error)"
```
- If `api_key` is empty or shorter than 16 characters, the gateway refuses to start the API listener. It logs a clear error, and the ingress page shows "Set an API key in the add-on configuration (at least 16 characters)".
- Options are read from `/data/options.json`. The path can be overridden with the `OPTIONS_PATH` env var for local runs.
- Persistent state lives under `/data`, overridable with `DATA_DIR`:
  - `/data/auth/`: Baileys auth state, dir mode `0700`
  - `/data/groups.json`: last known group list (names, JIDs, participant counts only)

### 3.3 Module layout (`whatsapp_gateway/src/`)
| File | Responsibility |
|---|---|
| `index.ts` | Load options, build logger, construct client/queue/servers, handle SIGTERM gracefully |
| `options.ts` | Parse and validate options into a typed `GatewayOptions` |
| `client.ts` | The `WhatsAppClient` interface and shared types (see 3.4) |
| `fake-client.ts` | In-memory `WhatsAppClient` for tests and `GATEWAY_FAKE=1` local runs |
| `whatsapp.ts` | Real Baileys implementation of `WhatsAppClient` |
| `groups.ts` | Group metadata cache |
| `jid.ts` | Target parsing and normalisation |
| `queue.ts` | Rate-limited serial send queue |
| `http.ts` | API server: IP filter, auth, routes |
| `ingress.ts` | Ingress server: status page |
| `ipfilter.ts` | Source-IP allowlist helpers |
| `media.ts` | Fetch or decode image/document payloads with size and time limits |
| `logger.ts` | pino logger plus the recipient-masking helper |

### 3.4 `WhatsAppClient` interface (`client.ts`)
```ts
export type ConnectionState = "starting" | "pairing" | "connecting" | "open" | "closed" | "logged_out" | "conflict";

export interface PairingInfo { code?: string; qr?: string }   // qr = raw QR string; ingress renders it

export interface ClientStatus {
  state: ConnectionState;
  connected: boolean;                 // state === "open"
  me?: { jid: string; name?: string };
  pairing?: PairingInfo;              // set only while state === "pairing"
  lastError?: string;
  since: string;                      // ISO timestamp of last state change
}

export interface GroupInfo { jid: string; name: string; participants: number; isMember: boolean }

export type OutboundContent =
  | { kind: "text"; text: string }
  | { kind: "image"; data: Buffer; mimetype: string; caption?: string }
  | { kind: "document"; data: Buffer; mimetype: string; filename: string; caption?: string };

export interface WhatsAppClient {
  start(): Promise<void>;
  stop(): Promise<void>;
  status(): ClientStatus;
  groups(): GroupInfo[];                       // from cache; never hits the network
  refreshGroups(): Promise<GroupInfo[]>;       // network fetch, rate limited by cooldown
  send(jid: string, content: OutboundContent): Promise<{ id: string }>;
  on(event: "status", listener: (s: ClientStatus) => void): void;
}
```

### 3.5 Baileys client (`whatsapp.ts`)
- **Version:** pin `@whiskeysockets/baileys` to an exact version (the latest stable or RC at implementation time). Document the version in CHANGELOG.
- **Auth:** `useMultiFileAuthState(<DATA_DIR>/auth)`; persist with `creds.update`.
- **WA Web version:** `fetchLatestBaileysVersion()`, cached in memory for 6 hours. If the fetch fails, fall back to a pinned constant `FALLBACK_WA_VERSION` with a comment explaining why: WhatsApp rejects stale client versions with HTTP 428.
- **Socket options:**
  - `markOnlineOnConnect: false`
  - `syncFullHistory: false`, `shouldSyncHistoryMessage: () => false`
  - `browser: Browsers.macOS("Chrome")` or an equivalent realistic tuple
  - `defaultQueryTimeoutMs: 60_000`
  - `logger`: a pino child at `warn` (or `debug` when `log_level` is `debug`)
  - `cachedGroupMetadata: (jid) => groups.metadata(jid)`
  - `generateHighQualityLinkPreview: false`
- **Baileys v7 notes** (confirmed against 7.0.0-rc14):
  - `fetchLatestBaileysVersion()` never throws. On failure it returns `{version, isLatest: false, error}`, so a returned `error` counts as a failure and `FALLBACK_WA_VERSION` is used. Review the fallback on every Baileys bump.
  - `group-participants.update` carries `participants` as objects (`{id, lid?, phoneNumber?}`), not strings. Removal detection compares the linked account's `user.id` and `user.lid` against all three fields, with `:device` suffixes stripped.
  - Groups missing from a later full fetch are kept with `isMember: false` rather than deleted, so their names still resolve.
  - A pairing-code request that fails or times out ends the socket and reconnects using the pairing backoff.
- **Pairing:**
  - If `pairing_phone_number` is set and the creds aren't registered, call `sock.requestPairingCode(number)` about 3 seconds after creating the socket, without waiting for a QR event. Race it against a 20-second timeout and the socket closing.
  - On success, set the state to `pairing` with `pairing.code`, and log the code at `info`.
  - With no phone number, put QR strings from `connection.update` into `pairing.qr`.
- **Reconnect,** based on `lastDisconnect.error.output.statusCode`:
  - `DisconnectReason.loggedOut` (401): state `logged_out`. No reconnect. Keep the auth directory. The ingress page explains how to re-pair: stop the add-on, delete auth via the "Reset pairing" button, and start it again.
  - `440` (connectionReplaced): state `conflict`. Reconnect once after 30 seconds; if it happens again, stay in `conflict`.
  - `428` during pairing: retry after `min(2000 * attempt, 15000)` ms.
  - Anything else: retry after `min(1000 * 2^attempt, 60000)` ms with ±20% jitter. Reset `attempt` on `open`.
  - A **generation counter** means a stale socket's events are ignored, and only one reconnect timer exists at a time.
- **Inbound:** register no handlers that store messages. Ignore `messages.upsert` entirely.
- **send():** reject with `NotConnectedError` unless the state is `open`. Map `OutboundContent` to Baileys content:
  - text: `{ text }`
  - image: `{ image, mimetype, caption }`
  - document: `{ document, mimetype, fileName, caption }`
- **Reset pairing:** `resetAuth()` (implementation-specific, not on the interface). Stops the socket, deletes `<DATA_DIR>/auth`, and restarts. Used by ingress.

### 3.6 Group cache (`groups.ts`)
- Holds `Map<jid, GroupMetadata>`, plus `GroupInfo[]` derived from it.
- Refreshes with `sock.groupFetchAllParticipating()`:
  - on `open`
  - on a `groups.upsert`, `groups.update` or `group-participants.update` event (debounced by 5 seconds)
  - every 6 hours
  - with a minimum of 60 seconds between network fetches (the cooldown)
- On `group-participants.update` where the linked account is removed, mark the group `isMember: false`.
- Persist the derived `GroupInfo[]` to `groups.json` so names resolve right after a restart.
- `metadata(jid)` returns the cached `GroupMetadata | undefined` for Baileys' `cachedGroupMetadata`.

### 3.7 Target resolution (`jid.ts`)
`resolveTarget(input: string, groups: GroupInfo[]): ResolveResult`, where:

```ts
type ResolveResult =
  | { ok: true; jid: string; kind: "user" | "group" }
  | { ok: false; code: ErrorCode; message: string; suggestions?: string[] }
```

Rules, applied in order, after trimming the input:
1. Ends with `@g.us`: a group. It must exist in `groups` with `isMember: true`; otherwise the error is `not_a_member`.
2. Starts with `group:` (case-insensitive prefix): the rest is the group name.
   - Exact case-insensitive match on `name` among member groups. One match resolves to it.
   - More than one match gives `ambiguous_group`, with suggestions listing `name (jid)`.
   - No match gives `unknown_group`, with up to 3 suggestions from case-insensitive substring and Levenshtein distance ≤ 3.
3. Ends with `@s.whatsapp.net` or `@lid`: a user. The local part must be digits, otherwise `invalid_target`.
4. Otherwise it's treated as a phone number:
   - Strip spaces, dashes, dots, parentheses and one leading `+`.
   - The result must be 7–15 digits, otherwise `invalid_target`.
   - Resolves to `<digits>@s.whatsapp.net`.
   - `@c.us` is normalised to `@s.whatsapp.net`.

**Allowlist:** `isAllowed(jid, allowedTargets, groups)`. Each `allowed_targets` entry is resolved with the same rules (so phone numbers, JIDs and `group:<name>` are all allowed). An empty list allows everything. A target that is not allowed gets `target_not_allowed`.

### 3.8 Send queue (`queue.ts`)
- One serial FIFO queue for all outbound messages.
- **Rate limit:** at most `rate_limit_per_minute` sends in any rolling 60-second window. Each send is followed by a random 300–1200 ms delay (the jitter).
- **Max queue length:** 100. Beyond that, enqueue rejects with `queue_full`.
- Each job has a 120-second deadline from enqueue. If it hasn't been sent by then, it rejects with `timeout`.
- **API:** `enqueue(jid, content): Promise<{ id: string }>`.
- The clock and random source are injectable for tests.

### 3.9 Media (`media.ts`)
- `image` and `document` accept either `url` (http/https only) or `base64`, not both.
- **URL fetch:** 15-second timeout, maximum 3 redirects, and the body is capped at 16 MiB (abort when exceeded). The mimetype comes from the `Content-Type` header, or is sniffed from the leading bytes for images.
- **Base64:** the decoded size is capped at 16 MiB.
- **Images:** `image/jpeg`, `image/png`, `image/webp` or `image/gif`, otherwise `unsupported_media`.
- **Documents:** any mimetype. `filename` is required, with path separators stripped.

### 3.10 Ingress page (`ingress.ts`)
A server-rendered HTML page with no external assets (inline CSS; QR rendered server-side to inline SVG with the `qrcode` package). It works under the ingress path prefix (`X-Ingress-Path` header) by using relative URLs only.

It shows:
- **State badge:** connection state and `since`.
- **Pairing section:**
  - the pairing code in large monospace text, with instructions: *WhatsApp → Settings → Linked devices → Link a device → Link with phone number instead*
  - or a QR SVG, with the instruction to scan it from Linked devices
- **API key warning** if the key is missing or too short.
- **Groups table:** name, participant count, JID, a "Copy JID" button (inline JS), and a "Refresh groups" button (POST).
- **Reset pairing button** (POST, with a JS confirm). Shown in the `logged_out` and `conflict` states, and behind an "Advanced" disclosure otherwise.
- Auto-refresh every 5 seconds while the state is `pairing` or `connecting`.

Ingress POST routes (no bearer, IP filter only): `POST ./refresh-groups` and `POST ./reset-pairing`. Both redirect back to `./`.

## 4. Integration: `custom_components/whatsapp`

### 4.1 Manifest
- Domain `whatsapp`, name "WhatsApp (Gateway)"
- `config_flow: true`, `iot_class: local_polling`, `integration_type: service`
- `codeowners: ["@cookejames"]`
- `documentation` and `issue_tracker` point to the GitHub repo
- No `requirements` (uses aiohttp from HA)
- Version `0.1.0`

### 4.2 API client (`api.py`)
`WhatsAppGatewayClient(session, base_url, api_key)` with async methods:
- `status()`
- `groups()`
- `send(to, message=None, image=None, document=None)`

These map exactly to [api.md](api.md). Errors are raised as:
- `GatewayAuthError` (401/403)
- `GatewayConnectionError` (network or timeout)
- `GatewayError(code, message)` for structured API errors

Timeout is 30 seconds for `send` and 10 seconds for the others.

### 4.3 Config flow
- **User step fields:** `url` (default `http://50eb1446-whatsapp-gateway:8099`: Supervisor names repository add-ons `<sha1(repo URL)[:8]>-<slug>`; the docs explain how to confirm the hostname on the add-on's Info page), `api_key`.
- Validates by calling `status()`. Errors map to `cannot_connect`, `invalid_auth` or `unknown`.
- **Unique ID:** the normalised URL. The entry title is "WhatsApp Gateway".
- **Reauth flow:** used when the API key changes.

### 4.4 Options flow: recipients
Stored in `entry.options["recipients"]` as a list of `{id, name, target, kind}`. `id` is a uuid4 hex; `kind` is `user` or `group`.

The menu step offers:
- **Add person:** fields `name` and `phone` (validated with the same phone rules as 3.7, step 4). Stored as `<digits>@s.whatsapp.net`.
- **Add group:** calls `groups()` and offers a `SelectSelector` of group names (value = JID). If no groups come back, it aborts with `no_groups` and tells the user to add the linked number to a group first. The default `name` is the group name, and the user can edit it.
- **Remove recipient:** a multi-select of existing recipients.

Saving reloads the entry.

### 4.5 Notify entities (`notify.py`)
- One `NotifyEntity` per recipient, with `unique_id` `<entry_id>_<recipient_id>`. Entity names come from the recipient name, giving `notify.whatsapp_alice` or `notify.whatsapp_family`.
- `supported_features = NotifyEntityFeature.TITLE`
- `async_send_message(message, title=None)`: if `title` is set, the text becomes `*{title}*\n{message}`. Then it calls `send(to=[target], message=text)`.
- **Errors:**
  - `GatewayError` with code `not_connected`: raise `HomeAssistantError` with the translation key `not_connected`.
  - Other `GatewayError`s: `HomeAssistantError` with the gateway message.
- Every entity's `device_info` points to a single service device named "WhatsApp" (so entity ids are `notify.whatsapp_<recipient>` and `binary_sensor.whatsapp_connected`).

### 4.6 Services (`services.yaml`, registered in `__init__.py`)
**`whatsapp.send_message`**

| Field | Type | Notes |
|---|---|---|
| `config_entry_id` | config entry selector | optional if there's exactly one entry |
| `target` | list of strings | required. Each item is a `notify.*` entity id belonging to this integration (mapped to its recipient target), a phone number, a JID, or `group:<name>`. Non-entity items are passed to the gateway as they are. |
| `message` | text | required unless `image_*` or `document_path` is given |
| `title` | text | optional; formatted as in 4.5 |
| `image_url` | text | optional |
| `image_path` | text | optional; must pass `hass.config.is_allowed_path` |
| `document_path` | text | optional; must pass `is_allowed_path`; filename = basename |
| `caption` | text | optional; used for image/document. If omitted and media is present, `message` becomes the caption. |

Rules:
- At most one of `image_url`, `image_path` or `document_path`.
- Local files are read in an executor, base64-encoded, and checked against the 16 MiB limit.
- **Response:** `SupportsResponse.OPTIONAL`, returning `{results: [{to, id?, error?}]}`. The service raises `HomeAssistantError` if *all* targets failed.

**`whatsapp.list_groups`**
- `SupportsResponse.ONLY`
- Optional field: `config_entry_id`
- Returns `{groups: [{name, jid, participants}]}`

### 4.7 Binary sensor (`binary_sensor.py`)
- `binary_sensor.whatsapp_connected`, `device_class: connectivity`, driven by a `DataUpdateCoordinator` that polls `status()` every 60 seconds.
- **Attributes:** `state` (the gateway connection state), `me` (the linked account JID, masked to `1555****123`), `since`.
- The entity is `unavailable` when the gateway itself can't be reached. It is `off` when the gateway is reachable but WhatsApp isn't open.

### 4.8 Translations
`strings.json` and `translations/en.json` cover:
- config, options and reauth steps
- errors (`cannot_connect`, `invalid_auth`, `unknown`, `no_groups`, `invalid_phone`)
- exceptions (`not_connected`, `target_error`, `path_not_allowed`, `file_too_large`)
- service descriptions

## 5. Group discovery (users never need to know a JID)
1. The linked number must be a member of the group; a group member adds it in WhatsApp in the usual way.
2. **Options flow → Add group:** pick by name from a dropdown.
3. **`whatsapp.list_groups`** in Developer Tools → Actions shows names and JIDs for YAML use.
4. **Ingress page:** a groups table with a "Copy JID" button.
5. In YAML, `target: "group:Family"` works directly.
6. Renamed groups keep working, because JIDs are what's stored.

## 6. Testing
- **Gateway:** vitest. Unit tests per module, using `fake-client.ts`. HTTP tests use the real server on an ephemeral port, with the source IP controlled by binding to and requesting from `127.0.0.1`, plus an injectable `remoteAddress` resolver for the allowlist logic. Nothing touches the network or the real WhatsApp service.
- **Integration:** `pytest-homeassistant-custom-component`, with the gateway mocked via `aioclient_mock`.
- **Coverage targets:** ≥ 85% lines for `jid.ts`, `queue.ts`, `ipfilter.ts`, `http.ts` and `media.ts`, and ≥ 85% for the integration package.

## 7. CI: GitHub Actions (`.github/workflows/ci.yml`)
Triggers: `push` to `main` and `pull_request`. The workflow uses `permissions: contents: read`, and third-party actions are pinned by full commit SHA with a version comment.

| Job | Steps |
|---|---|
| `gateway` | setup-node 22 (npm cache keyed on `whatsapp_gateway/package-lock.json`); in `whatsapp_gateway/`: `npm ci`, `npm run lint`, `npm run typecheck`, `npm test` |
| `integration` | setup-python 3.14; `pip install -r requirements_test.txt`; `ruff check .`; `ruff format --check .`; `pytest` |
| `hassfest` | `home-assistant/actions/hassfest` |
| `hacs` | `hacs/action` with `category: integration` |
| `addon-lint` | `frenck/action-addon-linter` with `path: ./whatsapp_gateway` |
| `addon-build` | `home-assistant/builder/actions/build-image` matrix (amd64 on `ubuntu-latest`, aarch64 on `ubuntu-24.04-arm`), context `whatsapp_gateway`, `push: false`, `BUILD_FROM=ghcr.io/home-assistant/<arch>-base:3.24` (matches `build.yaml`; Alpine 3.24 ships Node 24). The legacy `--test` builder action is deprecated. |
| `addon-apparmor` | Loads `whatsapp_gateway/apparmor.txt` on the runner, runs `scripts/smoke.sh` with `--security-opt apparmor=whatsapp_gateway`, and fails on any AppArmor denial for the profile |
| `secrets` | gitleaks CLI (`zricethezav/gitleaks` image) over the full history, checkout `fetch-depth: 0` |

`.github/dependabot.yml` covers weekly updates for `npm` (`/whatsapp_gateway`), `pip` (`/`) and `github-actions` (`/`).

## 8. Release
To release, bump `version` in `whatsapp_gateway/config.yaml` and `custom_components/whatsapp/manifest.json`, update both CHANGELOG sections, and tag `vX.Y.Z`.
