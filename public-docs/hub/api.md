---
title: Hub public API
description: Authenticate with organization credentials to validate and install triggers, rotate webhook secrets, dispatch manual runs, and enroll daemons.
nav: Public API
order: 83
category: Hub
---

# Hub public API

The Hub public API lets scripts and CI pipelines manage triggers, webhook secrets, manual runs, and daemon enrollment for one organization. Set `PASEO_HUB_URL` to your Hub origin, such as `https://hub.example.com`.

## API reference

- [Interactive API reference](https://hub.paseo.sh/api/reference)
- [OpenAPI 3.1 document](https://hub.paseo.sh/api/openapi.json)

A self-hosted Hub serves the same `/api/reference` and `/api/openapi.json` endpoints on its own origin.

## Authentication

For interactive CLI access, run `paseo hub login [origin]`. Paseo stores a revocable organization credential under `PASEO_HOME` for that exact origin.

For automation, create an organization API key in Hub under **Settings → API keys**. Send either credential as a Bearer token:

```http
Authorization: Bearer paseo_pk_...
Content-Type: application/json
```

API keys are scoped to one organization and one or more selected scopes:

| Scope                    | Operations permitted                                             |
| ------------------------ | ---------------------------------------------------------------- |
| `configuration:validate` | List triggers, list resolvable resources, and validate triggers. |
| `configuration:install`  | Install triggers and create or rotate trigger webhook secrets.   |
| `runs:dispatch`          | Dispatch a configured `manual.run` trigger.                      |
| `daemons:enroll`         | Issue a short-lived daemon enrollment token.                     |
| `projects:read`          | List projects in the organization.                               |

API keys do not grant dashboard sign-in and cannot manage integrations or organization members.

API errors return RFC 9457 `application/problem+json` with an `X-Request-ID` header. Missing, invalid, or revoked credentials return `401` with `WWW-Authenticate: Bearer`:

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

A valid credential missing the required scope returns `403` in the same format.

## Trigger list, validation, and installation

- `GET /api/v1/triggers` (`configuration:validate`) lists active organization triggers and their deployable YAML documents.
- `POST /api/v1/triggers/validate` (`configuration:validate`) validates one self-contained trigger YAML document without changing Hub state.
- `POST /api/v1/triggers/install` (`configuration:install`) validates and installs one trigger, creating or updating it by its YAML `name`.

`POST /api/v1/triggers/validate` and `POST /api/v1/triggers/install` accept the same JSON request body:

```json
{
  "yaml": "name: manual-task\nenabled: true\non:\n  manual.run: {}\nrun:\n  target: { daemon: my-macbook, cwd: /workspace }\n  agent: { provider: codex, mode: full-access }\n  prompt: |\n    Complete the task and call finish_execution.\n    ${{ paseo.prompt }}\n  max_runtime: 1h\n  idle_timeout: 5m\n"
}
```

Both endpoints ask the target daemon to validate `run.agent`, so that daemon must be connected and hold `hub.execute`. Validation returns `200` with `{ "name": "manual-task", "valid": true }`. Installation returns `201`:

```json
{
  "triggerId": "00000000-0000-4000-8000-000000000001",
  "name": "manual-task",
  "revisionId": "00000000-0000-4000-8000-000000000002",
  "version": 1,
  "active": true
}
```

Invalid YAML, unknown integrations, or rejected agent settings return `422` with field issues. `paseo hub deploy --dry-run` and `paseo hub deploy` call these endpoints for `.paseo/triggers/*.yml`.

## Webhook secrets

`POST /api/v1/triggers/webhook-secret` (`configuration:install`) creates or rotates the Bearer secret for a saved `webhook.received` trigger.

Request body:

```json
{
  "triggerId": "00000000-0000-4000-8000-000000000001"
}
```

On success, Hub returns `200` with `Cache-Control: no-store`:

```json
{
  "path": "/webhooks/wh_0123456789abcdef0123456789abcdef",
  "secret": "whsec_..."
}
```

Each call replaces any previous secret immediately and shows the new secret only once. See [Inbound webhooks](/docs/hub/triggers/webhooks) for sending deliveries to `/webhooks/wh_...`.

## Manual run dispatch

`POST /api/v1/manual-runs` (`runs:dispatch`) starts a configured `manual.run` trigger. `actor` must match that trigger's `filters.from_users` allowlist (or `*` when omitted).

```json
{
  "projectSlug": "default",
  "trigger": "manual-task",
  "actor": "automation",
  "deliveryKey": "manual-task-2026-09-09-001",
  "input": "repo=project investigate the failed sync"
}
```

- `deliveryKey` provides durable deduplication scoped to your organization and project.
- `input` accepts leading `key=value` tokens for declared `inputs` followed by prompt text.

Omit `expectedVersionId` for standalone triggers. Passing the `revisionId` from trigger installation returns HTTP `409` (`configuration_changed`), even when the trigger is unchanged.

For legacy project bundles, `expectedVersionId` is optional. Set it to the active project configuration revision ID to reject dispatch if the configuration changes.

On success, Hub returns `200`:

```json
{
  "deliveryKey": "manual-task-2026-09-09-001",
  "providerEventReceiptId": "00000000-0000-4000-8000-000000000000",
  "triggerRunId": "00000000-0000-4000-8000-000000000000",
  "configuredTriggerName": "manual-task",
  "workflowStatus": "running"
}
```

Example:

```bash
curl --fail-with-body -sS -X POST "$PASEO_HUB_URL/api/v1/manual-runs" \
  -H "Authorization: Bearer $PASEO_HUB_API_KEY" \
  -H "Content-Type: application/json" \
  --data '{
    "projectSlug": "default",
    "trigger": "manual-task",
    "actor": "automation",
    "deliveryKey": "manual-task-2026-09-09-001",
    "input": "investigate the failed sync"
  }'
```

## Daemon enrollment

`POST /api/v1/daemons/enrollment-tokens` (`daemons:enroll`) issues a single-use enrollment token that expires in 10 minutes. No request body is required.

```bash
curl --fail-with-body -sS -X POST \
  "$PASEO_HUB_URL/api/v1/daemons/enrollment-tokens" \
  -H "Authorization: Bearer $PASEO_HUB_API_KEY"
```

Response (`201`):

```json
{
  "token": "short-lived-enrollment-token",
  "expiresAt": "2026-09-09T12:10:00.000Z"
}
```

`paseo hub connect [origin]` calls this endpoint automatically and exchanges the token for the daemon's own long-lived relationship credential. Revoking the API key immediately blocks new API calls and expires any unconsumed enrollment tokens it issued.

## Keys and audit trails

Hub displays an API key secret once at creation time. The dashboard keeps only the key prefix, scopes, creation time, last-used timestamp, and revocation status. Hub records key attribution on trigger installations, webhook rotations, manual dispatches, and daemon enrollment tokens.
