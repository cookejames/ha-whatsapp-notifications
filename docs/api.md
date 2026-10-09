# WhatsApp Gateway HTTP API (v1)

This is the contract between the gateway add-on (`whatsapp_gateway/src/http.ts`) and the Home Assistant integration (`custom_components/whatsapp/api.py`). Both sides code against this document. Any change here needs updates and tests on both sides.

## Conventions
- **Base URL:** `http://<addon-hostname>:8099`
- **Content type:** `application/json; charset=utf-8` for request and response bodies.
- **Request body limit:** 24 MiB. Base64 of 16 MiB of media is about 21.4 MiB. Larger bodies get `413` with `payload_too_large`.
- **Auth:** `Authorization: Bearer <api_key>` on every route except `GET /health`.
- **Order of checks:** source-IP filter (`403 forbidden_source`), then auth (`401 unauthorized`), then route handling.
- **Unknown route:** `404 not_found`. Wrong method: `405 method_not_allowed`.

### Error envelope
Every non-2xx response uses this shape:
```json
{ "error": { "code": "invalid_request", "message": "Human-readable description" } }
```

### Error codes
| HTTP | `code` | Meaning |
|---|---|---|
| 400 | `invalid_request` | Malformed JSON or failed schema validation |
| 401 | `unauthorized` | Missing or wrong bearer token |
| 403 | `forbidden_source` | Source IP not allowed |
| 404 | `not_found` | Unknown route |
| 405 | `method_not_allowed` | Wrong method on a known route |
| 413 | `payload_too_large` | Request body or media too large |
| 415 | `unsupported_media` | Image mimetype not supported |
| 422 | `media_fetch_failed` | URL fetch failed, timed out or returned non-2xx |
| 503 | `not_connected` | WhatsApp is not in the `open` state (returned for the whole request before any target is tried) |
| 503 | `api_key_not_configured` | Never sent in practice: the API listener isn't started without a valid key. Reserved. |
| 500 | `internal_error` | Unexpected failure |

Per-target error codes appear inside `/send` results; they are not HTTP statuses:
`invalid_target`, `unknown_group`, `ambiguous_group`, `not_a_member`, `target_not_allowed`, `queue_full`, `timeout`, `send_failed`.

---

## `GET /health`
No auth. The source-IP filter still applies.

`200`
```json
{ "ok": true }
```

## `GET /status`
`200`
```json
{
  "state": "open",
  "connected": true,
  "me": { "jid": "15555550123@s.whatsapp.net", "name": "Gateway" },
  "pairing": null,
  "last_error": null,
  "since": "2026-01-01T12:00:00.000Z",
  "version": "0.1.0"
}
```
- `state` is one of `starting | pairing | connecting | open | closed | logged_out | conflict`.
- `pairing` is `null`, or `{ "code": "ABCD-EFGH" }`, or `{ "qr": true }`. The raw QR string is **not** exposed over the API; it is only shown on the ingress page.
- `me` is `null` until the account is linked.
- `version` is the gateway add-on version.

## `GET /groups`
Returns the cached groups where the linked account is a member. The list is sorted by `name` (case-insensitive).

Query: `?refresh=true` forces a network refresh, subject to the cooldown. When the cooldown is active, the cached list is returned with `"refreshed": false`.

`200`
```json
{
  "groups": [
    { "jid": "120363000000000000@g.us", "name": "Family", "participants": 5 },
    { "jid": "120363000000000001@g.us", "name": "Garden Club", "participants": 12 }
  ],
  "refreshed": false
}
```
If `refresh=true` is requested while not connected: `503 not_connected`.

## `POST /send`
Request:
```json
{
  "to": ["+15555550123", "group:Family", "120363000000000001@g.us"],
  "message": "Front door opened",
  "image": { "url": "http://homeassistant:8123/api/camera_proxy/camera.front?token=…", "caption": "Front door" },
  "document": { "base64": "JVBERi0x…", "filename": "report.pdf", "mimetype": "application/pdf", "caption": "Daily report" }
}
```
Field rules:
- `to`: a string or a non-empty array of strings (max 20). Each is resolved per spec §3.7. Duplicates that resolve to the same JID are sent once, and their result entries share the same outcome.
- `message`: string, max 4096 characters. Required if neither `image` nor `document` is present.
- `image`: optional object with exactly one of `url` (http/https) or `base64`, plus an optional `caption` (string, max 1024 characters).
- `document`: optional object with exactly one of `url` or `base64`, plus a required `filename`, an optional `mimetype` (default `application/octet-stream`), and an optional `caption`.
- `image` and `document` are mutually exclusive.
- If `message` is present together with media and the media has no `caption`, `message` is used as the caption. If both `message` and `caption` are present, the text message is sent first, then the media with its caption.

Processing:
1. Validate the body, returning `400 invalid_request` or `413` on failure.
2. If not connected, return `503 not_connected`.
3. Load the media once (`413`, `415` or `422` on failure).
4. Resolve and allowlist-check each target, then enqueue the sends for each valid target.
5. Wait for all of them to settle.

`200`. The status is still 200 when some or all targets fail; callers check `results`. Results come back in the same order as `to`:
```json
{
  "results": [
    { "to": "+15555550123", "jid": "15555550123@s.whatsapp.net", "id": "3EB0C0FFEE000001" },
    { "to": "group:Family", "jid": "120363000000000000@g.us", "id": "3EB0C0FFEE000002" },
    { "to": "120363000000000001@g.us", "error": { "code": "not_a_member", "message": "The linked account is not a member of this group" } }
  ]
}
```
When a text message and media both go to one target, `id` is the id of the last message sent.

Error results for `unknown_group` and `ambiguous_group` carry suggestions **inside the error object**:
```json
{ "to": "group:Famly", "error": { "code": "unknown_group", "message": "No group named \"Famly\"", "suggestions": ["Family (120363000000000000@g.us)"] } }
```
- **`jid` on an error result:** present when the target resolved (e.g. `target_not_allowed`, `send_failed`); omitted when resolution itself failed.
- **Media URLs:** a `url` that isn't http(s), or can't be parsed, fails validation with `400 invalid_request`. `422 media_fetch_failed` is only for fetch failures.
- **Empty message:** `message: ""` with no media counts as missing, giving `400 invalid_request`. Unknown body fields are ignored.
- **Groups refresh cooldown:** `/groups?refresh=true` is rate limited by the route itself (60 s). While the cooldown is active it returns the cached list with `"refreshed": false`.
- **Extra headers:** `401` responses include `WWW-Authenticate: Bearer`, and `405` responses include `Allow`.

---

## Ingress routes (port 8098, not part of the API)
- `GET /`: status page (HTML)
- `POST /refresh-groups`: returns 303 to `./`
- `POST /reset-pairing`: returns 303 to `./`

Only the source-IP filter (`172.30.32.2` and loopback) applies; there is no bearer auth.
