---
id: T16
title: AppArmor profile blocks s6-overlay /init on Home Assistant OS
status: review
depends_on: [T14]
wave: 6
---
## Goal
The add-on starts under Supervisor's AppArmor confinement.

## Bug
On Home Assistant OS, v0.1.0 installs and accepts its configuration, but goes straight to `error` on start. The whole log is:

    /bin/sh: can't open '/init': Permission denied

The profile in `apparmor.txt` had no rules for s6-overlay. The base image's entrypoint `/init` is a shell script, so it needs read permission as well as exec, and the `/package` and `/command` trees need the same. CI and `scripts/smoke.sh` ran without AppArmor, so they didn't catch it.

## Files
- `whatsapp_gateway/apparmor.txt`
- `scripts/smoke.sh`: a `SMOKE_DOCKER_ARGS` hook
- `.github/workflows/ci.yml`: new `addon-apparmor` job
- versions bumped to 0.1.1 (`config.yaml`, `package.json`, `package-lock.json`, `manifest.json`), plus both CHANGELOGs and `docs/spec.md` §7

## Acceptance criteria
- The `addon-apparmor` CI job loads the profile, the smoke test passes under `--security-opt apparmor=whatsapp_gateway`, and `dmesg` shows no denials for the profile.
- The add-on starts on a real Home Assistant OS install (verified manually by the maintainer).

## Questions / notes

## Implementation notes
- The profile uses `rix` for s6-overlay scripts, and adds `chown/dac_override/dac_read_search/fowner/fsetid/kill/setgid/setuid` capabilities, `unix`, and `signal`. `/data/{,**}` and `/app/{,**}` now include the directories themselves.
