---
id: T03
title: Target resolution and allowlist (jid.ts)
status: review
depends_on: [T02]
wave: 3
---
## Goal
Implement target parsing and normalisation, group name resolution, and the allowlist check.

## Spec refs
spec §3.7; api.md per-target error codes

## Files
- `whatsapp_gateway/src/jid.ts`: `resolveTarget(input, groups)`, `isAllowed(jid, allowedTargets, groups)`, `normalisePhone(input)`
- `whatsapp_gateway/test/jid.test.ts`

## Acceptance criteria
- All the rules in spec §3.7 hold, in the stated order.
- Group name matching is case-insensitive, trims whitespace, and only considers groups with `isMember: true`.
- `unknown_group` suggestions: at most 3, from substring matches plus Levenshtein distance ≤ 3 (implemented locally, no new dependency), formatted `Name (jid)`.
- `@c.us` normalises to `@s.whatsapp.net`.
- Pure functions with no I/O. Coverage ≥ 85%.

## Tests to write
- phone variants: `+1 (555) 555-0123`, `15555550123`, too short, too long, letters
- each JID suffix
- `group:` exact match, case differences, ambiguous, unknown with suggestions, not a member
- allowlist: empty list, phone entry, group-name entry, group JID entry, a denied target

## Out of scope
The network, the queue, HTTP.

## Questions / notes
- `ErrorCode` is referenced by spec §3.7 but not defined in any shared module yet. `jid.ts` exports a local `ErrorCode` union of the five per-target codes it produces (`invalid_target`, `unknown_group`, `ambiguous_group`, `not_a_member`, `target_not_allowed`). T06 may want a shared definition; it can widen or replace this one.

## Implementation notes
- `resolveTarget`, `isAllowed`, `normalisePhone` and the `ResolveResult` / `ErrorCode` types are exported from `whatsapp_gateway/src/jid.ts`. Pure functions, no I/O, local Levenshtein.
- Rules run in spec order. Matching is case-insensitive; suffix-form JIDs are returned lower-cased.
- `@c.us` is handled with the other JID suffixes (local part must be digits, any length) rather than through the 7-15 digit phone check. Conservative reading of rules 3 and 4.
- Suggestions: substring matches (either direction) first, then by Levenshtein distance, max 3, member groups only. An empty `group:` name gives `unknown_group` with no substring suggestions.
- `isAllowed`: an empty list allows all. A group JID entry matches literally without needing the group in the cache. Entries that do not resolve (invalid, unknown group, non-member) never match, so a non-empty list of bad entries denies everything. The caller maps a false result to `target_not_allowed`.
- Verification: lint, typecheck and tests pass; `jid.ts` line coverage 100%.
