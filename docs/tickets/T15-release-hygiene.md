---
id: T15
title: Release hygiene and CLAUDE.md refresh
status: todo
depends_on: [T01, T02, T03, T04, T05, T06, T07, T08, T09, T10, T11, T12, T13, T14]
wave: 5
---
## Goal
The repo is ready to be public and stay public.

## Spec refs
spec §1, §8

## Files
- `CLAUDE.md`: refreshed so it documents the real commands, architecture and conventions; generic content only
- Any file where hygiene fixes are needed. Coordinate through the orchestrator.

## Acceptance criteria
- `gitleaks detect` over the full history is clean.
- The orchestrator's private deny-list scan (run outside the repo) over `git log -p --all` is clean.
- Versions are consistent across `config.yaml`, `manifest.json` and the CHANGELOGs.
- All tickets are `done`.

## Tests to write
None.

## Out of scope
New features.

## Questions / notes
