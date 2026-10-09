import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Logger } from "pino";
import type { GroupInfo, OutboundContent, WhatsAppClient } from "./client.js";
import { GROUP_COOLDOWN_MS } from "./groups.js";
import type { IpFilter } from "./ipfilter.js";
import { isAllowed, resolveTarget } from "./jid.js";
import { maskJid } from "./logger.js";
import { loadMedia, MediaError, type LoadedMedia, type MediaSpec } from "./media.js";
import type { GatewayOptions } from "./options.js";
import type { SendQueue } from "./queue.js";
import { QueueError } from "./queue.js";

export { type IpFilter } from "./ipfilter.js";

/** HTTP-level error codes (api.md "Error codes"). */
export type HttpErrorCode =
  | "invalid_request"
  | "unauthorized"
  | "forbidden_source"
  | "not_found"
  | "method_not_allowed"
  | "payload_too_large"
  | "unsupported_media"
  | "media_fetch_failed"
  | "not_connected"
  | "api_key_not_configured"
  | "internal_error";

/** Per-target error codes inside `/send` results. */
export type TargetErrorCode =
  | "invalid_target"
  | "unknown_group"
  | "ambiguous_group"
  | "not_a_member"
  | "target_not_allowed"
  | "queue_full"
  | "timeout"
  | "send_failed";

export const MAX_BODY_BYTES = 24 * 1024 * 1024;
export const MAX_MEDIA_BYTES = 16 * 1024 * 1024;
export const MEDIA_TIMEOUT_MS = 15_000;
export const MAX_TARGETS = 20;
export const MAX_MESSAGE_CHARS = 4096;
export const MAX_CAPTION_CHARS = 1024;

export interface ApiServerDeps {
  client: WhatsAppClient;
  queue: Pick<SendQueue, "enqueue">;
  options: Pick<GatewayOptions, "apiKey" | "allowedTargets">;
  ipFilter: IpFilter;
  logger: Logger;
  version: string;
  /** Source address of a request; defaults to the socket's remote address (tests inject this). */
  remoteAddress?: (req: IncomingMessage) => string | undefined;
  fetchImpl?: typeof fetch;
  /** Clock for the `/groups?refresh=true` cooldown. */
  now?: () => number;
}

const STATUS_FOR_CODE: Record<HttpErrorCode, number> = {
  invalid_request: 400,
  unauthorized: 401,
  forbidden_source: 403,
  not_found: 404,
  method_not_allowed: 405,
  payload_too_large: 413,
  unsupported_media: 415,
  media_fetch_failed: 422,
  not_connected: 503,
  api_key_not_configured: 503,
  internal_error: 500,
};

class ApiError extends Error {
  constructor(
    readonly code: HttpErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

const sha256 = (s: string): Buffer => createHash("sha256").update(s).digest();

function tokenMatches(header: string | undefined, key: string): boolean {
  const m = header ? /^Bearer (.+)$/i.exec(header.trim()) : null;
  const presented = m?.[1] ?? "";
  // Compare fixed-length digests so neither length nor content leaks via timing.
  const ok = timingSafeEqual(sha256(presented), sha256(key));
  return ok && presented.length > 0;
}

function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
    "Cache-Control": "no-store",
    ...extra,
  });
  res.end(text);
}

