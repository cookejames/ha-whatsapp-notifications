import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { GroupMetadata, GroupParticipant } from "@whiskeysockets/baileys";
import type { Logger } from "pino";
import type { GroupInfo } from "./client.js";

export const GROUP_DEBOUNCE_MS = 5_000;
export const GROUP_COOLDOWN_MS = 60_000;
export const GROUP_PERIODIC_MS = 6 * 60 * 60 * 1000;

export type GroupFetcher = () => Promise<Record<string, GroupMetadata>>;

export interface ParticipantsEvent {
  id: string;
  action: "add" | "remove" | "promote" | "demote" | "modify";
  participants: GroupParticipant[];
}

export interface GroupCacheOptions {
  /** Path of groups.json. Without it nothing is persisted. */
  file?: string;
  logger?: Logger;
  /** Injectable clock (ms since epoch) used for the cooldown. */
  now?: () => number;
  debounceMs?: number;
  cooldownMs?: number;
  periodicMs?: number;
}

interface Entry {
  info: GroupInfo;
  /** Full Baileys metadata; only present for groups seen on this run. */
  meta?: GroupMetadata;
}

/** Strip the ":device" suffix from a JID so ids compare equal across devices. */
export function stripDevice(jid: string): string {
  return jid.replace(/:\d+(?=@)/, "");
}

function participantIds(p: GroupParticipant): string[] {
  return [p.id, p.lid, p.phoneNumber]
    .filter((v): v is string => typeof v === "string" && v !== "")
    .map(stripDevice);
}

function toInfo(meta: GroupMetadata, isMember: boolean): GroupInfo {
  return {
    jid: meta.id,
    name: meta.subject ?? "",
    participants: meta.size ?? meta.participants?.length ?? 0,
    isMember,
  };
}

function sanitize(raw: unknown): GroupInfo[] {
  if (!Array.isArray(raw)) return [];
  const out: GroupInfo[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const o = item as Record<string, unknown>;
    if (typeof o["jid"] !== "string" || !o["jid"].endsWith("@g.us")) continue;
    out.push({
      jid: o["jid"],
      name: typeof o["name"] === "string" ? o["name"] : "",
      participants:
        typeof o["participants"] === "number" && Number.isFinite(o["participants"])
          ? o["participants"]
          : 0,
      isMember: o["isMember"] !== false,
    });
  }
  return out;
}

/**
 * Cache of the account's groups. Feeds Baileys' `cachedGroupMetadata`, answers
 * `groups()` without touching the network, and persists only
 * `{jid, name, participants, isMember}` so names resolve right after a restart.
 */
export class GroupCache {
  private readonly entries = new Map<string, Entry>();
  private readonly file: string | undefined;
  private readonly logger: Logger | undefined;
  private readonly now: () => number;
  private readonly debounceMs: number;
  private readonly cooldownMs: number;
  private readonly periodicMs: number;

  private fetcher: GroupFetcher | undefined;
  private lastFetchAt: number | undefined;
  private inFlight: Promise<GroupInfo[]> | undefined;
  private debounceTimer: NodeJS.Timeout | undefined;
  private periodicTimer: NodeJS.Timeout | undefined;
  private saving: Promise<void> = Promise.resolve();

  constructor(opts: GroupCacheOptions = {}) {
    this.file = opts.file;
    this.logger = opts.logger;
    this.now = opts.now ?? (() => Date.now());
    this.debounceMs = opts.debounceMs ?? GROUP_DEBOUNCE_MS;
    this.cooldownMs = opts.cooldownMs ?? GROUP_COOLDOWN_MS;
    this.periodicMs = opts.periodicMs ?? GROUP_PERIODIC_MS;
  }

  // Reads

  list(): GroupInfo[] {
    return [...this.entries.values()].map((e) => ({ ...e.info }));
  }

  metadata(jid: string): GroupMetadata | undefined {
    return this.entries.get(jid)?.meta;
  }

  // Persistence

  /** Load groups.json. A missing or corrupt file leaves the cache empty. */
  async load(): Promise<void> {
    if (!this.file) return;
    let text: string;
    try {
      text = await readFile(this.file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        this.logger?.warn({ err }, "Could not read groups cache");
      }
      return;
    }
    try {
      for (const info of sanitize(JSON.parse(text))) {
        if (!this.entries.has(info.jid)) this.entries.set(info.jid, { info });
      }
    } catch {
      this.logger?.warn("Ignoring corrupt groups cache");
    }
  }

  /** Write groups.json (atomically). Never throws. */
  save(): Promise<void> {
    const file = this.file;
    if (!file) return Promise.resolve();
    const data = JSON.stringify(this.list().map(({ jid, name, participants, isMember }) => ({
      jid,
      name,
      participants,
      isMember,
    })));
    this.saving = this.saving
      .then(async () => {
        await mkdir(dirname(file), { recursive: true });
        const tmp = `${file}.tmp`;
        await writeFile(tmp, data, { mode: 0o600 });
        await rename(tmp, file);
      })
      .catch((err: unknown) => {
        this.logger?.warn({ err }, "Could not write groups cache");
      });
    return this.saving;
  }

