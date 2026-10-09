---
id: T17
title: Minimal history sync for LID mappings; accurate security docs
status: review
depends_on: [T05, T13]
wave: 6
---
## Goal
Two findings from the first real install:
1. **Baileys warning.** At startup Baileys logs `DISABLING ALL SYNC BY shouldSyncHistoryMsg PREVENTS BAILEYS FROM ACCESSING INITIAL LID MAPPINGS, LEADING TO INSTABILIY AND SESSION ERRORS`, because every history-sync type was refused.
2. **Overstated security docs.** A host-network add-on reached the API with the key and got 200. HA Core uses host networking and connects from the Supervisor bridge gateway (usually `172.30.32.1`), and every host-network add-on shares that address. The docs said only Core could connect.

## Files
- `whatsapp_gateway/src/whatsapp.ts` and `test/whatsapp.test.ts`
- `README.md`, `whatsapp_gateway/DOCS.md`, `docs/spec.md` (§2.1, §3.5) and `CLAUDE.md`
- Versions bumped to 0.1.2, plus both CHANGELOGs

## Acceptance criteria
- `shouldSyncHistoryMessage` allows only `INITIAL_BOOTSTRAP`, `PUSH_NAME` and `NON_BLOCKING_DATA`. The warning no longer appears, and no message or history event is subscribed.
- The docs describe the host-network limit of the IP filter and make clear that the bearer key is the boundary for those add-ons.

## Questions / notes
- Mappings learned only from the initial bootstrap won't arrive for a session that was already paired before this change. Baileys still learns mappings from usync and live events. Re-pairing is not required.

## Implementation notes
- `SYNCED_HISTORY_TYPES` in `whatsapp.ts` uses `proto.Message.HistorySyncType`, which is the type the callback receives.
