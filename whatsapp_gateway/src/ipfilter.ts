import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

/** Structural shape that the API and ingress servers code against. */
export type IpFilter = { isAllowed(remoteAddress: string | undefined): boolean };

export type HostResolver = (host: string) => Promise<string[]>;

export interface IpFilterOptions {
  /** IPs or CIDRs that are always allowed. */
  allow: string[];
  /** Hostnames whose addresses are allowed, re-resolved every `refreshMs`. */
  resolveHosts?: string[];
  refreshMs: number;
  resolver?: HostResolver;
}

export interface ManagedIpFilter extends IpFilter {
  /** Re-resolve `resolveHosts` now. Never rejects; a failed lookup keeps that host's previous addresses. */
  refresh(): Promise<void>;
  stop(): void;
}

const V4_MAPPED = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i;

/** Lower-case, strip any zone id and unwrap IPv4-mapped IPv6. Returns undefined when not an IP. */
export function normaliseAddress(address: string | undefined): string | undefined {
  if (!address) return undefined;
  let a = address.trim().toLowerCase();
  const zone = a.indexOf("%");
  if (zone !== -1) a = a.slice(0, zone);
  const mapped = V4_MAPPED.exec(a);
  if (mapped?.[1]) a = mapped[1];
  return isIP(a) === 0 ? undefined : a;
}

function family(ip: string): "ipv4" | "ipv6" {
  return isIP(ip) === 4 ? "ipv4" : "ipv6";
}

/** Add an IP or CIDR to the list. Invalid entries are ignored, which is the conservative (deny) outcome. */
function addEntry(list: BlockList, entry: string): void {
  const [addrPart, prefixPart, ...rest] = entry.trim().split("/");
  if (rest.length > 0) return;
  const addr = normaliseAddress(addrPart);
  if (!addr) return;
  if (prefixPart === undefined) {
    list.addAddress(addr, family(addr));
    return;
  }
  if (!/^\d{1,3}$/.test(prefixPart)) return;
  // A prefix written against an IPv4-mapped address counts from the IPv6 side.
  const prefix = V4_MAPPED.test((addrPart ?? "").trim()) ? Number(prefixPart) - 96 : Number(prefixPart);
  const max = family(addr) === "ipv4" ? 32 : 128;
  if (prefix < 0 || prefix > max) return;
  list.addSubnet(addr, prefix, family(addr));
}

async function defaultResolver(host: string): Promise<string[]> {
  const found = await lookup(host, { all: true });
  return found.map((f) => f.address);
}

export function createIpFilter(opts: IpFilterOptions): ManagedIpFilter {
  const resolver = opts.resolver ?? defaultResolver;
  const hosts = opts.resolveHosts ?? [];

  const fixed = new BlockList();
  fixed.addSubnet("127.0.0.0", 8, "ipv4");
  fixed.addAddress("::1", "ipv6");
  for (const entry of opts.allow) addEntry(fixed, entry);

  const resolved = new Map<string, Set<string>>();
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;

  const refresh = async (): Promise<void> => {
    for (const host of hosts) {
      try {
        const addrs = new Set<string>();
        for (const addr of await resolver(host)) {
          const n = normaliseAddress(addr);
          if (n) addrs.add(n);
        }
        if (!stopped) resolved.set(host, addrs);
      } catch {
        // A failed lookup must not drop addresses we already know.
      }
    }
  };

  if (hosts.length > 0 && opts.refreshMs > 0) {
    timer = setInterval(() => void refresh(), opts.refreshMs);
    timer.unref();
  }

  return {
    isAllowed(remoteAddress) {
      const ip = normaliseAddress(remoteAddress);
      if (!ip) return false;
      for (const addrs of resolved.values()) if (addrs.has(ip)) return true;
      return fixed.check(ip, family(ip));
    },
    refresh,
    stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}
