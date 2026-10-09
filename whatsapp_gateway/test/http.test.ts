/* eslint-disable @typescript-eslint/no-explicit-any -- parsed JSON responses are inspected loosely */
import type { AddressInfo } from "node:net";
import { request as httpRequest, type IncomingMessage, type Server } from "node:http";
import type { Logger } from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeWhatsAppClient } from "../src/fake-client.js";
import type { GroupInfo } from "../src/client.js";
import { createApiServer, MAX_BODY_BYTES } from "../src/http.js";
import { createIpFilter } from "../src/ipfilter.js";
import { QueueError, SendQueue } from "../src/queue.js";

const KEY = "test-api-key-0123456789abcdef";
const WRONG = "wrong-key-0123456789";
const ALICE = "+15555550123";
const ALICE_JID = "15555550123@s.whatsapp.net";
const BOB_JID = "15555550124@s.whatsapp.net";
const FAMILY = "120363000000000000@g.us";
const CLUB = "120363000000000001@g.us";
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

const GROUPS: GroupInfo[] = [
  { jid: CLUB, name: "garden Club", participants: 12, isMember: true },
  { jid: FAMILY, name: "Family", participants: 5, isMember: true },
  { jid: "120363000000000009@g.us", name: "Left", participants: 2, isMember: false },
];

interface Harness {
  client: FakeWhatsAppClient;
  logs: string[];
  base: string;
  server: Server;
  remote: { addr: string | undefined };
  clock: { t: number };
  call: (
    path: string,
    init?: { method?: string; key?: string | null; body?: unknown; raw?: string; headers?: Record<string, string> },
  ) => Promise<{ status: number; json: any; headers: Headers }>;
}

let h: Harness;
let fetchStub: typeof fetch | undefined;
let queueOverride: { enqueue: SendQueue["enqueue"] } | undefined;
let allowed: string[] = [];

function logger(logs: string[]): Logger {
  const rec =
    (level: string) =>
    (...args: unknown[]): void => {
      logs.push(`${level} ${JSON.stringify(args)}`);
    };
  return {
    debug: rec("debug"),
    info: rec("info"),
    warn: rec("warn"),
    error: rec("error"),
  } as unknown as Logger;
}

