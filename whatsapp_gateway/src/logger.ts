import { pino, type Logger } from "pino";
import type { LogLevel } from "./options.js";

const PINO_LEVEL: Record<LogLevel, string> = {
  debug: "debug",
  info: "info",
  warning: "warn",
  error: "error",
};

export function createLogger(level: LogLevel = "info"): Logger {
  return pino({ level: PINO_LEVEL[level] ?? "info" });
}

/**
 * Mask a JID for logging. Reveals at most the first 4 and last 3 characters
 * of the local part, e.g. 15555550123@s.whatsapp.net -> 1555****123@s.whatsapp.net.
 */
export function maskJid(jid: string): string {
  const at = jid.indexOf("@");
  const local = at === -1 ? jid : jid.slice(0, at);
  const domain = at === -1 ? "" : jid.slice(at);
  if (local.length <= 7) return `${"*".repeat(Math.max(local.length, 4))}${domain}`;
  return `${local.slice(0, 4)}****${local.slice(-3)}${domain}`;
}
