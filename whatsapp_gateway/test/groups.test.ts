import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GroupMetadata } from "@whiskeysockets/baileys";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GroupCache } from "../src/groups.js";

const G1 = "120363000000000000@g.us";
const G2 = "120363000000000001@g.us";
const ALICE = "15555550123@s.whatsapp.net";
const BOB = "15555550124@s.whatsapp.net";

function meta(id: string, subject: string, members: string[] = [ALICE, BOB]): GroupMetadata {
  return { id, subject, owner: undefined, participants: members.map((m) => ({ id: m })) };
}

describe("GroupCache", () => {
  let dir: string;
  let clock: number;
  const now = () => clock;

  beforeEach(async () => {
    vi.useFakeTimers();
    clock = 1_000_000;
    dir = await mkdtemp(join(tmpdir(), "groups-"));
  });
  afterEach(async () => {
    vi.useRealTimers();
    await rm(dir, { recursive: true, force: true });
  });

  function makeCache(persist = false) {
    const cache = new GroupCache({ ...(persist ? { file: join(dir, "groups.json") } : {}), now });
    const fetcher = vi.fn(async () => ({ [G1]: meta(G1, "Family"), [G2]: meta(G2, "Garden Club", [ALICE]) }));
    cache.attach(fetcher);
    return { cache, fetcher };
  }

  it("applyFetch derives GroupInfo and serves metadata", () => {
    const cache = new GroupCache();
    cache.applyFetch({ [G1]: meta(G1, "Family") });
    expect(cache.list()).toEqual([{ jid: G1, name: "Family", participants: 2, isMember: true }]);
    expect(cache.metadata(G1)?.subject).toBe("Family");
    expect(cache.metadata(G2)).toBeUndefined();
  });

  it("flags groups missing from a later fetch as non-member but keeps them", () => {
    const cache = new GroupCache();
    cache.applyFetch({ [G1]: meta(G1, "Family"), [G2]: meta(G2, "Garden Club") });
    cache.applyFetch({ [G1]: meta(G1, "Family") });
    expect(cache.list().find((g) => g.jid === G2)?.isMember).toBe(false);
    expect(cache.metadata(G2)).toBeUndefined();
  });

  it("applyUpdate merges changes and ignores unknown partial groups", () => {
    const cache = new GroupCache();
    cache.applyFetch({ [G1]: meta(G1, "Family") });
    cache.applyUpdate([{ id: G1, subject: "Family 2" }, { id: G2, subject: "x" }, {}]);
    expect(cache.list()).toEqual([{ jid: G1, name: "Family 2", participants: 2, isMember: true }]);
    cache.applyUpdate([meta(G2, "Garden Club", [ALICE])]);
    expect(cache.list().map((g) => g.jid)).toEqual([G1, G2]);
  });

  it("applyUpdate updates persisted-only entries", async () => {
    await writeFile(join(dir, "groups.json"), JSON.stringify([{ jid: G1, name: "Old", participants: 1, isMember: true }]));
    const cache = new GroupCache({ file: join(dir, "groups.json") });
    await cache.load();
    cache.applyUpdate([{ id: G1, subject: "New", size: 4 }]);
    expect(cache.list()).toEqual([{ jid: G1, name: "New", participants: 4, isMember: true }]);
  });

  it("clears the member flag when the linked account is removed (any id form, any device)", () => {
    const cache = new GroupCache();
    cache.applyFetch({ [G1]: meta(G1, "Family") });
    const removed = cache.applyParticipants(
      {
        id: G1,
        action: "remove",
        participants: [{ id: "100000000000000@lid", phoneNumber: "15555550123:7@s.whatsapp.net" }],
      },
      ["15555550123:3@s.whatsapp.net"],
    );
    expect(removed).toBe(true);
    expect(cache.list()[0]?.isMember).toBe(false);
  });

  it("tracks other participants being added and removed", () => {
    const cache = new GroupCache();
    cache.applyFetch({ [G1]: meta(G1, "Family", [ALICE]) });
    cache.applyParticipants({ id: G1, action: "add", participants: [{ id: BOB }] }, [ALICE]);
    expect(cache.list()[0]?.participants).toBe(2);
    expect(cache.applyParticipants({ id: G1, action: "remove", participants: [{ id: BOB }] }, [ALICE])).toBe(false);
    expect(cache.list()[0]).toMatchObject({ participants: 1, isMember: true });
    expect(cache.applyParticipants({ id: G2, action: "remove", participants: [{ id: ALICE }] }, [ALICE])).toBe(false);
    cache.applyParticipants({ id: G1, action: "promote", participants: [{ id: ALICE }] }, [ALICE]);
    expect(cache.list()[0]?.participants).toBe(1);
  });

  it("restores membership when the account is added back", () => {
    const cache = new GroupCache();
    cache.applyFetch({ [G1]: meta(G1, "Family") });
    cache.applyParticipants({ id: G1, action: "remove", participants: [{ id: ALICE }] }, [ALICE]);
    cache.applyParticipants({ id: G1, action: "add", participants: [{ id: ALICE }] }, [ALICE]);
    expect(cache.list()[0]?.isMember).toBe(true);
  });

  it("persists only jid/name/participants/isMember and reloads them", async () => {
    const { cache } = makeCache(true);
    await cache.refresh();
    const raw = JSON.parse(await readFile(join(dir, "groups.json"), "utf8")) as unknown[];
    expect(raw).toHaveLength(2);
    for (const item of raw) {
      expect(Object.keys(item as object).sort()).toEqual(["isMember", "jid", "name", "participants"]);
    }
    expect(JSON.stringify(raw)).not.toContain(ALICE);

    const fresh = new GroupCache({ file: join(dir, "groups.json") });
    await fresh.load();
    expect(fresh.list()).toEqual(cache.list());
    expect(fresh.metadata(G1)).toBeUndefined();
  });

  it("load tolerates a missing, corrupt or malformed file", async () => {
    const file = join(dir, "groups.json");
    const c = new GroupCache({ file });
    await c.load();
    expect(c.list()).toEqual([]);
    await writeFile(file, "not json");
    await c.load();
    expect(c.list()).toEqual([]);
    await writeFile(
      file,
      JSON.stringify([{ jid: G1, name: 5, participants: "x", extra: 1 }, { jid: "bad" }, null, 3]),
    );
    await c.load();
    expect(c.list()).toEqual([{ jid: G1, name: "", participants: 0, isMember: true }]);
    await writeFile(file, "{}");
    await c.load();
    await new GroupCache().load();
    await new GroupCache().save();
  });

  it("does not let loaded entries overwrite fetched ones", async () => {
    await writeFile(join(dir, "groups.json"), JSON.stringify([{ jid: G1, name: "Old", participants: 1, isMember: true }]));
    const cache = new GroupCache({ file: join(dir, "groups.json") });
    cache.applyFetch({ [G1]: meta(G1, "New") });
    await cache.load();
    expect(cache.list()[0]?.name).toBe("New");
  });

  it("refresh enforces the 60 second cooldown and coalesces concurrent calls", async () => {
    const { cache, fetcher } = makeCache();
    await Promise.all([cache.refresh(), cache.refresh()]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    clock += 59_999;
    await cache.refresh();
    expect(fetcher).toHaveBeenCalledTimes(1);
    clock += 1;
    await cache.refresh();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("refresh without a fetcher returns the cache; a failing fetch keeps it", async () => {
    const cache = new GroupCache({ now });
    cache.applyFetch({ [G1]: meta(G1, "Family") });
    expect(await cache.refresh()).toHaveLength(1);
    cache.attach(async () => {
      throw new Error("boom");
    });
    expect(await cache.refresh()).toHaveLength(1);
  });

  it("debounces event-driven refreshes by 5 seconds", async () => {
    const { cache, fetcher } = makeCache();
    cache.scheduleRefresh();
    await vi.advanceTimersByTimeAsync(2_000);
    cache.scheduleRefresh();
    await vi.advanceTimersByTimeAsync(2_999);
    expect(fetcher).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("holds a debounced refresh until the cooldown has elapsed", async () => {
    const { cache, fetcher } = makeCache();
    await cache.refresh();
    cache.scheduleRefresh();
    clock += 5_000;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fetcher).toHaveBeenCalledTimes(1);
    clock += 55_000;
    await vi.advanceTimersByTimeAsync(55_000);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("refreshes every 6 hours and stops after detach", async () => {
    const cache = new GroupCache({ now });
    const fetcher = vi.fn(async () => ({}));
    cache.attach(fetcher);
    clock += 6 * 3600_000;
    await vi.advanceTimersByTimeAsync(6 * 3600_000);
    expect(fetcher).toHaveBeenCalledTimes(1);
    clock += 6 * 3600_000;
    await vi.advanceTimersByTimeAsync(6 * 3600_000);
    expect(fetcher).toHaveBeenCalledTimes(2);
    cache.scheduleRefresh();
    cache.detach();
    clock += 6 * 3600_000;
    await vi.advanceTimersByTimeAsync(6 * 3600_000);
    expect(fetcher).toHaveBeenCalledTimes(2);
    cache.scheduleRefresh(); // no fetcher: no-op
  });
});
