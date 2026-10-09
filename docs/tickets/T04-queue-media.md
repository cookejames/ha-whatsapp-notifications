---
id: T04
title: Send queue and media loader
status: todo
depends_on: [T02]
wave: 3
---
## Goal
Build the rate-limited serial send queue, and the image/document loader with its size, time and type limits.

## Spec refs
spec §3.8, §3.9; api.md `/send` field rules and error codes

## Files
- `whatsapp_gateway/src/queue.ts`: `SendQueue` class. Constructor takes `(client: WhatsAppClient, opts: {perMinute, maxLength=100, deadlineMs=120000, jitterMs=[300,1200], now?, random?, sleep?})`. Methods: `enqueue(jid, content)`, `size()`, `stop()`.
- `whatsapp_gateway/src/media.ts`: `loadMedia(spec, kind, {fetchImpl?, maxBytes, timeoutMs})` returns `{data, mimetype, filename?}`, or throws `MediaError(code)` with code `payload_too_large`, `unsupported_media` or `media_fetch_failed`
- `whatsapp_gateway/test/queue.test.ts`, `test/media.test.ts`

## Acceptance criteria
- The queue never exceeds `perMinute` sends in any rolling 60-second window. Sends are serial, never concurrent. FIFO order is kept.
- Enqueueing past `maxLength` gives `queue_full`. A job not started by its deadline gives `timeout`. Client errors come back as `send_failed`, carrying the client's message.
- `stop()` rejects pending jobs.
- The media URL fetch uses global `fetch` with an `AbortController` timeout, at most 3 redirects, and only `http:`/`https:`. Streaming aborts once `maxBytes` is passed.
- Image mimetype comes from the header or is sniffed (JPEG, PNG, WebP, GIF magic bytes). Anything else is `unsupported_media`.
- The document filename is stripped of `/` and `\`.
- Fake timers or injected clocks only; no real sleeping in tests. Coverage ≥ 85%.

## Tests to write
Rate limit window, order, queue full, deadline, a failing send, stop; for media: base64 size cap, URL success via a mocked fetch, timeout, non-2xx, oversized stream, sniffing, a bad scheme, and filename sanitising.

## Out of scope
HTTP routing, Baileys.

## Questions / notes
