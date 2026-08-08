---
title: Hub configuration
description: Where a project's configuration comes from, how GitHub sync works, and how revisions activate and roll back.
nav: Configuration
order: 68
category: Hub
---

# Hub configuration

A project is configured by one versioned document. The project's **Configuration** tab shows the active revision, its source, and the last synchronization attempt.

## Sources

A configuration comes from exactly one source:

- **GitHub source**: one repository, the file `.paseo/hub.yml`, on the repository's current default branch.
- **Manual source**: edited in the dashboard and saved with **Save and activate**.
- **CLI/API install**: YAML sent explicitly with an organization API key.

Pick a GitHub source by choosing a repository and clicking **Use for configuration**. That syncs immediately and enables automatic deployment.

The path and the branch are fixed. There is no setting for either.

## Deploy from the CLI

From a project checkout, add the target project slug as optional deployment metadata:

```yaml
project: my-project
```

Then deploy:

```sh
paseo hub login https://hub.example.com
paseo hub deploy --dry-run
paseo hub deploy
```

The default path is exactly `.paseo/hub.yml` relative to the current directory. The CLI does not search parent directories or alternate filenames. Use `paseo hub deploy path/to/config.yml` for another file. The bundle root remains the current directory, so partials are always read from `.paseo/partials/` under that directory. `-p, --project <slug>` overrides the file's `project` value without changing the YAML sent to Hub.

For each prompt `include`, the CLI sends one `{ path, content }` entry whose path is relative to `.paseo/partials/`. It sends only files referenced by the main YAML; nested include-looking text inside a partial is not scanned. Missing, unsafe, duplicate, unreadable, non-file, or oversized inputs fail locally before the Hub request. A configuration with only inline prompt blocks sends no `partials` field.

`--dry-run` sends the identical resolved YAML, project slug, and prompt-partial bundle to `POST /api/v1/configurations/validate`. Hub performs the same compilation and resource resolution as installation but records and activates nothing.

Origin precedence is `--hub`, `PASEO_HUB_URL`, the active stored login, then `https://hub.paseo.sh`. Credential precedence is `--api-key`, `PASEO_HUB_API_KEY`, then an exact-origin stored login. API keys passed by flag or environment are not stored. A stored credential is organization-scoped and is never reused for a different Hub origin. Deploy and dry-run report the normalized destination before sending anything and include it in structured results.

## Sync

A push to the default branch of the configuration repository triggers a sync:

1. Hub fetches `.paseo/hub.yml` at that exact commit.
2. It validates the document and resolves every repository, workspace, guild, and daemon it names.
3. On success the revision becomes active.

**Sync now** does the same on demand.

Every attempt is recorded, including failures. The outcomes you will see:

| Outcome                 | What happened                                                                   |
| ----------------------- | ------------------------------------------------------------------------------- |
| Activated               | Valid document, everything resolved, now serving events.                        |
| Invalid                 | The document failed validation or named something the organization can't reach. |
| Fetch failed            | The file is missing, or GitHub could not be read.                               |
| Superseded push ignored | A newer commit already moved the branch head.                                   |

A failed sync never replaces the active revision. A repository with a broken `hub.yml` keeps serving the last good one.

## Revisions

Revisions are immutable and numbered per project. Rolling back selects an earlier revision and recompiles its routes. The next valid push activates again, so rollback holds only until the next push.

## Switching source

Switching from GitHub to manual copies the active revision into the editor and stops syncing. Switching back means choosing a repository again.

While a project uses a GitHub source, the dashboard editor is read-only. The repository is the source of truth.

## The configuration repository does not have to be the repository you watch

`filters.repo` can name any repository the organization has a connection for. Keeping `hub.yml` in a private repository while triggers watch several public ones is a common setup, because push access to the configuration repository grants access to the organization's connections.

Treat the configuration repository as part of the security boundary. [Hub security](/docs/hub/security) covers what a changed configuration can authorize and how to limit the resulting agent process.

Next: [Hub workflows](/docs/hub/workflows), then the [`hub.yml` reference](/docs/hub/configuration/hub-yml).
