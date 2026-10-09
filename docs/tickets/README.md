# Tickets

Source of truth for the work breakdown. Spec: [../spec.md](../spec.md). HTTP contract: [../api.md](../api.md).

## Conventions
- Each ticket is `TNN-slug.md` with frontmatter: `id`, `title`, `status`, `depends_on`, `wave`.
- **Status flow:** `todo`, then `in-progress`, then `review` (implementer finished and tests pass), then `done` (reviewed and merged to `main`).
- **File ownership:** a ticket edits only the files listed under **Files**. If it needs to change a file another ticket owns, it doesn't change it. Instead it writes the need under **Questions / notes** in its own ticket and stops there.
- **Ambiguity:** don't guess. Record the question under **Questions / notes**, take the most conservative reading that the spec allows, and say so.
- **Public repo:** follow spec §1. Placeholders only, no personal data, and never log keys or message bodies.
- **Done means:** every acceptance criterion is met, the listed tests exist and pass locally, lint and typecheck are clean, and the ticket's status is set to `review` with a short **Implementation notes** section added.
- **Branch:** `ticket/TNN`. Commit messages: `TNN: <summary>`.

## Index
| ID | Title | Status | Depends on | Wave |
|---|---|---|---|---|
| [T01](T01-repo-scaffold.md) | Repo scaffold | done | none | 1 |
| [T02](T02-gateway-scaffold.md) | Gateway scaffold, options, client interface, fake client | done | T01 | 2 |
| [T08](T08-integration-scaffold.md) | Integration scaffold, API client, config flow | done | T01 | 2 |
| [T12](T12-ci.md) | GitHub Actions CI and Dependabot | done | T01 | 2 |
| [T03](T03-jid.md) | Target resolution and allowlist (`jid.ts`) | done | T02 | 3 |
| [T04](T04-queue-media.md) | Send queue and media loader | done | T02 | 3 |
| [T05](T05-baileys-client.md) | Baileys client and group cache | done | T02 | 3 |
| [T09](T09-options-notify.md) | Recipients options flow and notify entities | done | T08 | 3 |
| [T10](T10-services.md) | `send_message` and `list_groups` services | done | T08 | 3 |
| [T11](T11-binary-sensor.md) | Connected binary sensor | done | T08 | 3 |
| [T06](T06-http-api.md) | HTTP API server, IP filter, auth | done | T03, T04 | 4 |
| [T07](T07-ingress.md) | Ingress status page | done | T05, T06 | 4 |
| [T13](T13-docs.md) | User docs: README, DOCS.md, CHANGELOG | todo | T05–T11 | 5 |
| [T14](T14-wire-up.md) | Wire-up, Docker build, smoke test | todo | T05, T06, T07 | 5 |
| [T15](T15-release-hygiene.md) | Release hygiene and CLAUDE.md refresh | todo | all | 5 |
