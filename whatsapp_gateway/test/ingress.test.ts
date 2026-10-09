import type { AddressInfo } from "node:net";
import type http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeWhatsAppClient } from "../src/fake-client.js";
import { createIngressServer, type IngressIpFilter } from "../src/ingress.js";

const allowLoopback: IngressIpFilter = {
  isAllowed: (a) => a === "127.0.0.1" || a === "::1" || a === "::ffff:127.0.0.1",
};
const denyAll: IngressIpFilter = { isAllowed: () => false };
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

let server: http.Server | undefined;

async function closeServer(): Promise<void> {
  const s = server;
  server = undefined;
  if (s) await new Promise((r) => s.close(r));
}

async function start(
  opts: {
    client?: FakeWhatsAppClient;
    resetAuth?: () => Promise<void>;
    ipFilter?: IngressIpFilter;
    apiKeyConfigured?: boolean;
  } = {},
) {
  await closeServer();
  const client = opts.client ?? new FakeWhatsAppClient({ state: "open" });
  const resetAuth = opts.resetAuth ?? vi.fn(async () => {});
  const s = createIngressServer({
    client,
    resetAuth,
    ipFilter: opts.ipFilter ?? allowLoopback,
    logger,
    apiKeyConfigured: opts.apiKeyConfigured ?? true,
  });
  server = s;
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  return { client, resetAuth, base };
}

afterEach(async () => {
  await closeServer();
  vi.clearAllMocks();
});

const get = async (base: string, path = "/") => {
  const r = await fetch(base + path);
  return { status: r.status, body: await r.text() };
};

