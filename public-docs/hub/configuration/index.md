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

Pick a GitHub source by choosing a repository and clicking **Use for configuration**. That syncs immediately and enables automatic deployment.

The path and the branch are fixed. There is no setting for either.

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

Next: the [`hub.yml` reference](/docs/hub/configuration/hub-yml).
