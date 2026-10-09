---
id: T03
title: Target resolution and allowlist (jid.ts)
status: todo
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
