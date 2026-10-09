---
id: T01
title: Repo scaffold
status: done
depends_on: []
wave: 1
---
## Goal
Create the repository skeleton so that it is a valid HA add-on repository and HACS custom repository, and make the first commit.

## Spec refs
spec §1, §2, §4.1, §8

## Files
- `repository.yaml`: name "WhatsApp Notifications add-ons", url `https://github.com/cookejames/ha-whatsapp-notifications`, maintainer `cookejames`
- `hacs.json`: `{"name": "WhatsApp (Gateway)", "homeassistant": "<current HA min version>", "render_readme": true}`
- `.gitignore`: Node, Python, `data/`, `auth/`, `.env*`, `options.json`, coverage, `.venv`, `.DS_Store`
- `.gitleaks.toml`: extends the default config, and allowlists the documented placeholder values from spec §1
- `.editorconfig`
- `LICENSE`: MIT; the holder is given by the orchestrator
- `README.md`: stub with the title, one-paragraph description, unofficial-client disclaimer, and "Documentation coming soon"
- `docs/` already exists (spec, api, tickets) and is committed as-is

## Acceptance criteria
- `repository.yaml` and `hacs.json` are valid YAML/JSON.
- `gitleaks detect --no-git` on the working tree reports no leaks.
- The first commit uses the agreed commit identity, set as repo-local `git config`.

## Tests to write
None (config only).

## Out of scope
Add-on and integration code.

## Questions / notes

## Implementation notes
Done by the orchestrator. gitleaks v8.21.2 (via Docker) reports no leaks on the working tree. HACS minimum HA version is 2025.1.0 (NotifyEntity and `entry.runtime_data` are both available).
