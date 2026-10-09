import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuthenticationState, BaileysEventMap, GroupMetadata, WAVersion } from "@whiskeysockets/baileys";
import { pino } from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NotConnectedError, SendError, type ClientStatus } from "../src/client.js";
import { GroupCache } from "../src/groups.js";
import {
  BaileysClient,
  buildSocketConfig,
  FALLBACK_WA_VERSION,
  type SocketFactory,
  type SocketLike,
  type SocketParams,
} from "../src/whatsapp.js";

const G1 = "120363000000000000@g.us";
const ALICE = "15555550123@s.whatsapp.net";
const BOB = "15555550124@s.whatsapp.net";
const CODE = "ABCD1234";

type Handler = (arg: never) => void;

class FakeSocket implements SocketLike {
  handlers = new Map<string, Handler[]>();
  ended = 0;
  /** When true, removeAllListeners does nothing so tests can emit stale events. */
  leaky = false;
  authState: { creds: { registered?: boolean } };
  user: SocketLike["user"] = { id: "15555550123:4@s.whatsapp.net", lid: "100000000000000:4@lid", name: "Alice" };
  requestPairingCode = vi.fn(async (_phone: string) => CODE);
  sendMessage = vi.fn(async (_jid: string, _content: unknown): Promise<{ key?: { id?: string | null } } | undefined> => ({
    key: { id: "MSG1" },
  }));
  groupFetchAllParticipating = vi.fn(async (): Promise<Record<string, GroupMetadata>> => ({}));

  constructor(
    readonly params: SocketParams,
    registered: boolean,
  ) {
    this.authState = { creds: { registered } };
  }

  ev = {
    on: (event: string, listener: Handler) => {
      this.handlers.set(event, [...(this.handlers.get(event) ?? []), listener]);
    },
    removeAllListeners: (event: string) => {
      if (!this.leaky) this.handlers.delete(event);
    },
  } as unknown as SocketLike["ev"];

  end() {
    this.ended += 1;
  }

  emit<T extends keyof BaileysEventMap>(event: T, arg: BaileysEventMap[T]) {
    for (const h of this.handlers.get(event) ?? []) (h as (a: unknown) => void)(arg);
  }

  close(statusCode?: number) {
    const error = statusCode === undefined ? new Error("closed") : Object.assign(new Error("closed"), { output: { statusCode } });
    this.emit("connection.update", { connection: "close", lastDisconnect: { error, date: new Date() } });
  }

  open() {
    this.emit("connection.update", { connection: "open" });
  }
}

const silent = pino({ level: "silent" });

interface Harness {
  client: BaileysClient;
  sockets: FakeSocket[];
  states: ClientStatus[];
  groups: GroupCache;
  saveCreds: ReturnType<typeof vi.fn>;
  fetchVersion: ReturnType<typeof vi.fn>;
  last: () => FakeSocket;
}