function sendError(res: ServerResponse, code: HttpErrorCode, message: string, extra: Record<string, string> = {}): void {
  sendJson(res, STATUS_FOR_CODE[code], { error: { code, message } }, extra);
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw new ApiError("payload_too_large", "Request body exceeds 24 MiB");
  }
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        // Pause rather than destroy, so the 413 response can still be delivered.
        req.pause();
        req.removeAllListeners("data");
        chunks.length = 0;
        reject(new ApiError("payload_too_large", "Request body exceeds 24 MiB"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// Validation

interface MediaRequest extends MediaSpec {
  caption?: string;
}

interface SendRequest {
  to: string[];
  message?: string;
  image?: MediaRequest;
  document?: MediaRequest;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function bad(message: string): never {
  throw new ApiError("invalid_request", message);
}

function parseMedia(raw: unknown, name: "image" | "document"): MediaRequest {
  if (!isObject(raw)) bad(`${name} must be an object`);
  const { url, base64, caption, filename, mimetype } = raw;
  if ((url === undefined) === (base64 === undefined)) bad(`${name} needs exactly one of url or base64`);
  const out: MediaRequest = {};
  if (url !== undefined) {
    if (typeof url !== "string" || url === "") bad(`${name}.url must be a non-empty string`);
    let parsed: URL | undefined;
    try {
      parsed = new URL(url);
    } catch {
      parsed = undefined;
    }
    if (!parsed || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) {
      bad(`${name}.url must be an http or https URL`);
    }
    out.url = url;
  } else {
    if (typeof base64 !== "string" || base64 === "") bad(`${name}.base64 must be a non-empty string`);
    out.base64 = base64;
  }
  if (caption !== undefined) {
    if (typeof caption !== "string" || caption.length > MAX_CAPTION_CHARS) {
      bad(`${name}.caption must be a string of at most ${MAX_CAPTION_CHARS} characters`);
    }
    out.caption = caption;
  }
  if (name === "document") {
    if (typeof filename !== "string" || filename.trim() === "") bad("document.filename is required");
    out.filename = filename;
    if (mimetype !== undefined) {
      if (typeof mimetype !== "string" || mimetype === "") bad("document.mimetype must be a string");
      out.mimetype = mimetype;
    }
  }
  return out;
}

function parseSendRequest(body: unknown): SendRequest {
  if (!isObject(body)) bad("Request body must be a JSON object");
  const { to, message, image, document } = body;

  let targets: string[];
  if (typeof to === "string") {
    targets = [to];
  } else if (Array.isArray(to)) {
    if (to.length === 0) bad("to must not be empty");
    if (to.length > MAX_TARGETS) bad(`to may contain at most ${MAX_TARGETS} targets`);
    if (!to.every((t) => typeof t === "string")) bad("to must contain only strings");
    targets = to as string[];
  } else {
    return bad("to must be a string or a non-empty array of strings");
  }

  const req: SendRequest = { to: targets };
  if (message !== undefined) {
    if (typeof message !== "string") bad("message must be a string");
    if (message.length > MAX_MESSAGE_CHARS) bad(`message must be at most ${MAX_MESSAGE_CHARS} characters`);
    req.message = message;
  }
  if (image !== undefined && document !== undefined) bad("image and document are mutually exclusive");
  if (image !== undefined) req.image = parseMedia(image, "image");
  if (document !== undefined) req.document = parseMedia(document, "document");
  if (!req.image && !req.document && (req.message === undefined || req.message === "")) {
    bad("message is required when no image or document is given");
  }
  return req;
}

// /send

interface TargetError {
  code: TargetErrorCode;
  message: string;
  suggestions?: string[];
}

type Outcome = { jid: string; id: string } | { jid?: string; error: TargetError };

function contentsFor(req: SendRequest, media: LoadedMedia | undefined): OutboundContent[] {
  if (!media) return [{ kind: "text", text: req.message ?? "" }];
  const own = (req.image ?? req.document)?.caption;
  const out: OutboundContent[] = [];
  let caption = own;
  if (own !== undefined && req.message) {
    out.push({ kind: "text", text: req.message });
  } else if (own === undefined && req.message) {
    caption = req.message;
  }
  if (req.image) {
    out.push({
      kind: "image",
      data: media.data,
      mimetype: media.mimetype,
      ...(caption !== undefined ? { caption } : {}),
    });
  } else {
    out.push({
      kind: "document",
      data: media.data,
      mimetype: media.mimetype,
      filename: media.filename ?? req.document?.filename ?? "file",
      ...(caption !== undefined ? { caption } : {}),
    });
  }
  return out;
}

async function sendAll(
  deps: ApiServerDeps,
  jid: string,
  contents: OutboundContent[],
): Promise<Outcome> {
  let id = "";
  try {
    // Sequential per target so the text message goes out before its media.
    for (const content of contents) id = (await deps.queue.enqueue(jid, content)).id;
    return { jid, id };
  } catch (err) {
    if (err instanceof QueueError) return { jid, error: { code: err.code, message: err.message } };
    return { jid, error: { code: "send_failed", message: "Failed to send message" } };
  }
}

async function handleSend(deps: ApiServerDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const raw = await readBody(req);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    return bad("Request body is not valid JSON");
  }
  const request = parseSendRequest(parsed);

  if (!deps.client.status().connected) {
    throw new ApiError("not_connected", "WhatsApp is not connected");
  }

  let media: LoadedMedia | undefined;
  const kind = request.image ? "image" : request.document ? "document" : undefined;
  if (kind) {
    try {
      media = await loadMedia(request[kind] as MediaSpec, kind, {
        maxBytes: MAX_MEDIA_BYTES,
        timeoutMs: MEDIA_TIMEOUT_MS,
        ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
      });
    } catch (err) {
      if (err instanceof MediaError) throw new ApiError(err.code, err.message);
      throw err;
    }
  }
  const contents = contentsFor(request, media);

  const groups: GroupInfo[] = deps.client.groups();
  const byJid = new Map<string, Promise<Outcome>>();
  const pending: { to: string; outcome: Promise<Outcome> }[] = request.to.map((to) => {
    const resolved = resolveTarget(to, groups);
    if (!resolved.ok) {
      const error: TargetError = {
        code: resolved.code,
        message: resolved.message,
        ...(resolved.suggestions ? { suggestions: resolved.suggestions } : {}),
      };
      return { to, outcome: Promise.resolve<Outcome>({ error }) };
    }
    if (!isAllowed(resolved.jid, deps.options.allowedTargets, groups)) {
      return {
        to,
        outcome: Promise.resolve<Outcome>({
          jid: resolved.jid,
          error: { code: "target_not_allowed", message: "This target is not in allowed_targets" },
        }),
      };
    }
    let outcome = byJid.get(resolved.jid);
    if (!outcome) {
      outcome = sendAll(deps, resolved.jid, contents);
      byJid.set(resolved.jid, outcome);
    }
    return { to, outcome };
  });

  const settled = await Promise.all(pending.map(async (p) => ({ to: p.to, outcome: await p.outcome })));
  const results = settled.map(({ to, outcome }) => {
    if ("error" in outcome) return { to, ...(outcome.jid ? { jid: outcome.jid } : {}), error: outcome.error };
    return { to, jid: outcome.jid, id: outcome.id };
  });

  const failed = results.filter((r) => "error" in r).length;
  deps.logger.info(
    { targets: results.map((r) => (r.jid ? maskJid(r.jid) : "invalid")), failed, media: kind ?? "none" },
    "Send request processed",
  );
  sendJson(res, 200, { results });
}

// Other routes

function handleStatus(deps: ApiServerDeps, res: ServerResponse): void {
  const s = deps.client.status();
  const pairing = s.pairing?.code !== undefined ? { code: s.pairing.code } : s.pairing?.qr !== undefined ? { qr: true } : null;
  sendJson(res, 200, {
    state: s.state,
    connected: s.connected,
    me: s.me ? { jid: s.me.jid, ...(s.me.name !== undefined ? { name: s.me.name } : {}) } : null,
    pairing,
    last_error: s.lastError ?? null,
    since: s.since,
    version: deps.version,
  });
}

function groupBody(groups: GroupInfo[], refreshed: boolean): unknown {
  const list = groups
    .filter((g) => g.isMember)
    .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()))
    .map((g) => ({ jid: g.jid, name: g.name, participants: g.participants }));
  return { groups: list, refreshed };
}

