import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadOptions, parseOptions } from "../src/options.js";

const KEY = "test-api-key-0123456789abcdef";

describe("parseOptions", () => {
  it("applies defaults", () => {
    const r = parseOptions({ api_key: KEY });
    expect(r).toEqual({
      ok: true,
      options: {
        apiKey: KEY,
        pairingPhoneNumber: "",
        allowedTargets: [],
        rateLimitPerMinute: 10,
        trustedSources: [],
        logLevel: "info",
      },
    });
  });

  it("rejects a short key without throwing", () => {
    const r = parseOptions({ api_key: "short" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("invalid_option");
      expect(r.error).toContain("16");
      expect(r.error).not.toContain("short");
    }
  });

  it("rejects an empty or missing key", () => {
    expect(parseOptions({ api_key: "" }).ok).toBe(false);
    expect(parseOptions({}).ok).toBe(false);
    expect(parseOptions({ api_key: "               " }).ok).toBe(false);
  });

  it("rejects a non-string key", () => {
    expect(parseOptions({ api_key: 1234567890123456 }).ok).toBe(false);
  });

  it("trims and dedupes lists, dropping blanks", () => {
    const r = parseOptions({
      api_key: ` ${KEY} `,
      allowed_targets: [" +15555550123 ", "+15555550123", "", "group:Family"],
      trusted_sources: ["10.0.0.0/8", " 10.0.0.0/8"],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.options.apiKey).toBe(KEY);
      expect(r.options.allowedTargets).toEqual(["+15555550123", "group:Family"]);
      expect(r.options.trustedSources).toEqual(["10.0.0.0/8"]);
    }
  });

  it("validates the pairing phone number", () => {
    expect(parseOptions({ api_key: KEY, pairing_phone_number: " 15555550123 " })).toMatchObject({
      ok: true,
      options: { pairingPhoneNumber: "15555550123" },
    });
    expect(parseOptions({ api_key: KEY, pairing_phone_number: "+15555550123" }).ok).toBe(false);
    expect(parseOptions({ api_key: KEY, pairing_phone_number: "1234567890123456" }).ok).toBe(false);
    expect(parseOptions({ api_key: KEY, pairing_phone_number: 5 }).ok).toBe(false);
  });

  it("validates the rate limit", () => {
    for (const bad of [0, 61, 1.5, "10", null]) {
      expect(parseOptions({ api_key: KEY, rate_limit_per_minute: bad }).ok).toBe(false);
    }
    expect(parseOptions({ api_key: KEY, rate_limit_per_minute: 60 }).ok).toBe(true);
    expect(parseOptions({ api_key: KEY, rate_limit_per_minute: 1 }).ok).toBe(true);
  });

  it("validates the log level", () => {
    expect(parseOptions({ api_key: KEY, log_level: "warning" }).ok).toBe(true);
    expect(parseOptions({ api_key: KEY, log_level: "trace" }).ok).toBe(false);
  });

  it("rejects bad list shapes", () => {
    expect(parseOptions({ api_key: KEY, allowed_targets: "x" }).ok).toBe(false);
    expect(parseOptions({ api_key: KEY, trusted_sources: [1] }).ok).toBe(false);
  });

  it("rejects non-object input", () => {
    expect(parseOptions(null).ok).toBe(false);
    expect(parseOptions([]).ok).toBe(false);
    expect(parseOptions("x").ok).toBe(false);
  });
});

describe("loadOptions", () => {
  const dir = mkdtempSync(join(tmpdir(), "opts-"));

  it("loads a valid file", () => {
    const p = join(dir, "ok.json");
    writeFileSync(p, JSON.stringify({ api_key: KEY, log_level: "debug" }));
    const r = loadOptions(p);
    expect(r.ok && r.options.logLevel).toBe("debug");
  });

  it("returns read_failed for a missing file", () => {
    const r = loadOptions(join(dir, "missing.json"));
    expect(r).toMatchObject({ ok: false, code: "read_failed" });
  });

  it("returns invalid_json for malformed JSON", () => {
    const p = join(dir, "bad.json");
    writeFileSync(p, "{not json");
    expect(loadOptions(p)).toMatchObject({ ok: false, code: "invalid_json" });
  });

  it("returns a typed failure for a short key in a file", () => {
    const p = join(dir, "short.json");
    writeFileSync(p, JSON.stringify({ api_key: "tooshort" }));
    expect(loadOptions(p)).toMatchObject({ ok: false, code: "invalid_option" });
  });
});
