import { describe, expect, it } from "vitest";
import type { GroupInfo } from "../src/client.js";
import { isAllowed, normalisePhone, resolveTarget } from "../src/jid.js";

const FAMILY = "120363000000000000@g.us";
const CLUB = "120363000000000001@g.us";
const PHONE = "15555550123@s.whatsapp.net";

const groups: GroupInfo[] = [
  { jid: FAMILY, name: "Family", participants: 4, isMember: true },
  { jid: CLUB, name: "Garden Club", participants: 9, isMember: true },
  { jid: "120363000000000002@g.us", name: "Old Group", participants: 2, isMember: false },
];

describe("normalisePhone", () => {
  it.each([
    ["+15555550123", "15555550123"],
    ["+1 (555) 555-0123", "15555550123"],
    ["1.555.555.0123", "15555550123"],
    ["15555550123", "15555550123"],
  ])("accepts %s", (input, out) => expect(normalisePhone(input)).toBe(out));

  it.each(["123456", "1234567890123456", "+1555abc0123", "", "++15555550123"])("rejects %j", (input) =>
    expect(normalisePhone(input)).toBeNull(),
  );
});

describe("resolveTarget phone numbers", () => {
  it("resolves variants to the same JID", () => {
    for (const input of ["+15555550123", " +1 (555) 555-0123 ", "15555550123"]) {
      expect(resolveTarget(input, groups)).toEqual({ ok: true, jid: PHONE, kind: "user" });
    }
  });

  it.each(["123456", "1234567890123456", "555abc0123", ""])("rejects %j", (input) => {
    expect(resolveTarget(input, groups)).toMatchObject({ ok: false, code: "invalid_target" });
  });
});

describe("resolveTarget JID suffixes", () => {
  it("accepts @s.whatsapp.net", () => {
    expect(resolveTarget(PHONE, groups)).toEqual({ ok: true, jid: PHONE, kind: "user" });
  });
  it("accepts @lid", () => {
    expect(resolveTarget("100000000000000@lid", groups)).toEqual({
      ok: true,
      jid: "100000000000000@lid",
      kind: "user",
    });
  });
  it("normalises @c.us", () => {
    expect(resolveTarget("15555550123@c.us", groups)).toEqual({ ok: true, jid: PHONE, kind: "user" });
  });
  it.each(["abc@s.whatsapp.net", "@lid", "1555x@c.us"])("rejects non-digit local part %s", (input) => {
    expect(resolveTarget(input, groups)).toMatchObject({ ok: false, code: "invalid_target" });
  });
  it("resolves a member group JID", () => {
    expect(resolveTarget(FAMILY, groups)).toEqual({ ok: true, jid: FAMILY, kind: "group" });
  });
  it("rejects unknown and non-member group JIDs", () => {
    expect(resolveTarget("120363000000000002@g.us", groups)).toMatchObject({ ok: false, code: "not_a_member" });
    expect(resolveTarget("120363999999999999@g.us", groups)).toMatchObject({ ok: false, code: "not_a_member" });
  });
});

describe("resolveTarget group: names", () => {
  it("matches exactly, ignoring case and whitespace", () => {
    expect(resolveTarget("group:Family", groups)).toEqual({ ok: true, jid: FAMILY, kind: "group" });
    expect(resolveTarget("GROUP:family", groups)).toEqual({ ok: true, jid: FAMILY, kind: "group" });
    expect(resolveTarget("Group:  garden CLUB  ", groups)).toEqual({ ok: true, jid: CLUB, kind: "group" });
  });

  it("is ambiguous when several member groups share a name", () => {
    const dup = [...groups, { jid: "120363000000000003@g.us", name: "family", participants: 1, isMember: true }];
    expect(resolveTarget("group:Family", dup)).toMatchObject({
      ok: false,
      code: "ambiguous_group",
      suggestions: [`Family (${FAMILY})`, "family (120363000000000003@g.us)"],
    });
  });

  it("suggests close names and substrings, at most 3", () => {
    expect(resolveTarget("group:Famly", groups)).toMatchObject({
      ok: false,
      code: "unknown_group",
      suggestions: [`Family (${FAMILY})`],
    });
    expect(resolveTarget("group:Garden", groups)).toMatchObject({
      suggestions: [`Garden Club (${CLUB})`],
    });
    const many = Array.from({ length: 6 }, (_, i): GroupInfo => ({
      jid: `12036300000000010${i}@g.us`,
      name: `Team ${i}`,
      participants: 1,
      isMember: true,
    }));
    const r = resolveTarget("group:Team", many);
    expect(r.ok === false && r.suggestions).toHaveLength(3);
  });

  it("omits suggestions when nothing is close", () => {
    const r = resolveTarget("group:Completely Different Thing", groups);
    expect(r).toMatchObject({ ok: false, code: "unknown_group" });
    expect(r.ok === false && r.suggestions).toBeUndefined();
  });

  it("treats an empty name as unknown", () => {
    expect(resolveTarget("group:", groups)).toMatchObject({ ok: false, code: "unknown_group" });
  });

  it("ignores groups the user is not a member of", () => {
    const r = resolveTarget("group:Old Group", groups);
    expect(r).toMatchObject({ ok: false, code: "unknown_group" });
    expect(JSON.stringify(r)).not.toContain("120363000000000002");
  });
});

describe("isAllowed", () => {
  it("allows everything when the list is empty", () => {
    expect(isAllowed(PHONE, [], groups)).toBe(true);
  });
  it("matches a phone entry", () => {
    expect(isAllowed(PHONE, ["+15555550123"], groups)).toBe(true);
    expect(isAllowed(PHONE, ["15555550123@c.us"], groups)).toBe(true);
  });
  it("matches a group name entry", () => {
    expect(isAllowed(FAMILY, ["group:family"], groups)).toBe(true);
    expect(isAllowed(CLUB, ["group:family"], groups)).toBe(false);
  });
  it("matches a group JID entry", () => {
    expect(isAllowed(FAMILY, [FAMILY], groups)).toBe(true);
    expect(isAllowed(CLUB, [FAMILY], groups)).toBe(false);
  });
  it("denies a target not on the list", () => {
    expect(isAllowed("15555550124@s.whatsapp.net", ["+15555550123", "group:Family"], groups)).toBe(false);
  });
  it("ignores unresolvable entries", () => {
    expect(isAllowed(PHONE, ["nonsense", "group:Nope"], groups)).toBe(false);
  });
});
