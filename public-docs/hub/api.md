---
title: Hub public API
description: Use organization API keys to install configuration, dispatch manual runs, and enroll daemons.
nav: Public API
order: 78
category: Hub
---

# Hub public API

The Hub public API lets automation operate on projects and daemons in one
organization. Set the Hub origin in `PASEO_HUB_URL` below, for example
`https://hub.example.com`.

## Authentication

Create an organization API key from the Hub dashboard under **API keys**. Send
it as a bearer token on every API request:

```http
Authorization: Bearer paseo_pk_...
Content-Type: application/json
```

API keys are organization-scoped. The organization that owns the key determines
which projects and daemon enrollment tokens it can reach; there is no
organization ID to add to these requests. A project slug from another
organization is not accessible through the key.

Each key has one or more selectable scopes:

| Scope                   | Operation                                           |
| ----------------------- | --------------------------------------------------- |
| `configuration:install` | Replace and activate a project's configuration.     |
| `runs:dispatch`         | Dispatch a configured manual trigger for a project. |
| `daemons:enroll`        | Issue a short-lived daemon enrollment token.        |

API keys do not grant dashboard access. They cannot manage connections,
projects, or organization members.

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
  "yaml": "environments:\n  - name: production\n    kind: daemon\n    daemon: build-server\n    cwd: /workspace\ntriggers:\n  - name: deploy\n    on: manual.run\n    max_runtime: 2h\n    filters:\n      from_users: [automation]\n    steps:\n      - id: deploy\n        environment: production\n        max_runtime: 90m\n        idle_timeout: 10m\n        agent:\n          provider: opencode\n          mode: full-access\n        prompt:\n          - text: Deploy the project"
}
```

The YAML must describe a valid Hub configuration. `projectSlug` is deployment metadata and determines the target project; the API key determines its organization. Replace the example daemon, working directory, and trigger values with resources in your organization.

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

For a local YAML file, `paseo hub deploy [file]` calls this endpoint and preserves the file contents. See [Deploy from the CLI](/docs/hub/configuration#deploy-from-the-cli) for project precedence, flags, environment variables, and the current authentication limits.

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
POST /api/daemons/enrollment-tokens
```

Send an empty JSON object as the request body. On success, Hub returns `201`:

```json
{
  "token": "short-lived-enrollment-token",
  "expiresAt": "2026-08-04T12:10:00.000Z"
}
```

The token expires after 10 minutes and is consumed when the daemon enrolls.
Pass it to the Paseo CLI, which exchanges it for the daemon's connection
credential:

```bash
ENROLLMENT_TOKEN="$(curl --fail-with-body -sS -X POST \
  "$HUB_URL/api/daemons/enrollment-tokens" \
  -H "Authorization: Bearer $PASEO_API_KEY" \
  -H "Content-Type: application/json" \
  --data '{}' | jq -r .token)"

paseo hub connect "$HUB_URL" --token "$ENROLLMENT_TOKEN"
```

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
