import { readFileSync } from "node:fs";

export type LogLevel = "debug" | "info" | "warning" | "error";

export interface GatewayOptions {
  apiKey: string;
  pairingPhoneNumber: string;
  allowedTargets: string[];
  rateLimitPerMinute: number;
  trustedSources: string[];
  logLevel: LogLevel;
}

export const MIN_API_KEY_LENGTH = 16;

export type OptionsResult =
  | { ok: true; options: GatewayOptions }
  | { ok: false; error: string; code: "read_failed" | "invalid_json" | "invalid_option" };

const LOG_LEVELS: readonly string[] = ["debug", "info", "warning", "error"];

function cleanList(value: unknown, name: string): string[] | string {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return `${name} must be a list of strings`;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") return `${name} must be a list of strings`;
    const t = item.trim();
    if (t !== "" && !out.includes(t)) out.push(t);
  }
  return out;
}

/** Validate a raw options object. Never throws. */
export function parseOptions(raw: unknown): OptionsResult {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, code: "invalid_json", error: "Options must be a JSON object" };
  }
  const o = raw as Record<string, unknown>;
  const fail = (error: string): OptionsResult => ({ ok: false, code: "invalid_option", error });

  if (o["api_key"] !== undefined && typeof o["api_key"] !== "string") {
    return fail("api_key must be a string");
  }
  const apiKey = ((o["api_key"] as string | undefined) ?? "").trim();
  if (apiKey.length < MIN_API_KEY_LENGTH) {
    return fail(`api_key must be at least ${MIN_API_KEY_LENGTH} characters`);
  }

  const phoneRaw = o["pairing_phone_number"];
  if (phoneRaw !== undefined && typeof phoneRaw !== "string") {
    return fail("pairing_phone_number must be a string");
  }
  const phone = ((phoneRaw as string | undefined) ?? "").trim();
  if (!/^[0-9]{0,15}$/.test(phone)) {
    return fail("pairing_phone_number must be up to 15 digits with no plus sign");
  }

  const allowed = cleanList(o["allowed_targets"], "allowed_targets");
  if (typeof allowed === "string") return fail(allowed);
  const trusted = cleanList(o["trusted_sources"], "trusted_sources");
  if (typeof trusted === "string") return fail(trusted);

  const rate = o["rate_limit_per_minute"] === undefined ? 10 : o["rate_limit_per_minute"];
  if (typeof rate !== "number" || !Number.isInteger(rate) || rate < 1 || rate > 60) {
    return fail("rate_limit_per_minute must be an integer between 1 and 60");
  }

  const level = o["log_level"] === undefined ? "info" : o["log_level"];
  if (typeof level !== "string" || !LOG_LEVELS.includes(level)) {
    return fail("log_level must be one of debug, info, warning, error");
  }

  return {
    ok: true,
    options: {
      apiKey,
      pairingPhoneNumber: phone,
      allowedTargets: allowed,
      rateLimitPerMinute: rate,
      trustedSources: trusted,
      logLevel: level as LogLevel,
    },
  };
}

/** Read and validate the options file. Never throws; errors never include the key. */
export function loadOptions(path: string): OptionsResult {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    const reason = err instanceof Error ? err.message : "unknown error";
    return { ok: false, code: "read_failed", error: `Could not read options file: ${reason}` };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, code: "invalid_json", error: "Options file is not valid JSON" };
  }
  return parseOptions(raw);
}