describe("ingress page", () => {
  it("renders open state with no refresh and advanced reset", async () => {
    const { base } = await start();
    const { status, body } = await get(base);
    expect(status).toBe(200);
    expect(body).toContain("open");
    expect(body).not.toContain('http-equiv="refresh"');
    expect(body).toContain("<details>");
    expect(body).not.toMatch(/(src|href)="https?:/);
  });

  it("renders pairing code and auto-refreshes", async () => {
    const client = new FakeWhatsAppClient({ state: "starting" });
    client.setState("pairing", { pairing: { code: "ABCD-EFGH" } });
    const { base } = await start({ client });
    const { body } = await get(base);
    expect(body).toContain("ABCD-EFGH");
    expect(body).toContain("Link with phone number instead");
    expect(body).toContain('http-equiv="refresh"');
  });

  it("renders QR as inline SVG", async () => {
    const client = new FakeWhatsAppClient({ state: "starting" });
    client.setState("pairing", { pairing: { qr: "2@fakeqrpayload" } });
    const { base } = await start({ client });
    const { body } = await get(base);
    expect(body).toContain("<svg");
    expect(body).toContain("scan this QR");
  });

  it("shows waiting text when pairing has no data", async () => {
    const client = new FakeWhatsAppClient({ state: "starting" });
    client.setState("pairing");
    const { base } = await start({ client });
    expect((await get(base)).body).toContain("Waiting for a pairing code");
  });

  it("auto-refreshes while connecting", async () => {
    const { base } = await start({ client: new FakeWhatsAppClient({ state: "connecting" }) });
    expect((await get(base)).body).toContain('http-equiv="refresh"');
  });

  it.each(["logged_out", "conflict"] as const)("shows prominent reset in %s", async (state) => {
    const { base } = await start({ client: new FakeWhatsAppClient({ state }) });
    const { body } = await get(base);
    expect(body).toContain('action="reset-pairing"');
    expect(body).not.toContain("<details>");
    expect(body).not.toContain('http-equiv="refresh"');
  });

  it("shows the API key warning only when not configured", async () => {
    const a = await start({ apiKeyConfigured: false });
    expect((await get(a.base)).body).toContain("API key missing");
    const b = await start({ apiKeyConfigured: true });
    expect((await get(b.base)).body).not.toContain("API key missing");
  });

  it("lists member groups sorted, escaped, with Copy JID", async () => {
    const client = new FakeWhatsAppClient({ state: "open" });
    client.setGroups([
      { jid: "2@g.us", name: "zeta", participants: 3, isMember: true },
      { jid: "1@g.us", name: "<script>alert(1)</script>", participants: 2, isMember: true },
      { jid: "3@g.us", name: "Alpha", participants: 5, isMember: true },
      { jid: "4@g.us", name: "LeftGroup", participants: 5, isMember: false },
    ]);
    client.setState("open", {
      lastError: "<b>boom</b>",
      me: { jid: "x@s.whatsapp.net", name: "<i>me</i>" },
    });
    const { base } = await start({ client });
    const { body } = await get(base);
    expect(body).not.toContain("<script>alert(1)");
    expect(body).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(body).not.toContain("<b>boom");
    expect(body).not.toContain("<i>me");
    expect(body).not.toContain("LeftGroup");
    expect(body.indexOf("Alpha")).toBeLessThan(body.indexOf("zeta"));
    expect(body).toContain('data-jid="3@g.us"');
    expect(body).toContain("Copy JID");
  });

  it("shows empty groups message", async () => {
    const { base } = await start();
    expect((await get(base)).body).toContain("No groups yet");
  });

  it("uses relative URLs only, regardless of X-Ingress-Path", async () => {
    const { base } = await start();
    const r = await fetch(base + "/", { headers: { "X-Ingress-Path": "/api/hassio_ingress/abc" } });
    const body = await r.text();
    expect(body).not.toContain("/api/hassio_ingress");
    expect(body).not.toMatch(/action="\//);
  });
});

describe("ingress actions", () => {
  it("refresh-groups calls through and redirects", async () => {
    const { base, client } = await start();
    const r = await fetch(base + "/refresh-groups", { method: "POST", redirect: "manual" });
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toBe("./");
    expect(client.refreshCount).toBe(1);
  });

  it("refresh-groups still redirects on error", async () => {
    const client = new FakeWhatsAppClient({ state: "open" });
    vi.spyOn(client, "refreshGroups").mockRejectedValue(new Error("cooldown"));
    const { base } = await start({ client });
    const r = await fetch(base + "/refresh-groups", { method: "POST", redirect: "manual" });
    expect(r.status).toBe(303);
    expect(logger.warn).toHaveBeenCalled();
  });

  it("reset-pairing calls resetAuth and redirects", async () => {
    const { base, resetAuth } = await start();
    const r = await fetch(base + "/reset-pairing", { method: "POST", redirect: "manual" });
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toBe("./");
    expect(resetAuth).toHaveBeenCalledTimes(1);
  });

  it("rejects wrong methods and unknown paths", async () => {
    const { base } = await start();
    expect((await fetch(base + "/reset-pairing")).status).toBe(405);
    expect((await fetch(base + "/", { method: "POST" })).status).toBe(405);
    expect((await fetch(base + "/nope")).status).toBe(404);
    expect((await fetch(base + "/", { method: "HEAD" })).status).toBe(200);
  });

  it("returns 500 if rendering fails", async () => {
    const client = new FakeWhatsAppClient({ state: "open" });
    vi.spyOn(client, "groups").mockImplementation(() => {
      throw new Error("bad");
    });
    const { base } = await start({ client });
    expect((await get(base)).status).toBe(500);
    expect(logger.error).toHaveBeenCalled();
  });
});

describe("ingress ip filter", () => {
  it("returns 403 from a denied address without acting", async () => {
    const { base, client, resetAuth } = await start({ ipFilter: denyAll });
    expect((await get(base)).status).toBe(403);
    const r = await fetch(base + "/reset-pairing", { method: "POST", redirect: "manual" });
    expect(r.status).toBe(403);
    await fetch(base + "/refresh-groups", { method: "POST" });
    expect(resetAuth).not.toHaveBeenCalled();
    expect(client.refreshCount).toBe(0);
  });
});