function harness(
  opts: { registered?: boolean; phone?: string; random?: () => number; dataDir?: string } = {},
): Harness {
  const sockets: FakeSocket[] = [];
  const registered = opts.registered ?? false;
  const factory: SocketFactory = (params) => {
    const s = new FakeSocket(params, registered);
    sockets.push(s);
    return s;
  };
  const saveCreds = vi.fn(async () => undefined);
  const fetchVersion = vi.fn(async () => ({ version: [2, 3000, 1] as WAVersion }));
  const groups = new GroupCache();
  const client = new BaileysClient({
    dataDir: opts.dataDir ?? "/nonexistent-data-dir",
    pairingPhoneNumber: opts.phone,
    logger: silent,
    socketFactory: factory,
    deps: {
      loadAuth: async () => ({ state: { creds: {}, keys: {} } as unknown as AuthenticationState, saveCreds }),
      fetchVersion,
      random: opts.random ?? (() => 0.5),
      groups,
    },
  });
  const states: ClientStatus[] = [];
  client.on("status", (s) => states.push(s));
  return {
    client,
    sockets,
    states,
    groups,
    saveCreds,
    fetchVersion,
    last: () => sockets[sockets.length - 1] as FakeSocket,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("socket options and WA version", () => {
  it("uses exactly the spec section 3.5 options", async () => {
    const params: SocketParams = {
      version: [1, 2, 3],
      auth: {} as AuthenticationState,
      logger: silent,
      cachedGroupMetadata: async () => undefined,
    };
    const cfg = buildSocketConfig(params);
    expect(cfg).toMatchObject({
      version: [1, 2, 3],
      markOnlineOnConnect: false,
      syncFullHistory: false,
      defaultQueryTimeoutMs: 60_000,
      generateHighQualityLinkPreview: false,
    });
    expect(cfg.browser?.[1]).toBe("Chrome");
    expect(cfg.shouldSyncHistoryMessage?.({} as never)).toBe(false);
    expect(cfg.cachedGroupMetadata).toBe(params.cachedGroupMetadata);
  });

  it("passes a cachedGroupMetadata backed by the group cache and a warn-level logger", async () => {
    const h = harness({ registered: true });
    h.groups.applyFetch({ [G1]: { id: G1, subject: "Family", owner: undefined, participants: [] } });
    await h.client.start();
    const params = h.last().params;
    expect((await params.cachedGroupMetadata(G1))?.subject).toBe("Family");
    expect(await params.cachedGroupMetadata("x@g.us")).toBeUndefined();
    expect(params.logger.level).toBe("warn");
    expect(params.version).toEqual([2, 3000, 1]);
  });

  it("caches the fetched version for 6 hours", async () => {
    const h = harness({ registered: true });
    await h.client.start();
    h.last().close(500);
    await vi.advanceTimersByTimeAsync(5 * 3600_000);
    expect(h.sockets).toHaveLength(2);
    expect(h.fetchVersion).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2 * 3600_000);
    h.last().close(500);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.sockets).toHaveLength(3);
    expect(h.fetchVersion).toHaveBeenCalledTimes(2);
  });

  it("falls back to FALLBACK_WA_VERSION when the lookup reports an error or throws, without caching it", async () => {
    const h = harness({ registered: true });
    h.fetchVersion.mockResolvedValueOnce({ version: [9, 9, 9], error: new Error("offline") });
    await h.client.start();
    expect(h.last().params.version).toEqual(FALLBACK_WA_VERSION);
    h.last().close(500);
    h.fetchVersion.mockRejectedValueOnce(new Error("boom"));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.last().params.version).toEqual(FALLBACK_WA_VERSION);
    h.last().close(500);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(h.last().params.version).toEqual([2, 3000, 1]);
  });
});