  // Applying data

  /** Replace the cache with a full `groupFetchAllParticipating()` result. */
  applyFetch(all: Record<string, GroupMetadata>): void {
    const seen = new Set<string>();
    for (const [key, meta] of Object.entries(all)) {
      const jid = meta.id || key;
      seen.add(jid);
      this.entries.set(jid, { info: toInfo({ ...meta, id: jid }, true), meta: { ...meta, id: jid } });
    }
    // Groups we no longer see are kept (so names still resolve) but flagged.
    for (const [jid, e] of this.entries) {
      if (!seen.has(jid)) {
        e.info.isMember = false;
        delete e.meta;
      }
    }
  }

  /** Apply `groups.upsert` / `groups.update` payloads. Unknown partial groups are ignored. */
  applyUpdate(updates: Partial<GroupMetadata>[]): void {
    for (const u of updates) {
      if (!u.id) continue;
      const existing = this.entries.get(u.id);
      if (existing?.meta) {
        const meta = { ...existing.meta, ...u, id: u.id };
        this.entries.set(u.id, { info: toInfo(meta, existing.info.isMember), meta });
      } else if (existing) {
        if (typeof u.subject === "string") existing.info.name = u.subject;
        if (typeof u.size === "number") existing.info.participants = u.size;
      } else if (typeof u.subject === "string" && Array.isArray(u.participants)) {
        const meta = u as GroupMetadata;
        this.entries.set(u.id, { info: toInfo(meta, true), meta });
      }
    }
  }

  /**
   * Apply `group-participants.update`. If the linked account is removed the
   * group is flagged `isMember: false`. `selfIds` are the account's own JIDs/LIDs.
   * Returns true if the event concerned the linked account being removed.
   */
  applyParticipants(event: ParticipantsEvent, selfIds: string[]): boolean {
    const entry = this.entries.get(event.id);
    if (!entry) return false;
    const self = new Set(selfIds.map(stripDevice));
    const concernsSelf = event.participants.some((p) => participantIds(p).some((id) => self.has(id)));

    if (event.action === "remove" && concernsSelf) {
      entry.info.isMember = false;
      delete entry.meta;
      return true;
    }
    if (entry.meta && (event.action === "add" || event.action === "remove")) {
      const touched = new Set(event.participants.flatMap(participantIds));
      const kept = entry.meta.participants.filter((p) => !participantIds(p).some((id) => touched.has(id)));
      const participants = event.action === "add" ? [...kept, ...event.participants] : kept;
      const meta = { ...entry.meta, participants, size: participants.length };
      this.entries.set(event.id, { info: toInfo(meta, entry.info.isMember), meta });
    }
    if (event.action === "add" && concernsSelf) entry.info.isMember = true;
    return false;
  }

  // Refresh scheduling

  /** Bind the network fetcher and start the 6-hour periodic refresh. */
  attach(fetcher: GroupFetcher): void {
    this.fetcher = fetcher;
    this.clearPeriodic();
    this.periodicTimer = setInterval(() => {
      void this.refresh();
    }, this.periodicMs);
    this.periodicTimer.unref();
  }

  /** Stop timers and drop the fetcher (e.g. when the socket goes away). */
  detach(): void {
    this.fetcher = undefined;
    this.clearPeriodic();
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = undefined;
  }

  /**
   * Fetch from the network unless inside the cooldown, in which case the cached
   * list is returned. Concurrent calls share one fetch.
   */
  refresh(): Promise<GroupInfo[]> {
    const fetcher = this.fetcher;
    if (!fetcher) return Promise.resolve(this.list());
    if (this.inFlight) return this.inFlight;
    if (this.cooldownRemaining() > 0) return Promise.resolve(this.list());

    this.lastFetchAt = this.now();
    const p = (async () => {
      try {
        this.applyFetch(await fetcher());
        await this.save();
      } catch (err) {
        this.logger?.warn({ err }, "Group refresh failed");
      }
      return this.list();
    })().finally(() => {
      this.inFlight = undefined;
    });
    this.inFlight = p;
    return p;
  }

  /**
   * Request a refresh after the debounce interval (called on group events).
   * If the cooldown has not elapsed by then, wait for it instead of dropping the refresh.
   */
  scheduleRefresh(): void {
    if (!this.fetcher || this.debounceTimer) return;
    this.debounceTimer = setTimeout(() => this.runDebounced(), this.debounceMs);
    this.debounceTimer.unref();
  }

  private runDebounced(): void {
    this.debounceTimer = undefined;
    if (!this.fetcher) return;
    const wait = this.cooldownRemaining();
    if (wait > 0) {
      this.debounceTimer = setTimeout(() => this.runDebounced(), wait);
      this.debounceTimer.unref();
      return;
    }
    void this.refresh();
  }

  private cooldownRemaining(): number {
    if (this.lastFetchAt === undefined) return 0;
    return Math.max(0, this.lastFetchAt + this.cooldownMs - this.now());
  }

  private clearPeriodic(): void {
    if (this.periodicTimer) clearInterval(this.periodicTimer);
    this.periodicTimer = undefined;
  }
}
