---
id: T04
title: Send queue and media loader
status: done
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
- `QueueError` (in `queue.ts`) carries `code`: `queue_full`, `timeout` or `send_failed`. T06 should map it to the per-target result. `NotConnectedError` and any other client error also become `send_failed` with the client's message (conservative reading).
- `maxLength` counts jobs waiting in the queue; the job currently being sent no longer counts.
- A job waiting on the rate limit is rejected with `timeout` at its deadline (the wait sleep is capped at the deadline). A job queued behind a slow in-flight `client.send` is only checked once that send returns.
- `stop()` is synchronous, rejects pending jobs with `send_failed` ("Send queue stopped") and refuses new enqueues. A send already in flight is left to finish.
- `perMinute` is floored and clamped to at least 1.
- Media: redirects are followed manually (max 3, each hop re-checked for http/https). A bad scheme or invalid URL gives `media_fetch_failed` (the spec has no separate code for it). A too-large `Content-Length` is rejected before streaming. For images the Content-Type is used if it is one of the four allowed types, otherwise the bytes are sniffed. For documents the mimetype is `spec.mimetype`, then the header, then `application/octet-stream`.
- `loadMedia` takes `{url?, base64?, filename?, mimetype?}`; T06 should pass `maxBytes` = 16 MiB and `timeoutMs` = 15000.
- Vitest's text coverage table omits fully covered files, so `queue.ts` (100% lines) does not appear in it.

## Implementation notes
- `src/queue.ts`: serial worker loop with injectable `now`/`random`/`sleep`; the rate limit uses send-start timestamps in a rolling 60 s window; jitter sleep only between sends.
- `src/media.ts`: `loadMedia`, `MediaError`, plus exported `sniffImageType` and `sanitizeFilename`.
- Tests use a virtual clock and injected sleep (queue) and a mocked `fetch` with fake timers (media). No real network or sleeping.
- Lint, typecheck and tests pass; line coverage: queue.ts 100%, media.ts 100%.