describe("connection lifecycle", () => {
  it("emits a status event on every state change and goes open with the account", async () => {
    const h = harness({ registered: true });
    expect(h.client.status().state).toBe("starting");
    await h.client.start();
    h.last().open();
    expect(h.states.map((s) => s.state)).toEqual(["connecting", "open"]);
    const s = h.client.status();
    expect(s.connected).toBe(true);
    expect(s.me).toEqual({ jid: ALICE, name: "Alice" });
    h.last().close(500);
    expect(h.states.map((x) => x.state)).toEqual(["connecting", "open", "closed"]);
    expect(h.client.status().connected).toBe(false);
  });

  it("start() is idempotent and a throwing status listener does not break the client", async () => {
    const h = harness({ registered: true });
    h.client.on("status", () => {
      throw new Error("listener");
    });
    await h.client.start();
    await h.client.start();
    expect(h.sockets).toHaveLength(1);
  });

  it("shows QR strings as pairing info when no phone number is set", async () => {
    const h = harness();
    await h.client.start();
    h.last().emit("connection.update", { qr: "QR-STRING-1" });
    expect(h.client.status()).toMatchObject({ state: "pairing", pairing: { qr: "QR-STRING-1" } });
    h.last().emit("connection.update", { qr: "QR-STRING-2" });
    expect(h.client.status().pairing?.qr).toBe("QR-STRING-2");
    expect(h.last().requestPairingCode).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.last().requestPairingCode).not.toHaveBeenCalled();
  });

  it("ignores QR strings when a pairing phone number is set", async () => {
    const h = harness({ phone: "+15555550123" });
    await h.client.start();
    h.last().emit("connection.update", { qr: "QR" });
    expect(h.client.status().state).toBe("connecting");
  });

  it("clears pairing info once open and keeps lastError only until then", async () => {
    const h = harness();
    await h.client.start();
    h.last().emit("connection.update", { qr: "QR" });
    h.last().close(500);
    expect(h.client.status().lastError).toBe("closed");
    expect(h.client.status().pairing).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1_000);
    h.last().open();
    expect(h.client.status().pairing).toBeUndefined();
    expect(h.client.status().lastError).toBeUndefined();
  });

  it("retries after a socket factory failure", async () => {
    const h = harness({ registered: true });
    let calls = 0;
    const client = new BaileysClient({
      dataDir: "/nonexistent-data-dir",
      logger: silent,
      socketFactory: (p) => {
        calls += 1;
        if (calls === 1) throw new Error("factory failed");
        return new FakeSocket(p, true);
      },
      deps: {
        loadAuth: async () => ({ state: {} as AuthenticationState, saveCreds: async () => undefined }),
        fetchVersion: async () => ({ version: [1, 1, 1] }),
        random: () => 0.5,
        groups: new GroupCache(),
      },
    });
    await client.start();
    expect(client.status()).toMatchObject({ state: "closed", lastError: "factory failed" });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls).toBe(2);
    expect(client.status().state).toBe("connecting");
    expect(h.sockets).toHaveLength(0);
  });

  it("saves credentials on creds.update and never subscribes to message events", async () => {
    const h = harness({ registered: true });
    await h.client.start();
    h.last().emit("creds.update", {});
    expect(h.saveCreds).toHaveBeenCalledTimes(1);
    h.saveCreds.mockRejectedValueOnce(new Error("disk"));
    h.last().emit("creds.update", {});
    await vi.advanceTimersByTimeAsync(0);
    expect([...h.last().handlers.keys()].sort()).toEqual([
      "connection.update",
      "creds.update",
      "group-participants.update",
      "groups.update",
      "groups.upsert",
    ]);
  });

  it("stop() ends the socket, cancels reconnects and reports closed", async () => {
    const h = harness({ registered: true });
    await h.client.start();
    const sock = h.last();
    h.last().open();
    await h.client.stop();
    expect(sock.ended).toBe(1);
    expect(h.client.status().state).toBe("closed");
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.sockets).toHaveLength(1);
  });

  it("stop() while a reconnect is pending prevents the reconnect", async () => {
    const h = harness({ registered: true });
    await h.client.start();
    h.last().close(500);
    await h.client.stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.sockets).toHaveLength(1);
  });
});

