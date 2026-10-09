---
id: T12
title: GitHub Actions CI and Dependabot
status: done
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

## Implementation notes
- `ci.yml` has the seven spec §7 jobs (`gateway`, `integration`, `hassfest`, `hacs`, `addon-lint`, `addon-build`, `secrets`). Top-level `permissions: contents: read`; `concurrency` per workflow and ref with cancel-in-progress. `actionlint` passes with no findings.
- Pins: checkout v7.0.1, setup-node v7.1.0, setup-python v7.0.0, home-assistant/actions/hassfest 1.0.0, hacs/action 22.5.0, frenck/action-addon-linter v2.21.1, home-assistant/builder 2026.09.0 (`actions/build-image`), gitleaks-action v3.0.0. All by full SHA with version comments.
- `gateway` uses `node-version-file: .nvmrc` (root `.nvmrc` is added by T02), with the npm cache keyed on `whatsapp_gateway/package-lock.json`.
- Deviation from spec §7 (`addon-build`): the legacy `home-assistant/builder` action (`--test --amd64 --aarch64 --target`) is deprecated, and it derives its builder image tag from the action ref, so pinning it by SHA makes the tag a SHA and the image pull fails. The job uses the maintained `home-assistant/builder/actions/build-image` instead, with `push: false`, `cosign: false`, and a matrix of amd64 (`ubuntu-latest`) and aarch64 (`ubuntu-24.04-arm`). It passes `BUILD_FROM=ghcr.io/home-assistant/<arch>-base:latest` as a build arg, and the action itself adds `BUILD_ARCH` and `BUILD_VERSION`.
- `hacs` sets `comment: "false"` so the job needs no write permission. `secrets` adds `pull-requests: read` at job level and sets `GITHUB_TOKEN` and `GITLEAKS_CONFIG=.gitleaks.toml`. No gitleaks license key is needed for a personal-account repo.

## Questions / notes
- T14 (Dockerfile) should accept `ARG BUILD_FROM`, `BUILD_ARCH` and `BUILD_VERSION`, and live at `whatsapp_gateway/Dockerfile` (the build context is `whatsapp_gateway/`).
- `hacs/action` may fail on first run until the repo has a `hacs.json`-compatible layout, topics and a description. It may also need `ignore: brands` if HA brands checks apply.
- `home-assistant/builder` has a `docker/build-push-action` dependency chain pinned inside the action, which Dependabot cannot update through us.