export function createApiServer(deps: ApiServerDeps): Server {
  const remoteOf = deps.remoteAddress ?? ((req: IncomingMessage) => req.socket.remoteAddress);
  const now = deps.now ?? Date.now;
  let lastRefreshAt: number | undefined;

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!deps.ipFilter.isAllowed(remoteOf(req))) {
      return sendError(res, "forbidden_source", "Source address is not allowed");
    }
    const url = new URL(req.url ?? "/", "http://localhost");
    const method = req.method ?? "GET";
    const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, "") : url.pathname;

    if (path !== "/health" && !tokenMatches(req.headers.authorization, deps.options.apiKey)) {
      return sendError(res, "unauthorized", "Missing or invalid bearer token", { "WWW-Authenticate": "Bearer" });
    }

    const allowedMethod = (m: string): boolean => {
      if (method === m) return true;
      sendError(res, "method_not_allowed", `Use ${m} for ${path}`, { Allow: m });
      return false;
    };

    switch (path) {
      case "/health":
        if (allowedMethod("GET")) sendJson(res, 200, { ok: true });
        return;
      case "/status":
        if (allowedMethod("GET")) handleStatus(deps, res);
        return;
      case "/groups": {
        if (!allowedMethod("GET")) return;
        const wantsRefresh = url.searchParams.get("refresh") === "true";
        if (!wantsRefresh) return sendJson(res, 200, groupBody(deps.client.groups(), false));
        if (!deps.client.status().connected) throw new ApiError("not_connected", "WhatsApp is not connected");
        const t = now();
        // The client interface cannot report a cooldown hit, so the route tracks its own.
        if (lastRefreshAt !== undefined && t - lastRefreshAt < GROUP_COOLDOWN_MS) {
          return sendJson(res, 200, groupBody(deps.client.groups(), false));
        }
        lastRefreshAt = t;
        const fresh = await deps.client.refreshGroups();
        return sendJson(res, 200, groupBody(fresh, true));
      }
      case "/send":
        if (allowedMethod("POST")) await handleSend(deps, req, res);
        return;
      default:
        return sendError(res, "not_found", "Unknown route");
    }
  }

  const server = createServer((req, res) => {
    route(req, res).catch((err: unknown) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (err instanceof ApiError) {
        // Do not keep reading a body we have refused.
        const extra: Record<string, string> = err.code === "payload_too_large" ? { Connection: "close" } : {};
        sendError(res, err.code, err.message, extra);
        return;
      }
      // Never log err itself: parser and fetch errors can echo request content.
      deps.logger.error({ errorName: err instanceof Error ? err.name : "unknown" }, "Unhandled API error");
      sendError(res, "internal_error", "Internal error");
    });
  });
  return server;
}