describe("reconnect decisions", () => {
  it("401 logs out with no reconnect and keeps the auth dir", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wa-"));
    try {
      await mkdir(join(dir, "auth"));
      const h = harness({ registered: true, dataDir: dir });
      await h.client.start();
      h.last().close(401);
      expect(h.client.status().state).toBe("logged_out");
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(h.sockets).toHaveLength(1);
      expect((await stat(join(dir, "auth"))).isDirectory()).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("440 reconnects once after 30s, then stays in conflict", async () => {
    const h = harness({ registered: true });
    await h.client.start();
    h.last().close(440);
    expect(h.client.status().state).toBe("conflict");
    await vi.advanceTimersByTimeAsync(29_999);
    expect(h.sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.sockets).toHaveLength(2);
    expect(h.client.status().state).toBe("connecting");
    h.last().close(440);
    expect(h.client.status().state).toBe("conflict");
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(h.sockets).toHaveLength(2);
  });

  it("re-arms the single conflict retry after a successful open", async () => {
    const h = harness({ registered: true });
    await h.client.start();
    h.last().close(440);
    await vi.advanceTimersByTimeAsync(30_000);
    h.last().open();
    h.last().close(440);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.sockets).toHaveLength(3);
  });

  it("428 during pairing retries after min(2000 * attempt, 15000)", async () => {
    const h = harness();
    await h.client.start();
    const delays = [2000, 4000, 6000, 8000, 10000, 12000, 14000, 15000, 15000];
    for (const [i, d] of delays.entries()) {
      h.last().close(428);
      await vi.advanceTimersByTimeAsync(d - 1);
      expect(h.sockets, `attempt ${i + 1}`).toHaveLength(i + 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(h.sockets, `attempt ${i + 1}`).toHaveLength(i + 2);
    }
  });

  it("428 on a registered account uses the generic backoff", async () => {
    const h = harness({ registered: true });
    await h.client.start();
    h.last().close(428);
    await vi.advanceTimersByTimeAsync(999);
    expect(h.sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.sockets).toHaveLength(2);
  });

  it("other codes back off exponentially up to 60s and reset on open", async () => {
    const h = harness({ registered: true });
    await h.client.start();
    const delays = [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000];
    for (const [i, d] of delays.entries()) {
      h.last().close(i % 2 === 0 ? 500 : undefined);
      await vi.advanceTimersByTimeAsync(d - 1);
      expect(h.sockets, `attempt ${i}`).toHaveLength(i + 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(h.sockets, `attempt ${i}`).toHaveLength(i + 2);
    }
    h.last().open();
    h.last().close(515);
    await vi.advanceTimersByTimeAsync(999);
    expect(h.sockets).toHaveLength(9);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.sockets).toHaveLength(10);
  });

  it("applies +-20% jitter", async () => {
    for (const [random, expected] of [[0, 800], [1, 1200]] as const) {
      const h = harness({ registered: true, random: () => random });
      await h.client.start();
      h.last().close(500);
      await vi.advanceTimersByTimeAsync(expected - 1);
      expect(h.sockets).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(h.sockets).toHaveLength(2);
      await h.client.stop();
    }
  });
});

describe("generation counter", () => {
  it("a duplicate close from the same socket does not schedule a second reconnect", async () => {
    const h = harness({ registered: true });
    await h.client.start();
    const a = h.last();
    a.leaky = true;
    a.close(500);
    a.close(500);
    a.close(500);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.sockets).toHaveLength(2);
  });

  it("a stale socket's events cannot affect the new socket", async () => {
    const h = harness({ registered: true });
    await h.client.start();
    const a = h.last();
    a.leaky = true;
    a.close(500);
    await vi.advanceTimersByTimeAsync(1_000);
    const b = h.last();
    expect(b).not.toBe(a);
    b.open();
    expect(h.client.status().state).toBe("open");

    a.close(500);
    a.close(401);
    a.open();
    a.emit("creds.update", {});
    a.emit("groups.update", [{ id: G1, subject: "Nope" }]);
    await vi.advanceTimersByTimeAsync(120_000);

    expect(h.client.status().state).toBe("open");
    expect(h.sockets).toHaveLength(2);
    expect(h.saveCreds).not.toHaveBeenCalled();
    expect(b.ended).toBe(0);
  });

  it("a stale socket cannot be revived by its own pending pairing request", async () => {
    const h = harness({ phone: "+15555550123" });
    await h.client.start();
    const a = h.last();
    a.leaky = true;
    await vi.advanceTimersByTimeAsync(3_000);
    a.close(500);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.sockets).toHaveLength(2);
    expect(h.client.status().state).toBe("connecting");
  });
});

