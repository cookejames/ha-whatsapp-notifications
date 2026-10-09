---
id: T12
title: GitHub Actions CI and Dependabot
status: todo
depends_on: [T01]
wave: 2
---
## Goal
Set up CI on GitHub Actions as defined in spec §7.

## Spec refs
spec §7

## Files
- `.github/workflows/ci.yml`
- `.github/dependabot.yml`

## Acceptance criteria
- The jobs in spec §7 exist, with `permissions: contents: read` at the top level.
- Every third-party action is pinned to a full commit SHA with a `# vX.Y.Z` comment. Look up the current release SHAs with `gh api` or `git ls-remote`.
- `concurrency` cancels superseded runs on the same ref.
- `actionlint` passes locally, if available. If it isn't, run it with `docker run --rm -v "$PWD:/repo" -w /repo rhysd/actionlint:latest`, or record that it wasn't run.
- Job paths match the layout in spec §3/§4. The jobs don't need to pass until wave 2 is merged.

## Tests to write
None (actionlint is the check).

## Out of scope
Release or publish workflows.

## Questions / notes
