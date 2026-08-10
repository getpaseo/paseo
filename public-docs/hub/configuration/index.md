---
title: Hub configuration
description: Configuration bundles, GitHub sync, CLI deployment, and revisions.
nav: Configuration
order: 70
category: Hub
---

# Hub configuration

A project configuration is one versioned bundle:

```text
.paseo/
├── hub.yml
└── workflows/
    ├── <workflow>.yml
    └── partials/
        └── <partial>.md
```

`hub.yml` owns named environments and agents. Each direct-child workflow file owns one trigger and its ordered inline steps. Prompt partials referenced by those workflows live below `workflows/partials/`. Workflow discovery is fixed by convention; there is no manifest or include list.

## Sources

A configuration comes from one source:

- **GitHub source**: the complete `.paseo` bundle on the repository's default branch.
- **Manual source**: source files edited and activated in the dashboard.
- **CLI/API install**: a complete bundle sent with organization authority.

The **Configuration** tab shows the active revision, source files, and latest synchronization attempt.

## Deploy from the CLI

Run from the project root:

```sh
paseo hub login https://hub.example.com
paseo hub deploy -p my-project --dry-run
paseo hub deploy -p my-project
```

Both commands discover `.paseo/hub.yml`, every direct `.paseo/workflows/*.yml` file, and each referenced file below `.paseo/workflows/partials/`. Files are sent in deterministic path order through the same bundle request. Dry-run calls server-side validation and does not create or activate a revision.

The CLI rejects missing resource or workflow files, `.yaml` workflow extensions, nested workflow files, unsafe partial paths, symlinked bundle paths, and unreadable files before contacting Hub. Errors name paths but never print file contents or credentials.

Origin precedence:

1. `--hub`
2. `PASEO_HUB_URL`
3. Active stored login
4. `https://hub.paseo.sh`

Credential precedence:

1. `--api-key`
2. `PASEO_HUB_API_KEY`
3. Stored login for the exact resolved origin

Flags and environment keys are not stored. Endpoint and credential behavior is unchanged between deploy and dry-run.

## GitHub sync

A push to the configuration repository's default branch starts a sync:

1. Hub discovers the canonical bundle at that exact commit.
2. It parses every source file and resolves prompt partials.
3. It validates named resources, expressions, connections, and daemon availability.
4. On success, the new immutable revision becomes active.

**Sync now** performs the same operation on demand. Failures retain their source path and authored field. A failed sync never replaces the active revision.

## Revisions and source changes

Revisions retain the exact authored files needed to inspect or redeploy them. Rolling back activates an earlier revision. The next valid GitHub push activates a new revision again.

GitHub-backed configuration is read-only in the dashboard. Switching to manual preserves source documents; it does not collapse the bundle into one generated file.

The configuration repository may differ from repositories named by `filters.repo`. Protect it because changing the bundle can select connections, daemons, working directories, agents, and outputs. See [Hub security](/docs/hub/security).

Next: the [configuration reference](/docs/hub/configuration/hub-yml) and [workflow examples](/docs/hub/workflows).
