import { afterEach, describe, expect, it, vi } from "vitest";
import { createIpFilter, normaliseAddress } from "../src/ipfilter.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("normaliseAddress", () => {
  it("unwraps IPv4-mapped IPv6 and strips zones", () => {
    expect(normaliseAddress("::ffff:172.30.32.1")).toBe("172.30.32.1");
    expect(normaliseAddress("::FFFF:10.0.0.1")).toBe("10.0.0.1");
    expect(normaliseAddress("fe80::1%eth0")).toBe("fe80::1");
  });

  it("rejects non-IPs", () => {
    expect(normaliseAddress(undefined)).toBeUndefined();
    expect(normaliseAddress("")).toBeUndefined();
    expect(normaliseAddress("homeassistant")).toBeUndefined();
  });
});

describe("createIpFilter", () => {
  it("always allows loopback", () => {
    const f = createIpFilter({ allow: [], refreshMs: 0 });
    expect(f.isAllowed("127.0.0.1")).toBe(true);
    expect(f.isAllowed("127.5.5.5")).toBe(true);
    expect(f.isAllowed("::1")).toBe(true);
    expect(f.isAllowed("::ffff:127.0.0.1")).toBe(true);
    f.stop();
  });

  it("denies unknown, missing and malformed addresses", () => {
    const f = createIpFilter({ allow: [], refreshMs: 0 });
    expect(f.isAllowed("192.0.2.10")).toBe(false);
    expect(f.isAllowed(undefined)).toBe(false);
    expect(f.isAllowed("not-an-ip")).toBe(false);
  });

  it("allows exact IPs and CIDRs, including mapped forms", () => {
    const f = createIpFilter({
      allow: ["192.0.2.10", "198.51.100.0/24", "2001:db8::/32", "2001:db8:ffff::5", "::ffff:203.0.113.7"],
      refreshMs: 0,
    });
    expect(f.isAllowed("192.0.2.10")).toBe(true);
    expect(f.isAllowed("::ffff:192.0.2.10")).toBe(true);
    expect(f.isAllowed("192.0.2.11")).toBe(false);
    expect(f.isAllowed("198.51.100.200")).toBe(true);
    expect(f.isAllowed("198.51.101.1")).toBe(false);
    expect(f.isAllowed("2001:db8:1::1")).toBe(true);
    expect(f.isAllowed("2001:db9::1")).toBe(false);
    expect(f.isAllowed("2001:db8:ffff::5")).toBe(true);
    expect(f.isAllowed("203.0.113.7")).toBe(true);
  });

  it("supports a prefix written against a mapped address", () => {
    const f = createIpFilter({ allow: ["::ffff:10.1.0.0/112"], refreshMs: 0 });
    expect(f.isAllowed("10.1.0.99")).toBe(true);
    expect(f.isAllowed("10.2.0.1")).toBe(false);
  });

  it("ignores invalid entries (deny)", () => {
    const f = createIpFilter({
      allow: ["", "garbage", "10.0.0.0/33", "10.0.0.0/x", "10.0.0.0/8/9", "::1/129", "::ffff:10.0.0.0/8"],
      refreshMs: 0,
    });
    expect(f.isAllowed("10.0.0.1")).toBe(false);
  });

  it("allows addresses that a host resolves to, and re-resolves", async () => {
    let answer = ["172.30.32.5"];
    const resolver = vi.fn(async () => answer);
    const f = createIpFilter({ allow: [], resolveHosts: ["homeassistant"], refreshMs: 0, resolver });
    expect(f.isAllowed("172.30.32.5")).toBe(false);
    await f.refresh();
    expect(resolver).toHaveBeenCalledWith("homeassistant");
    expect(f.isAllowed("172.30.32.5")).toBe(true);
    expect(f.isAllowed("::ffff:172.30.32.5")).toBe(true);
    answer = ["172.30.32.9", "bogus"];
    await f.refresh();
    expect(f.isAllowed("172.30.32.5")).toBe(false);
    expect(f.isAllowed("172.30.32.9")).toBe(true);
  });

  it("keeps previous addresses when a lookup fails", async () => {
    let fail = false;
    const resolver = async (): Promise<string[]> => {
      if (fail) throw new Error("ENOTFOUND");
      return ["172.30.32.5"];
    };
    const f = createIpFilter({ allow: [], resolveHosts: ["homeassistant"], refreshMs: 0, resolver });
    await f.refresh();
    fail = true;
    await expect(f.refresh()).resolves.toBeUndefined();
    expect(f.isAllowed("172.30.32.5")).toBe(true);
  });

  it("does nothing on refresh without hosts", async () => {
    const f = createIpFilter({ allow: [], refreshMs: 1000 });
    await expect(f.refresh()).resolves.toBeUndefined();
  });

  it("refreshes on a timer until stopped", async () => {
    vi.useFakeTimers();
    const resolver = vi.fn(async () => ["172.30.32.5"]);
    const f = createIpFilter({ allow: [], resolveHosts: ["homeassistant"], refreshMs: 300_000, resolver });
    await vi.advanceTimersByTimeAsync(300_000);
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(f.isAllowed("172.30.32.5")).toBe(true);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(resolver).toHaveBeenCalledTimes(2);
    f.stop();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(resolver).toHaveBeenCalledTimes(2);
  });

  it("uses the system resolver by default", async () => {
    const f = createIpFilter({ allow: [], resolveHosts: ["localhost"], refreshMs: 0 });
    await f.refresh();
    expect(f.isAllowed("127.0.0.1")).toBe(true);
    f.stop();
  });
});