describe("pairing code", () => {
  it("requests a code about 3s after the socket starts and exposes it", async () => {
    const h = harness({ phone: "+15555550123" });
    await h.client.start();
    await vi.advanceTimersByTimeAsync(2_999);
    expect(h.last().requestPairingCode).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(h.last().requestPairingCode).toHaveBeenCalledWith("15555550123");
    expect(h.client.status()).toMatchObject({ state: "pairing", pairing: { code: CODE } });
  });

  it("does not request a code when the account is already registered", async () => {
    const h = harness({ registered: true, phone: "+15555550123" });
    await h.client.start();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.last().requestPairingCode).not.toHaveBeenCalled();
  });

  it("times out after 20s, ends the socket and reconnects with the pairing backoff", async () => {
    const h = harness({ phone: "+15555550123" });
    await h.client.start();
    const a = h.last();
    a.requestPairingCode.mockImplementation(() => new Promise<string>(() => undefined));
    await vi.advanceTimersByTimeAsync(3_000);
    await vi.advanceTimersByTimeAsync(19_999);
    expect(h.client.status().state).toBe("connecting");
    await vi.advanceTimersByTimeAsync(1);
    expect(h.client.status()).toMatchObject({ state: "closed", lastError: "Pairing code request timed out" });
    expect(a.ended).toBe(1);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(h.sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.sockets).toHaveLength(2);
  });

  it("treats a rejected request like a failure", async () => {
    const h = harness({ phone: "+15555550123" });
    await h.client.start();
    h.last().requestPairingCode.mockRejectedValue(new Error("rate limited"));
    await vi.advanceTimersByTimeAsync(3_000);
    expect(h.client.status()).toMatchObject({ state: "closed", lastError: "rate limited" });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.sockets).toHaveLength(2);
  });

  it("abandons the request when the socket closes during pairing, with a single reconnect", async () => {
    const h = harness({ phone: "+15555550123" });
    await h.client.start();
    const a = h.last();
    a.requestPairingCode.mockImplementation(() => new Promise<string>(() => undefined));
    await vi.advanceTimersByTimeAsync(3_000);
    a.close(428);
    expect(h.client.status().state).toBe("closed");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.sockets).toHaveLength(2);
    expect(h.client.status().state).toBe("connecting");
    expect(a.requestPairingCode).toHaveBeenCalledTimes(1);
  });

  it("does not start a pairing request if the socket closes within the 3s delay", async () => {
    const h = harness({ phone: "+15555550123" });
    await h.client.start();
    const a = h.last();
    a.close(500);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(a.requestPairingCode).not.toHaveBeenCalled();
    expect(h.sockets).toHaveLength(2);
  });

  it("goes open after pairing completes and the socket restarts (515)", async () => {
    const h = harness({ phone: "+15555550123" });
    await h.client.start();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(h.client.status().state).toBe("pairing");
    const a = h.last();
    a.authState.creds.registered = true;
    a.close(515);
    await vi.advanceTimersByTimeAsync(1_000);
    h.last().open();
    expect(h.client.status()).toMatchObject({ state: "open" });
    expect(h.client.status().pairing).toBeUndefined();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.last().requestPairingCode).not.toHaveBeenCalled();
  });
});