async function setup(opts: { state?: "open" | "closed" } = {}): Promise<Harness> {
  const client = new FakeWhatsAppClient({ state: opts.state ?? "open" });
  client.setGroups(GROUPS);
  const queue = new SendQueue(client, { perMinute: 60, sleep: async () => {}, jitterMs: [0, 0] });
  const logs: string[] = [];
  const remote = { addr: "127.0.0.1" as string | undefined };
  const clock = { t: 1_000_000 };
  const ipFilter = createIpFilter({ allow: ["198.51.100.0/24"], resolveHosts: ["homeassistant"], refreshMs: 0, resolver: async () => ["172.30.32.5"] });
  await ipFilter.refresh();
  const server = createApiServer({
    client,
    queue: queueOverride ?? queue,
    options: { apiKey: KEY, allowedTargets: allowed },
    ipFilter,
    logger: logger(logs),
    version: "9.9.9",
    remoteAddress: () => remote.addr,
    now: () => clock.t,
    ...(fetchStub ? { fetchImpl: fetchStub } : {}),
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call: Harness["call"] = async (path, init = {}) => {
    const headers: Record<string, string> = { ...init.headers };
    if (init.key !== null) headers["Authorization"] = `Bearer ${init.key ?? KEY}`;
    let body: string | undefined;
    if (init.raw !== undefined) body = init.raw;
    else if (init.body !== undefined) body = JSON.stringify(init.body);
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const res = await fetch(base + path, { method: init.method ?? "GET", headers, ...(body !== undefined ? { body } : {}) });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : undefined, headers: res.headers };
  };
  return { client, logs, base, server, remote, clock, call };
}

beforeEach(async () => {
  fetchStub = undefined;
  queueOverride = undefined;
  allowed = [];
  h = await setup();
});

function closeServer(s: Server): Promise<void> {
  return new Promise<void>((r) => {
    s.closeAllConnections();
    s.close(() => r());
  });
}

afterEach(async () => {
  await closeServer(h.server);
});

const errorOf = (r: { json: any }): string => r.json.error.code;

describe("source filter and auth ordering", () => {
  it("rejects a disallowed source with 403 before auth", async () => {
    h.remote.addr = "172.30.33.9"; // another add-on
    const r = await h.call("/status", { key: WRONG });
    expect(r.status).toBe(403);
    expect(errorOf(r)).toBe("forbidden_source");
    expect((await h.call("/health", { key: null })).status).toBe(403);
    expect((await h.call("/nope")).status).toBe(403);
  });

  it("allows Core (resolved host), trusted CIDR, mapped IPv6 and loopback", async () => {
    for (const addr of ["172.30.32.5", "::ffff:172.30.32.5", "198.51.100.77", "127.0.0.1", "::1"]) {
      h.remote.addr = addr;
      expect((await h.call("/health", { key: null })).status).toBe(200);
    }
  });

  it("rejects a missing source address", async () => {
    h.remote.addr = undefined;
    expect((await h.call("/health", { key: null })).status).toBe(403);
  });

  it("returns 401 for missing, wrong and malformed tokens, before routing", async () => {
    for (const path of ["/status", "/groups", "/nope"]) {
      expect(errorOf(await h.call(path, { key: null }))).toBe("unauthorized");
      expect(errorOf(await h.call(path, { key: WRONG }))).toBe("unauthorized");
    }
    const basic = await h.call("/status", { key: null, headers: { Authorization: "Basic abc" } });
    expect(basic.status).toBe(401);
    const empty = await h.call("/status", { key: null, headers: { Authorization: "Bearer " } });
    expect(empty.status).toBe(401);
    const post = await h.call("/send", { method: "POST", key: WRONG, body: { to: ALICE, message: "x" } });
    expect(post.status).toBe(401);
    expect(post.headers.get("www-authenticate")).toBe("Bearer");
  });

  it("accepts a lower-case bearer scheme", async () => {
    const r = await h.call("/status", { key: null, headers: { Authorization: `bearer ${KEY}` } });
    expect(r.status).toBe(200);
  });

  it("uses the socket address by default", async () => {
    const client = new FakeWhatsAppClient({ state: "open" });
    const server = createApiServer({
      client,
      queue: new SendQueue(client, { perMinute: 5 }),
      options: { apiKey: KEY, allowedTargets: [] },
      ipFilter: { isAllowed: (a) => a === "127.0.0.1" || a === "::ffff:127.0.0.1" },
      logger: logger([]),
      version: "1",
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  });
});

describe("routing", () => {
  it("404 for unknown routes and 405 for wrong methods", async () => {
    const nf = await h.call("/nope");
    expect(nf.status).toBe(404);
    expect(nf.json).toEqual({ error: { code: "not_found", message: expect.any(String) } });
    for (const [path, method, allow] of [
      ["/health", "POST", "GET"],
      ["/status", "POST", "GET"],
      ["/groups", "DELETE", "GET"],
      ["/send", "GET", "POST"],
    ] as const) {
      const r = await h.call(path, { method });
      expect(r.status).toBe(405);
      expect(errorOf(r)).toBe("method_not_allowed");
      expect(r.headers.get("allow")).toBe(allow);
    }
  });

  it("tolerates a trailing slash", async () => {
    expect((await h.call("/status/")).status).toBe(200);
  });
});

describe("GET /health and /status", () => {
  it("health needs no auth", async () => {
    const r = await h.call("/health", { key: null });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true });
    expect(r.headers.get("content-type")).toBe("application/json; charset=utf-8");
  });

  it("reports an open connection", async () => {
    h.client.setState("open", { me: { jid: ALICE_JID, name: "Gateway" } });
    const r = await h.call("/status");
    expect(r.status).toBe(200);
    expect(Object.keys(r.json)).toEqual(["state", "connected", "me", "pairing", "last_error", "since", "version"]);
    expect(r.json).toMatchObject({
      state: "open",
      connected: true,
      me: { jid: ALICE_JID, name: "Gateway" },
      pairing: null,
      last_error: null,
      version: "9.9.9",
    });
    expect(typeof r.json.since).toBe("string");
  });

  it("has me null before linking and omits a missing name", async () => {
    expect((await h.call("/status")).json.me).toBeNull();
    h.client.setState("open", { me: { jid: ALICE_JID } });
    expect((await h.call("/status")).json.me).toEqual({ jid: ALICE_JID });
  });

  it("exposes a pairing code but never the raw QR", async () => {
    h.client.setState("pairing", { pairing: { code: "ABCD-EFGH" }, lastError: "boom" });
    let r = await h.call("/status");
    expect(r.json.pairing).toEqual({ code: "ABCD-EFGH" });
    expect(r.json.last_error).toBe("boom");

    h.client.setState("pairing", { pairing: { qr: "2@SECRETQRSTRING" } });
    r = await h.call("/status");
    expect(r.json.pairing).toEqual({ qr: true });
    expect(JSON.stringify(r.json)).not.toContain("SECRETQR");
    expect(r.json.connected).toBe(false);
  });
});

describe("GET /groups", () => {
  it("returns member groups sorted case-insensitively", async () => {
    const r = await h.call("/groups");
    expect(r.status).toBe(200);
    expect(r.json).toEqual({
      groups: [
        { jid: FAMILY, name: "Family", participants: 5 },
        { jid: CLUB, name: "garden Club", participants: 12 },
      ],
      refreshed: false,
    });
  });

  it("works while disconnected without refresh", async () => {
    h.client.setState("closed");
    expect((await h.call("/groups")).status).toBe(200);
  });

  it("refresh=true fetches, then reports the cooldown", async () => {
    h.client.setRefreshResult([{ jid: FAMILY, name: "Family", participants: 6, isMember: true }]);
    let r = await h.call("/groups?refresh=true");
    expect(r.json).toEqual({ groups: [{ jid: FAMILY, name: "Family", participants: 6 }], refreshed: true });
    expect(h.client.refreshCount).toBe(1);

    h.clock.t += 30_000;
    r = await h.call("/groups?refresh=true");
    expect(r.json.refreshed).toBe(false);
    expect(h.client.refreshCount).toBe(1);

    h.clock.t += 31_000;
    r = await h.call("/groups?refresh=true");
    expect(r.json.refreshed).toBe(true);
    expect(h.client.refreshCount).toBe(2);
  });

  it("refresh=true while not connected is 503", async () => {
    h.client.setState("closed");
    const r = await h.call("/groups?refresh=true");
    expect(r.status).toBe(503);
    expect(errorOf(r)).toBe("not_connected");
  });

  it("treats other refresh values as no refresh", async () => {
    const r = await h.call("/groups?refresh=1");
    expect(r.json.refreshed).toBe(false);
    expect(h.client.refreshCount).toBe(0);
  });
});

describe("POST /send validation", () => {
  const post = (body: unknown) => h.call("/send", { method: "POST", body });

  it.each([
    ["non-object body", [1]],
    ["missing to", { message: "x" }],
    ["bad to type", { to: 5, message: "x" }],
    ["empty to", { to: [], message: "x" }],
    ["too many targets", { to: Array.from({ length: 21 }, () => ALICE), message: "x" }],
    ["non-string target", { to: [ALICE, 3], message: "x" }],
    ["no message or media", { to: ALICE }],
    ["empty message", { to: ALICE, message: "" }],
    ["message not a string", { to: ALICE, message: 4 }],
    ["message too long", { to: ALICE, message: "a".repeat(4097) }],
    ["image and document", { to: ALICE, image: { base64: "AA==" }, document: { base64: "AA==", filename: "a" } }],
    ["image not object", { to: ALICE, image: "x" }],
    ["image with both sources", { to: ALICE, image: { url: "http://a.example/x.png", base64: "AA==" } }],
    ["image with no source", { to: ALICE, image: {} }],
    ["image bad url type", { to: ALICE, image: { url: 3 } }],
    ["image non-http url", { to: ALICE, image: { url: "file:///etc/passwd" } }],
    ["image unparsable url", { to: ALICE, image: { url: "not a url" } }],
    ["image bad base64 type", { to: ALICE, image: { base64: 3 } }],
    ["image caption too long", { to: ALICE, image: { base64: "AA==", caption: "a".repeat(1025) } }],
    ["image caption type", { to: ALICE, image: { base64: "AA==", caption: 1 } }],
    ["document without filename", { to: ALICE, document: { base64: "AA==" } }],
    ["document bad mimetype", { to: ALICE, document: { base64: "AA==", filename: "a", mimetype: 3 } }],
  ])("400 invalid_request: %s", async (_name, body) => {
    const r = await post(body);
    expect(r.status).toBe(400);
    expect(errorOf(r)).toBe("invalid_request");
    expect(h.client.sent).toHaveLength(0);
  });

  it("400 for malformed JSON without echoing the body", async () => {
    const r = await h.call("/send", { method: "POST", raw: '{"to": "secret-text", ' });
    expect(r.status).toBe(400);
    expect(errorOf(r)).toBe("invalid_request");
    expect(JSON.stringify(r.json)).not.toContain("secret-text");
  });

  it("validation precedes the connection check", async () => {
    h.client.setState("closed");
    expect((await post({ to: [] })).status).toBe(400);
  });

  it("413 for a declared body over 24 MiB", async () => {
    const r = await h.call("/send", { method: "POST", raw: "x".repeat(MAX_BODY_BYTES + 1) });
    expect(r.status).toBe(413);
    expect(errorOf(r)).toBe("payload_too_large");
  });

  it("413 for a chunked body over 24 MiB", async () => {
    const url = new URL(h.base + "/send");
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        { host: url.hostname, port: url.port, path: url.pathname, method: "POST", headers: { Authorization: `Bearer ${KEY}` } },
        (res: IncomingMessage) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on("error", reject);
      const chunk = Buffer.alloc(1024 * 1024, 97);
      for (let i = 0; i < 25; i++) req.write(chunk);
      req.end();
    });
    expect(status).toBe(413);
  });
});

