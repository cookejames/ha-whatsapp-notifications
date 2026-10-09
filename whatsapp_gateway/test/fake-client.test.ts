import { describe, expect, it } from "vitest";
import { NotConnectedError, SendError, type ClientStatus } from "../src/client.js";
import { FakeWhatsAppClient } from "../src/fake-client.js";

const fixed = () => new Date("2026-01-01T12:00:00.000Z");
const text = { kind: "text", text: "hello" } as const;

describe("FakeWhatsAppClient", () => {
  it("starts in the starting state and opens on start()", async () => {
    const c = new FakeWhatsAppClient({ now: fixed });
    expect(c.status()).toEqual({ state: "starting", connected: false, since: "2026-01-01T12:00:00.000Z" });
    await c.start();
    expect(c.status().state).toBe("open");
    expect(c.status().connected).toBe(true);
  });

  it("rejects send when not connected", async () => {
    const c = new FakeWhatsAppClient({ state: "closed" });
    await expect(c.send("15555550123@s.whatsapp.net", text)).rejects.toBeInstanceOf(NotConnectedError);
    expect(c.sent).toHaveLength(0);
  });

  it("records sends with sequential ids", async () => {
    const c = new FakeWhatsAppClient({ state: "open" });
    const a = await c.send("15555550123@s.whatsapp.net", text);
    const b = await c.send("120363000000000000@g.us", text);
    expect(a.id).not.toBe(b.id);
    expect(c.sent.map((s) => s.jid)).toEqual(["15555550123@s.whatsapp.net", "120363000000000000@g.us"]);
    expect(c.sent[0]?.id).toBe(a.id);
  });

  it("fails only the next send", async () => {
    const c = new FakeWhatsAppClient({ state: "open" });
    c.failNextSend();
    await expect(c.send("15555550123@s.whatsapp.net", text)).rejects.toBeInstanceOf(SendError);
    await expect(c.send("15555550123@s.whatsapp.net", text)).resolves.toHaveProperty("id");
    expect(c.sent).toHaveLength(1);
  });

  it("supports a custom failure error", async () => {
    const c = new FakeWhatsAppClient({ state: "open" });
    c.failNextSend(new Error("boom"));
    await expect(c.send("x", text)).rejects.toThrow("boom");
  });

  it("returns copies of settable groups and applies refresh results", async () => {
    const c = new FakeWhatsAppClient({ state: "open" });
    c.setGroups([{ jid: "120363000000000000@g.us", name: "Family", participants: 5, isMember: true }]);
    const g = c.groups();
    g[0]!.name = "changed";
    expect(c.groups()[0]?.name).toBe("Family");

    c.setRefreshResult([{ jid: "120363000000000001@g.us", name: "Garden Club", participants: 12, isMember: true }]);
    expect(c.groups()).toHaveLength(1);
    const refreshed = await c.refreshGroups();
    expect(refreshed[0]?.name).toBe("Garden Club");
    expect(c.refreshCount).toBe(1);
  });

  it("emits status events on state changes", async () => {
    const c = new FakeWhatsAppClient({ now: fixed });
    const seen: ClientStatus[] = [];
    c.on("status", (s) => seen.push(s));
    c.setState("pairing", { pairing: { code: "ABCD-EFGH" } });
    c.setState("open", { me: { jid: "15555550123@s.whatsapp.net", name: "Alice" } });
    await c.stop();
    expect(seen.map((s) => s.state)).toEqual(["pairing", "open", "closed"]);
    expect(seen[0]?.pairing).toEqual({ code: "ABCD-EFGH" });
    expect(seen[1]?.me?.jid).toBe("15555550123@s.whatsapp.net");
    expect(seen[1]?.pairing).toBeUndefined();
    expect(seen[2]?.connected).toBe(false);
  });

  it("keeps me across reopen and records lastError", () => {
    const c = new FakeWhatsAppClient();
    c.setState("open", { me: { jid: "15555550123@s.whatsapp.net" } });
    c.setState("connecting");
    c.setState("open");
    expect(c.status().me?.jid).toBe("15555550123@s.whatsapp.net");
    c.setState("closed", { lastError: "network" });
    expect(c.status().lastError).toBe("network");
  });

  it("ignores listeners for unknown events", () => {
    const c = new FakeWhatsAppClient();
    // @ts-expect-error unsupported event
    expect(() => c.on("other", () => undefined)).not.toThrow();
  });
});
