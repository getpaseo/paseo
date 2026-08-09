---
title: Hub public API
description: Use organization credentials to list projects, validate or install configuration, dispatch runs, and enroll daemons.
nav: Public API
order: 79
category: Hub
---

# Hub public API

The Hub public API lets automation operate on projects and daemons in one
organization. Set the Hub origin in `PASEO_HUB_URL` below, for example
`https://hub.example.com`.

## API reference

- [Interactive API reference](https://hub.paseo.sh/api/reference)
- [OpenAPI 3.1 document](https://hub.paseo.sh/api/openapi.json)

These are the canonical reference endpoints for the hosted Paseo Hub. A self-hosted Hub exposes the same `/api/reference` and `/api/openapi.json` paths on its own origin.

## Authentication

Run `paseo hub login [origin]` for interactive CLI access. Hub returns a durable, revocable organization-scoped CLI credential after browser approval, and Paseo stores it privately under `PASEO_HOME` for that exact normalized origin. Without an explicit origin, the CLI uses `PASEO_HUB_URL`, then the active stored login origin, then `https://hub.paseo.sh`.

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

| Scope                    | Operation                                           |
| ------------------------ | --------------------------------------------------- |
| `projects:read`          | List active projects in the organization.           |
| `configuration:validate` | Validate configuration without changing Hub state.  |
| `configuration:install`  | Replace and activate a project's configuration.     |
| `runs:dispatch`          | Dispatch a configured manual trigger for a project. |
| `daemons:enroll`         | Issue a short-lived daemon enrollment token.        |

API keys do not grant dashboard access. They cannot manage connections,
projects, or organization members.

CLI credentials have the current CLI operation scopes and remain revocable independently of daemon relationships. `paseo hub logout` deletes the active local CLI credential; it does not revoke or disconnect the daemon identity.

API failures use RFC 9457 problem details. Missing, invalid, or revoked credentials return `401` with `application/problem+json`:

```json
{
  "type": "https://hub.example.com/problems/unauthorized",
  "title": "Unauthorized",
  "status": 401,
  "detail": "Provide a valid organization API key."
}
```

A valid key without the scope required by an endpoint returns `403` in the same format.

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

## Configuration validation

`POST /api/v1/configurations/validate` accepts the same `projectSlug`, `yaml`, and optional `partials` body as configuration install. It performs the same compilation and resource resolution without recording a revision or changing the active configuration.

On success, Hub returns `200`:

```json
{
  "projectSlug": "my-project",
  "valid": true
}
```

`paseo hub deploy --dry-run` calls this endpoint with the identical locally resolved payload that a deployment would send.

## Configuration install

`configuration:install` replaces the project's current configuration with the
supplied YAML after Hub validates and compiles it, then activates the new
revision.

```http
POST /api/v1/configurations/install
```

Request body:

```json
{
  "projectSlug": "my-project",
  "yaml": "environments:\n  - name: production\n    kind: daemon\n    daemon: build-server\n    cwd: /workspace\ntriggers:\n  - name: deploy\n    on: manual.run\n    max_runtime: 2h\n    filters:\n      from_users: [automation]\n    steps:\n      - id: deploy\n        environment: production\n        max_runtime: 90m\n        idle_timeout: 10m\n        agent:\n          provider: opencode\n          mode: full-access\n        prompt:\n          - text: Deploy the project",
  "partials": [
    {
      "path": "docs/safety.md",
      "content": "Follow the safety checklist."
    }
  ]
}
```

The YAML must describe a valid Hub configuration and its string value is limited to 1,000,000 characters. `projectSlug` is deployment metadata and determines the target project; the API key determines its organization. `partials` is optional for inline-only configurations. When the YAML uses prompt `include` blocks, send exactly one entry for each referenced file, with a path relative to `.paseo/partials/` and the file's UTF-8 content. The bundle accepts at most 100 files, each with a canonical path no longer than 512 characters and content no larger than 1,000,000 bytes; combined partial content may not exceed 5,000,000 bytes. Hub rejects missing, extra, duplicate, unsafe, or oversized entries. Replace the example daemon, working directory, and trigger values with resources in your organization.

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

For a local YAML file, `paseo hub deploy [file]` calls this endpoint and preserves the file contents. The command uses an exact-origin stored login when flags and environment credentials are absent. See [Deploy from the CLI](/docs/hub/configuration#deploy-from-the-cli) for project precedence and credential precedence.

## Manual run dispatch

`runs:dispatch` dispatches a configured `manual.run` trigger for a project.
The trigger must exist in the active configuration, and `actor` must be listed
in that trigger's `filters.from_users` allowlist.

```http
POST /api/manual-runs
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

`expectedVersionId` is optional. When supplied, Hub rejects the dispatch if
that configuration revision is no longer active. `input` is the same string
used by a provider message: consecutive leading `key=value` tokens are parsed
as the trigger's declared inputs, and the remainder becomes `${{ paseo.prompt }}`.
Use a unique, stable `deliveryKey` for each dispatch. Reusing it makes the
request resolve to the existing trigger instead of starting a duplicate run.

On success, Hub returns `200`:

```json
{
  "deliveryKey": "deploy-2026-08-04-001",
  "triggerId": "00000000-0000-4000-8000-000000000000",
  "executionId": "00000000-0000-4000-8000-000000000000",
  "status": "spawning",
  "daemonId": "00000000-0000-4000-8000-000000000000",
  "agentId": "agent-id"
}
```

Common responses are `400 {"error":"invalid_request"}`, `404` for an
unknown project, missing configuration, or missing trigger, `403
{"error":"actor_forbidden"}` when the actor is not allowed by the trigger,
and `409` when the daemon is offline, the expected configuration is no longer
current, or the run could not be dispatched.

Example:

```bash
curl --fail-with-body -sS -X POST "$HUB_URL/api/manual-runs" \
  -H "Authorization: Bearer $PASEO_API_KEY" \
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

Send an empty JSON object as the request body. On success, Hub returns `201`:

```json
{
  "token": "short-lived-enrollment-token",
  "expiresAt": "2026-08-04T12:10:00.000Z"
}
```

The token expires after 10 minutes and is consumed when the daemon enrolls.
`paseo hub connect [origin]` performs this request with `--api-key`, `PASEO_HUB_API_KEY`, or the matching stored login, then passes the returned one-time token to the daemon's existing enrollment operation. Without an origin, it uses `PASEO_HUB_URL`, the active stored login origin, then `https://hub.paseo.sh`. The daemon generates and retains its own relationship credential.

```bash
curl --fail-with-body -sS -X POST \
  "$HUB_URL/api/v1/daemons/enrollment-tokens" \
  -H "Authorization: Bearer $PASEO_API_KEY" \
  -H "Content-Type: application/json" \
  --data '{}'
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