describe("send()", () => {
  async function openClient() {
    const h = harness({ registered: true });
    await h.client.start();
    h.last().open();
    return h;
  }

  it("throws NotConnectedError unless open", async () => {
    const h = harness({ registered: true });
    await expect(h.client.send(ALICE, { kind: "text", text: "hi" })).rejects.toBeInstanceOf(NotConnectedError);
    await h.client.start();
    await expect(h.client.send(ALICE, { kind: "text", text: "hi" })).rejects.toBeInstanceOf(NotConnectedError);
    h.last().open();
    h.last().close(500);
    await expect(h.client.send(ALICE, { kind: "text", text: "hi" })).rejects.toBeInstanceOf(NotConnectedError);
    expect(h.sockets[0]?.sendMessage).not.toHaveBeenCalled();
  });

  it("maps text, image and document content", async () => {
    const h = await openClient();
    const data = Buffer.from("bytes");
    expect(await h.client.send(ALICE, { kind: "text", text: "hello" })).toEqual({ id: "MSG1" });
    await h.client.send(G1, { kind: "image", data, mimetype: "image/png", caption: "cap" });
    await h.client.send(G1, { kind: "image", data, mimetype: "image/png" });
    await h.client.send(BOB, { kind: "document", data, mimetype: "application/pdf", filename: "a.pdf", caption: "d" });
    await h.client.send(BOB, { kind: "document", data, mimetype: "application/pdf", filename: "a.pdf" });
    expect(h.last().sendMessage.mock.calls).toEqual([
      [ALICE, { text: "hello" }],
      [G1, { image: data, mimetype: "image/png", caption: "cap" }],
      [G1, { image: data, mimetype: "image/png" }],
      [BOB, { document: data, mimetype: "application/pdf", fileName: "a.pdf", caption: "d" }],
      [BOB, { document: data, mimetype: "application/pdf", fileName: "a.pdf" }],
    ]);
  });

  it("wraps failures in SendError and requires a message id", async () => {
    const h = await openClient();
    h.last().sendMessage.mockRejectedValueOnce(new Error("rate-overlimit"));
    const err = await h.client.send(ALICE, { kind: "text", text: "secret body" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SendError);
    expect((err as Error).message).not.toContain("secret body");
    h.last().sendMessage.mockResolvedValueOnce(undefined);
    await expect(h.client.send(ALICE, { kind: "text", text: "x" })).rejects.toBeInstanceOf(SendError);
  });
});

describe("group wiring", () => {
  const fullMeta = (subject: string): GroupMetadata => ({
    id: G1,
    subject,
    owner: undefined,
    participants: [{ id: ALICE }, { id: BOB }],
  });

  it("fetches groups on open and serves them from the cache", async () => {
    const h = harness({ registered: true });
    await h.client.start();
    h.last().groupFetchAllParticipating.mockResolvedValue({ [G1]: fullMeta("Family") });
    h.last().open();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.last().groupFetchAllParticipating).toHaveBeenCalledTimes(1);
    expect(h.client.groups()).toEqual([{ jid: G1, name: "Family", participants: 2, isMember: true }]);
  });

  it("refreshGroups() goes through the cache cooldown", async () => {
    const h = harness({ registered: true });
    await h.client.start();
    h.last().groupFetchAllParticipating.mockResolvedValue({ [G1]: fullMeta("Family") });
    h.last().open();
    await vi.advanceTimersByTimeAsync(0);
    await h.client.refreshGroups();
    expect(h.last().groupFetchAllParticipating).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    h.last().groupFetchAllParticipating.mockResolvedValue({ [G1]: fullMeta("Family 2") });
    expect((await h.client.refreshGroups())[0]?.name).toBe("Family 2");
  });

  it("applies group events and schedules a debounced refresh", async () => {
    const h = harness({ registered: true });
    await h.client.start();
    h.last().groupFetchAllParticipating.mockResolvedValue({ [G1]: fullMeta("Family") });
    h.last().open();
    await vi.advanceTimersByTimeAsync(0);

    h.last().emit("groups.update", [{ id: G1, subject: "Renamed" }]);
    expect(h.client.groups()[0]?.name).toBe("Renamed");
    h.last().emit("groups.upsert", [fullMeta("Upserted")]);
    expect(h.client.groups()[0]?.name).toBe("Upserted");

    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.last().groupFetchAllParticipating).toHaveBeenCalledTimes(2);
  });

  it("marks the group non-member when the linked account is removed", async () => {
    const h = harness({ registered: true });
    await h.client.start();
    h.last().groupFetchAllParticipating.mockResolvedValue({ [G1]: fullMeta("Family") });
    h.last().open();
    await vi.advanceTimersByTimeAsync(0);
    h.last().emit("group-participants.update", {
      id: G1,
      author: BOB,
      action: "remove",
      participants: [{ id: "100000000000000@lid" }],
    });
    expect(h.client.groups()[0]?.isMember).toBe(false);
  });

  it("stops group timers when the socket goes away", async () => {
    const h = harness({ registered: true });
    await h.client.start();
    h.last().open();
    await vi.advanceTimersByTimeAsync(0);
    const a = h.last();
    a.close(401);
    await vi.advanceTimersByTimeAsync(7 * 3600_000);
    expect(a.groupFetchAllParticipating).toHaveBeenCalledTimes(1);
  });
});

describe("resetAuth()", () => {
  it("ends the socket, deletes the auth dir and restarts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wa-"));
    try {
      await mkdir(join(dir, "auth"));
      await writeFile(join(dir, "auth", "creds.json"), "{}");
      const h = harness({ registered: true, dataDir: dir });
      await h.client.start();
      h.last().close(401);
      expect(h.client.status().state).toBe("logged_out");
      await h.client.resetAuth();
      await expect(stat(join(dir, "auth"))).rejects.toThrow();
      expect(h.sockets).toHaveLength(2);
      expect(h.client.status().state).toBe("connecting");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("ends a live socket and cancels pending reconnects", async () => {
    const h = harness({ registered: true });
    await h.client.start();
    const a = h.last();
    await h.client.resetAuth();
    expect(a.ended).toBe(1);
    expect(h.sockets).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.sockets).toHaveLength(2);
  });
});
