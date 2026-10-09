import type { GroupInfo } from "./client.js";

export type ErrorCode =
  | "invalid_target"
  | "unknown_group"
  | "ambiguous_group"
  | "not_a_member"
  | "target_not_allowed";

export type ResolveResult =
  | { ok: true; jid: string; kind: "user" | "group" }
  | { ok: false; code: ErrorCode; message: string; suggestions?: string[] };

const USER_SUFFIX = "@s.whatsapp.net";
const MAX_SUGGESTIONS = 3;
const MAX_DISTANCE = 3;

/**
 * Strip spaces, dashes, dots, parentheses and one leading "+", then require
 * 7-15 digits. Returns the digits, or null when the input is not a phone number.
 */
export function normalisePhone(input: string): string | null {
  const stripped = input.trim().replace(/[\s\-.()]/g, "").replace(/^\+/, "");
  return /^\d{7,15}$/.test(stripped) ? stripped : null;
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min((prev[j] ?? 0) + 1, (cur[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
    }
    prev = cur;
  }
  return prev[b.length] ?? 0;
}

function formatGroup(g: GroupInfo): string {
  return `${g.name} (${g.jid})`;
}

function suggest(name: string, members: GroupInfo[]): string[] {
  const needle = name.toLowerCase();
  const scored: { g: GroupInfo; substring: boolean; distance: number }[] = [];
  for (const g of members) {
    const hay = g.name.trim().toLowerCase();
    const substring = needle.length > 0 && hay.length > 0 && (hay.includes(needle) || needle.includes(hay));
    const distance = levenshtein(needle, hay);
    if (substring || distance <= MAX_DISTANCE) scored.push({ g, substring, distance });
  }
  scored.sort((x, y) => Number(y.substring) - Number(x.substring) || x.distance - y.distance);
  return scored.slice(0, MAX_SUGGESTIONS).map((s) => formatGroup(s.g));
}

const invalid = (): ResolveResult => ({
  ok: false,
  code: "invalid_target",
  message: "Invalid target: not a phone number, JID or group",
});

export function resolveTarget(input: string, groups: GroupInfo[]): ResolveResult {
  const target = input.trim();
  const lower = target.toLowerCase();

  // 1. Group JID.
  if (lower.endsWith("@g.us")) {
    if (groups.some((g) => g.jid.toLowerCase() === lower && g.isMember)) {
      return { ok: true, jid: lower, kind: "group" };
    }
    return { ok: false, code: "not_a_member", message: "Not a member of that group" };
  }

  // 2. group:<name>
  if (lower.startsWith("group:")) {
    const name = target.slice("group:".length).trim();
    const wanted = name.toLowerCase();
    const members = groups.filter((g) => g.isMember);
    const matches = members.filter((g) => g.name.trim().toLowerCase() === wanted);
    if (matches.length === 1 && matches[0]) {
      return { ok: true, jid: matches[0].jid, kind: "group" };
    }
    if (matches.length > 1) {
      return {
        ok: false,
        code: "ambiguous_group",
        message: `More than one group is named "${name}"`,
        suggestions: matches.map(formatGroup),
      };
    }
    const suggestions = suggest(name, members);
    return {
      ok: false,
      code: "unknown_group",
      message: `No group named "${name}"`,
      ...(suggestions.length > 0 ? { suggestions } : {}),
    };
  }

  // 3. User JID (@c.us is normalised to @s.whatsapp.net).
  for (const suffix of [USER_SUFFIX, "@lid", "@c.us"]) {
    if (lower.endsWith(suffix)) {
      const local = lower.slice(0, -suffix.length);
      if (!/^\d+$/.test(local)) return invalid();
      return { ok: true, jid: `${local}${suffix === "@c.us" ? USER_SUFFIX : suffix}`, kind: "user" };
    }
  }

  // 4. Phone number.
  const digits = normalisePhone(target);
  if (digits === null) return invalid();
  return { ok: true, jid: `${digits}${USER_SUFFIX}`, kind: "user" };
}

/**
 * True when `jid` is permitted by `allowedTargets`. Each entry is resolved with
 * the same rules as resolveTarget; entries that do not resolve never match.
 * An empty list allows everything.
 */
export function isAllowed(jid: string, allowedTargets: string[], groups: GroupInfo[]): boolean {
  if (allowedTargets.length === 0) return true;
  const wanted = jid.trim().toLowerCase();
  return allowedTargets.some((entry) => {
    const trimmed = entry.trim().toLowerCase();
    // A group JID entry is a literal match; it need not be in the cache.
    if (trimmed.endsWith("@g.us")) return trimmed === wanted;
    const r = resolveTarget(entry, groups);
    return r.ok && r.jid.toLowerCase() === wanted;
  });
}