describe("POST /send processing", () => {
  const post = (body: unknown) => h.call("/send", { method: "POST", body });

  it("503 not_connected before resolving targets or loading media", async () => {
    h.client.setState("closed");
    let fetched = false;
    fetchStub = (async () => {
      fetched = true;
      return new Response("x");
    }) as typeof fetch;
    await closeServer(h.server);
    h = await setup({ state: "closed" });
    const r = await h.call("/send", { method: "POST", body: { to: "bad target!", message: "x", image: { url: "http://a.example/i.png" } } });
    expect(r.status).toBe(503);
    expect(errorOf(r)).toBe("not_connected");
    expect(fetched).toBe(false);
  });

  it("sends text to several targets in input order", async () => {
    const r = await post({ to: [ALICE, "group:family", CLUB], message: "Front door opened" });
    expect(r.status).toBe(200);
    expect(r.json.results).toEqual([
      { to: ALICE, jid: ALICE_JID, id: "FAKE00000001" },
      { to: "group:family", jid: FAMILY, id: "FAKE00000002" },
      { to: CLUB, jid: CLUB, id: "FAKE00000003" },
    ]);
    expect(h.client.sent.map((s) => s.jid)).toEqual([ALICE_JID, FAMILY, CLUB]);
    expect(h.client.sent[0]?.content).toEqual({ kind: "text", text: "Front door opened" });
  });

  it("accepts a single string target", async () => {
    const r = await post({ to: ALICE, message: "hi" });
    expect(r.json.results).toHaveLength(1);
  });

  it("deduplicates targets that resolve to the same JID and shares the outcome", async () => {
    const r = await post({ to: [ALICE, "15555550123@c.us", "+1 555 555 0123", "group:Family"], message: "hi" });
    expect(r.json.results.map((x: any) => x.id)).toEqual(["FAKE00000001", "FAKE00000001", "FAKE00000001", "FAKE00000002"]);
    expect(h.client.sent).toHaveLength(2);
  });

  it("reports per-target resolution errors with suggestions, keeping order", async () => {
    const r = await post({ to: ["nonsense", "group:Famly", `999@g.us`, "group:Garden", ALICE], message: "hi" });
    expect(r.status).toBe(200);
    const [bad, typo, notMember, garden, ok] = r.json.results;
    expect(bad).toEqual({ to: "nonsense", error: { code: "invalid_target", message: expect.any(String) } });
    expect(typo.error.code).toBe("unknown_group");
    expect(typo.error.suggestions).toEqual([`Family (${FAMILY})`]);
    expect(typo.jid).toBeUndefined();
    expect(notMember.error.code).toBe("not_a_member");
    expect(garden.error.code).toBe("unknown_group");
    expect(ok.id).toBeTruthy();
  });

  it("reports ambiguous groups", async () => {
    h.client.setGroups([
      { jid: FAMILY, name: "Same", participants: 1, isMember: true },
      { jid: CLUB, name: "same", participants: 1, isMember: true },
    ]);
    const r = await post({ to: "group:Same", message: "hi" });
    expect(r.json.results[0].error.code).toBe("ambiguous_group");
    expect(r.json.results[0].error.suggestions).toHaveLength(2);
  });

  it("enforces allowed_targets per target", async () => {
    await closeServer(h.server);
    allowed = [ALICE, "group:Family"];
    h = await setup();
    const r = await h.call("/send", { method: "POST", body: { to: ["+15555550124", ALICE, CLUB, "group:Family"], message: "hi" } });
    expect(r.status).toBe(200);
    expect(r.json.results[0]).toEqual({
      to: "+15555550124",
      jid: BOB_JID,
      error: { code: "target_not_allowed", message: expect.any(String) },
    });
    expect(r.json.results[2].error.code).toBe("target_not_allowed");
    expect(r.json.results[1].id).toBeTruthy();
    expect(r.json.results[3].id).toBeTruthy();
    expect(h.client.sent.map((s) => s.jid)).toEqual([ALICE_JID, FAMILY]);
  });

  it("maps queue and send errors to per-target errors", async () => {
    await closeServer(h.server);
    queueOverride = {
      enqueue: async (jid) => {
        if (jid === ALICE_JID) throw new QueueError("queue_full", "Send queue is full");
        if (jid === BOB_JID) throw new QueueError("timeout", "too slow");
        if (jid === FAMILY) throw new Error("kaboom");
        return { id: "OK1" };
      },
    };
    h = await setup();
    const r = await h.call("/send", { method: "POST", body: { to: [ALICE, "+15555550124", FAMILY, CLUB], message: "hi" } });
    expect(r.json.results.map((x: any) => x.error?.code ?? x.id)).toEqual(["queue_full", "timeout", "send_failed", "OK1"]);
    expect(JSON.stringify(r.json)).not.toContain("kaboom");
  });

  it("reports a failing client send as send_failed", async () => {
    h.client.failNextSend(new Error("socket exploded"));
    const r = await h.call("/send", { method: "POST", body: { to: [ALICE, "+15555550124"], message: "hi" } });
    expect(r.json.results[0].error).toEqual({ code: "send_failed", message: "socket exploded" });
    expect(r.json.results[1].id).toBeTruthy();
  });

  it("sends an image from base64 using the message as caption", async () => {
    const r = await post({ to: ALICE, message: "Front door", image: { base64: PNG.toString("base64") } });
    expect(r.status).toBe(200);
    expect(h.client.sent).toHaveLength(1);
    expect(h.client.sent[0]?.content).toMatchObject({ kind: "image", mimetype: "image/png", caption: "Front door" });
  });

  it("sends text first then media with its own caption; last id is reported", async () => {
    const r = await post({ to: ALICE, message: "Alert", image: { base64: PNG.toString("base64"), caption: "Door" } });
    expect(h.client.sent.map((s) => s.content.kind)).toEqual(["text", "image"]);
    expect(h.client.sent[1]?.content).toMatchObject({ caption: "Door" });
    expect(r.json.results[0].id).toBe("FAKE00000002");
  });

  it("sends an image with a caption and no message as a single send", async () => {
    await post({ to: ALICE, image: { base64: PNG.toString("base64"), caption: "Only" } });
    expect(h.client.sent).toHaveLength(1);
    expect(h.client.sent[0]?.content).toMatchObject({ caption: "Only" });
  });

  it("omits the caption when none is available", async () => {
    await post({ to: ALICE, image: { base64: PNG.toString("base64") } });
    expect((h.client.sent[0]?.content as any).caption).toBeUndefined();
  });

  it("skips the media if the text send fails", async () => {
    h.client.failNextSend(new Error("nope"));
    const r = await post({ to: ALICE, message: "a", image: { base64: PNG.toString("base64"), caption: "b" } });
    expect(r.json.results[0].error.code).toBe("send_failed");
    expect(h.client.sent).toHaveLength(0);
  });

  it("sends a document with defaults and sanitised filename", async () => {
    const data = Buffer.from("%PDF-1.4").toString("base64");
    await post({ to: ALICE, message: "Report", document: { base64: data, filename: "a/b\\report.pdf" } });
    expect(h.client.sent[0]?.content).toMatchObject({
      kind: "document",
      mimetype: "application/octet-stream",
      filename: "abreport.pdf",
      caption: "Report",
    });
    await post({ to: ALICE, document: { base64: data, filename: "r.pdf", mimetype: "application/pdf", caption: "C" } });
    expect(h.client.sent[1]?.content).toMatchObject({ mimetype: "application/pdf", caption: "C" });
  });

  it("loads media once for many targets", async () => {
    let calls = 0;
    await closeServer(h.server);
    fetchStub = (async () => {
      calls += 1;
      return new Response(PNG, { status: 200, headers: { "content-type": "image/png" } });
    }) as typeof fetch;
    h = await setup();
    const r = await h.call("/send", {
      method: "POST",
      body: { to: [ALICE, "+15555550124", FAMILY], image: { url: "http://homeassistant:8123/cam?token=abc" } },
    });
    expect(r.json.results).toHaveLength(3);
    expect(calls).toBe(1);
    expect(h.client.sent).toHaveLength(3);
  });

  it("maps media failures to 413, 415 and 422", async () => {
    const big = await post({ to: ALICE, image: { base64: Buffer.alloc(16 * 1024 * 1024 + 10, 1).toString("base64") } });
    expect(big.status).toBe(413);
    expect(errorOf(big)).toBe("payload_too_large");

    const unsupported = await post({ to: ALICE, image: { base64: Buffer.from("plain text").toString("base64") } });
    expect(unsupported.status).toBe(415);
    expect(errorOf(unsupported)).toBe("unsupported_media");

    await closeServer(h.server);
    fetchStub = (async () => new Response("no", { status: 404 })) as typeof fetch;
    h = await setup();
    const failed = await h.call("/send", { method: "POST", body: { to: ALICE, image: { url: "http://a.example/x.png" } } });
    expect(failed.status).toBe(422);
    expect(errorOf(failed)).toBe("media_fetch_failed");
    expect(h.client.sent).toHaveLength(0);
  });

  it("500 internal_error for unexpected failures, without leaking details", async () => {
    await closeServer(h.server);
    fetchStub = (async () => {
      throw new Error("x");
    }) as typeof fetch;
    h = await setup();
    // A client whose groups() throws triggers the generic handler.
    h.client.groups = () => {
      throw new Error("internal secret detail");
    };
    const r = await h.call("/send", { method: "POST", body: { to: ALICE, message: "hi" } });
    expect(r.status).toBe(500);
    expect(errorOf(r)).toBe("internal_error");
    expect(JSON.stringify(r.json)).not.toContain("secret detail");
    expect(h.logs.some((l) => l.startsWith("error "))).toBe(true);
  });
});

describe("logging", () => {
  it("never logs the key, auth header, message body, URLs or full JIDs", async () => {
    const body = "TOP-SECRET-MESSAGE-BODY";
    await h.call("/send", {
      method: "POST",
      body: { to: [ALICE, "group:Family"], message: body, image: { base64: PNG.toString("base64"), caption: "TOP-SECRET-CAPTION" } },
    });
    await h.call("/status", { key: WRONG });
    await h.call("/send", { method: "POST", raw: "{bad TOP-SECRET-MESSAGE-BODY" });
    const all = h.logs.join("\n");
    expect(all).not.toContain(KEY);
    expect(all).not.toContain(WRONG);
    expect(all).not.toContain("Bearer");
    expect(all).not.toContain("TOP-SECRET");
    expect(all).not.toContain(ALICE_JID);
    expect(all).toContain("1555****123@s.whatsapp.net");
  });
});
