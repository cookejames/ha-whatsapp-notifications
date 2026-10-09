import { describe, expect, it } from "vitest";
import { createLogger, maskJid } from "../src/logger.js";

describe("maskJid", () => {
  it("masks user JIDs", () => {
    expect(maskJid("15555550123@s.whatsapp.net")).toBe("1555****123@s.whatsapp.net");
  });

  it("masks group JIDs", () => {
    expect(maskJid("120363000000000000@g.us")).toBe("1203****000@g.us");
  });

  it("masks LIDs", () => {
    expect(maskJid("100000000000000@lid")).toBe("1000****000@lid");
  });

  it("never reveals more than 4 leading and 3 trailing characters", () => {
    for (const jid of ["15555550123@s.whatsapp.net", "1234567@s.whatsapp.net", "12345@lid", "1@lid", "abcdefghij", "@g.us", ""]) {
      const local = maskJid(jid).split("@")[0] ?? "";
      const orig = jid.split("@")[0] ?? "";
      const lead = [...local].findIndex((c) => c === "*");
      const visibleLead = lead === -1 ? local.length : lead;
      const visibleTail = local.length - local.lastIndexOf("*") - 1;
      expect(visibleLead).toBeLessThanOrEqual(4);
      expect(visibleTail).toBeLessThanOrEqual(3);
      if (orig.length <= 7) expect(local).not.toContain(orig.slice(0, 1) === "" ? "\0" : orig);
    }
  });

  it("handles input without a domain", () => {
    expect(maskJid("15555550123")).toBe("1555****123");
  });
});

describe("createLogger", () => {
  it("maps warning to pino warn", () => {
    expect(createLogger("warning").level).toBe("warn");
  });

  it("uses the given level", () => {
    expect(createLogger("debug").level).toBe("debug");
    expect(createLogger().level).toBe("info");
  });
});
