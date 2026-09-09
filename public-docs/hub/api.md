---
title: Hub public API
description: Use organization credentials to install triggers, manage legacy configuration, dispatch runs, and enroll daemons.
nav: Public API
order: 79
category: Hub
---

# Hub public API

The Hub public API lets automation operate on triggers, projects, and daemons in one
organization. Set the Hub origin in `PASEO_HUB_URL` below, for example
`https://hub.example.com`.

## API reference

- [Interactive API reference](https://hub.paseo.sh/api/reference)
- [OpenAPI 3.1 document](https://hub.paseo.sh/api/openapi.json)

These are the canonical reference endpoints for the hosted Paseo Hub. A self-hosted Hub exposes the same `/api/reference` and `/api/openapi.json` paths on its own origin.

## Authentication

Run `paseo hub login [origin]` for interactive CLI access. After browser approval, Paseo stores a durable, revocable organization credential under `PASEO_HOME` for that exact origin. Without an explicit origin, the CLI uses `PASEO_HUB_URL`, then the active stored login, then `https://hub.paseo.sh`.

For automation, create an organization API key from the Hub dashboard under **API keys**. Both credential types are bearer tokens:

```http
Authorization: Bearer paseo_pk_...
Content-Type: application/json
```

API keys are organization-scoped. The organization that owns the key determines
which projects and daemon enrollment tokens it can reach; there is no
organization ID to add to these requests. A project slug from another
organization is not accessible through the key.

Each key has one or more selectable scopes:

| Scope                    | Operation                                                             |
| ------------------------ | --------------------------------------------------------------------- |
| `projects:read`          | List active projects in the organization.                             |
| `configuration:validate` | Validate triggers or legacy configuration without changing Hub state. |
| `configuration:install`  | Install triggers or replace a legacy project's configuration.         |
| `runs:dispatch`          | Dispatch a configured manual trigger for a project.                   |
| `daemons:enroll`         | Issue a short-lived daemon enrollment token.                          |

API keys do not grant dashboard access. They cannot manage connections,
projects, or organization members.

CLI credentials have the current CLI operation scopes and remain revocable independently of daemon relationships. `paseo hub logout` deletes the active local CLI credential; it does not revoke or disconnect the daemon identity.

API failures use RFC 9457 problem details. Missing, invalid, or revoked credentials return `401` with `application/problem+json`:

```json
{
  "type": "https://paseo.sh/problems/unauthorized",
  "title": "Authentication required",
  "status": 401,
  "detail": "Provide an active Paseo organization credential in the Authorization: Bearer header.",
  "code": "unauthorized",
  "requestId": "5e967c44-fc22-4f6d-8fc5-1bbff33121af"
}
```

A valid key without the scope required by an endpoint returns `403` in the same format.

## Trigger validation and installation

`paseo hub deploy --dry-run` validates each `.paseo/triggers/*.yml` file through `POST /api/v1/triggers/validate`. `paseo hub deploy` validates all files first, then installs each through `POST /api/v1/triggers/install`.

Both endpoints accept one self-contained document:

```json
{
  "yaml": "name: manual-task\nenabled: true\non:\n  manual.run: {}\nrun:\n  target: { daemon: my-macbook, cwd: /workspace }\n  agent: { provider: codex, model: gpt-5, mode: full-access }\n  prompt: Complete the task and call hub.finish_execution.\n  max_runtime: 1h\n  idle_timeout: 5m\n"
}
```

Use a daemon slug and agent runtime available in your organization. Validation requires `configuration:validate` and returns `200` with `{ "name": "manual-task", "valid": true }`.

Installation requires `configuration:install`. It creates or updates the organization's trigger by the YAML `name` and returns `201`:

```json
{
  "triggerId": "00000000-0000-4000-8000-000000000001",
  "name": "manual-task",
  "revisionId": "00000000-0000-4000-8000-000000000002",
  "version": 1,
  "active": true
}
```

Invalid YAML or an unknown organization resource returns `422` with field issues. Each installation is a separate request; a later failure does not undo earlier successful installs. See [Deploy from the CLI](/docs/hub/configuration#deploy-from-the-cli).

## Project list

`GET /api/v1/projects` returns active projects in the bearer credential's organization. `paseo hub projects` renders the projects as a table. With `--json`, it returns `{ "origin": "...", "projects": [...] }` so even an empty result records the resolved Hub.

```json
{
  "projects": [
    {
      "id": "00000000-0000-4000-8000-000000000000",
      "slug": "my-project",
      "name": "My project"
    }
  ]
}
```

## Legacy configuration validation

`POST /api/v1/configurations/validate` accepts the same `projectSlug` and complete `files` bundle as configuration install. It performs the same compilation and resource resolution without recording a revision or changing the active configuration.

On success, Hub returns `200`:

```json
{
  "projectSlug": "my-project",
  "valid": true
}
```

`paseo hub deploy --project <slug> --dry-run` calls this endpoint with the identical locally resolved payload that a deployment would send.

## Legacy configuration install

`configuration:install` validates the supplied canonical bundle, stores the exact authored files, and activates a new revision.

```http
POST /api/v1/configurations/install
```

Request body:

```json
{
  "projectSlug": "my-project",
  "files": [
    {
      "path": ".paseo/hub.yml",
      "content": "environments:\n  production:\n    kind: daemon\n    daemon: build-server\n    cwd: /workspace\nagents:\n  codex:\n    provider: codex\n"
    },
    {
      "path": ".paseo/workflows/deploy.yml",
      "content": "name: deploy\non: manual.run\nmax_runtime: 2h\nfilters:\n  from_users: [automation]\nsteps:\n  - id: deploy\n    environment: production\n    max_runtime: 90m\n    idle_timeout: 10m\n    agent: codex\n    prompt:\n      - include: partials/safety.md\n"
    },
    {
      "path": ".paseo/workflows/partials/safety.md",
      "content": "Follow the safety checklist."
    }
  ]
}
```

`projectSlug` picks the target project; the bearer credential fixes the organization. `files` contains `.paseo/hub.yml`, every direct workflow `.yml`, and each referenced workflow partial. Hub rejects missing, extra, duplicate, unsafe, or noncanonical paths.

Limits:

- Bundle: at most 100 files.
- File path: at most 512 characters.
- File content: at most 1,000,000 characters.
- Prompt partials: at most 1,000,000 bytes each and 5,000,000 bytes in total.

On success, Hub returns `201`:

```json
{
  "projectSlug": "my-project",
  "versionId": "00000000-0000-4000-8000-000000000000",
  "version": 3,
  "active": true
}
```

Common responses are `400` for a missing or malformed body, `404` for an inactive or unknown project in the key's organization, and `422` for invalid YAML or an invalid configuration. Validation problem details include field issues. A failed install does not replace the active revision.

Example:

```bash
curl --fail-with-body -sS -X POST "$PASEO_HUB_URL/api/v1/configurations/install" \
  -H "Authorization: Bearer $PASEO_HUB_API_KEY" \
  -H "Content-Type: application/json" \
  --data @configuration-install.json
```

`paseo hub deploy -p <project>` selects this legacy endpoint with the discovered local bundle. The command uses an exact-origin stored login when flags and environment credentials are absent. See [Deploy from the CLI](/docs/hub/configuration#deploy-from-the-cli).

## Manual run dispatch

`runs:dispatch` dispatches a configured `manual.run` trigger for a project.
The trigger must exist in the active configuration, and `actor` must be listed
in that trigger's `filters.from_users` allowlist.

```http
POST /api/v1/manual-runs
```

Request body:

```json
{
  "projectSlug": "my-project",
  "expectedVersionId": "00000000-0000-4000-8000-000000000000",
  "trigger": "deploy",
  "actor": "automation",
  "deliveryKey": "deploy-2026-08-04-001",
  "input": "repo=project investigate the failed sync"
}
```

- `expectedVersionId` is optional. When supplied, Hub rejects the dispatch if that revision is no longer active.
- `input` is the same string a provider message uses: leading `key=value` tokens are parsed as declared inputs, and the remainder becomes `${{ paseo.prompt }}`.
- `deliveryKey` should be unique and stable per dispatch. Hub uses it for durable deduplication, but does not promise exactly-once dispatch or replay of an earlier response.

On success, Hub returns `200`:

```json
{
  "deliveryKey": "deploy-2026-08-04-001",
  "providerEventReceiptId": "00000000-0000-4000-8000-000000000000",
  "triggerRunId": "00000000-0000-4000-8000-000000000000",
  "configuredTriggerName": "deploy",
  "workflowStatus": "running"
}
```

Common responses are `400` for an invalid request, `403` when the actor is not allowed by the trigger, `404` for an unknown project, configuration, or trigger, and `409` when the daemon is offline, the expected configuration is no longer current, or dispatch conflicts. Each uses the problem-details shape above.

Example:

```bash
curl --fail-with-body -sS -X POST "$PASEO_HUB_URL/api/v1/manual-runs" \
  -H "Authorization: Bearer $PASEO_HUB_API_KEY" \
  -H "Content-Type: application/json" \
  --data '{
    "projectSlug": "my-project",
    "trigger": "deploy",
    "actor": "automation",
    "deliveryKey": "deploy-2026-08-04-001",
    "input": "repo=project investigate the failed sync"
  }'
```

See [Hub workflows](/docs/hub/workflows) for input types, defaults, choices,
rejected input, and manual invocation examples.

## Daemon enrollment

`daemons:enroll` issues a short-lived enrollment token for a daemon. The API
key mints this token; it is not the daemon's long-lived credential and must not
be used as one.

```http
POST /api/v1/daemons/enrollment-tokens
```

No request body is required. On success, Hub returns `201`:

```json
{
  "token": "short-lived-enrollment-token",
  "expiresAt": "2026-08-04T12:10:00.000Z"
}
```

The token expires after 10 minutes and is consumed when the daemon enrolls.

`paseo hub connect [origin]` performs this request with `--api-key`, `PASEO_HUB_API_KEY`, or the matching stored login, then passes the one-time token to the daemon's enrollment operation. The daemon generates and keeps its own relationship credential.

```bash
curl --fail-with-body -sS -X POST \
  "$PASEO_HUB_URL/api/v1/daemons/enrollment-tokens" \
  -H "Authorization: Bearer $PASEO_HUB_API_KEY"
```

Direct API consumers can pass the returned token to the daemon enrollment protocol. The Paseo CLI intentionally does not accept raw enrollment tokens; `connect` owns the authenticated single-flow exchange.

An enrollment token cannot be reused. Revoking the API key immediately rejects
future API requests and expires any unconsumed enrollment tokens that key
issued. A race between revocation and issuance is resolved by Hub before a new
token is stored.

## Keys, scopes, and audit information

The complete API-key secret is shown once, immediately after creation. Store it
in your deployment's secret manager; Hub does not show it again. The dashboard
retains only the key's prefix and shows its selected scopes, creation time,
last-used time, and status.

Hub updates `last used` after a key successfully authenticates for a scoped API
operation. API operations retain the key attribution in Hub's audit evidence,
so configuration revisions, manual dispatches, and daemon enrollment tokens
can be traced to the organization key that created them.
