---
title: Inbound webhooks
description: Start Hub agents from any external service, alert tool, or script with an authenticated HTTP POST.
nav: Webhooks
order: 70
category: Hub
---

# Inbound webhooks

Inbound webhooks let any external service, CI job, monitoring alert, or script start an agent on your daemon by sending an authenticated HTTP `POST` request to Hub.

On a self-hosted Hub, configure a [public HTTPS address](/docs/hub/self-hosting#public-addresses) so external services can reach the webhook endpoint.

## Create a webhook trigger

Choose **Webhook received** in the Hub dashboard trigger editor, or save `.paseo/triggers/alert-handler.yml` and run `paseo hub deploy`:

```yaml
name: alert-handler
enabled: true
on:
  webhook.received: {}
run:
  target:
    daemon: devbox
    cwd: /workspace/project
  agent:
    provider: codex
    mode: full-access
  continuation:
    mode: new
  max_runtime: 1h
  idle_timeout: 10m
  output:
    schema:
      type: object
      required: [summary]
      properties:
        summary:
          type: string
      additionalProperties: false
  prompt: |
    Investigate the alert and identify its root cause.
    Call finish_execution with a short summary in output.summary.
```

`webhook.received` accepts no `connection` or `filters`. A webhook trigger cannot declare `required: true` inputs.

## Create or rotate the webhook secret

When you save a webhook trigger, Hub assigns a random endpoint path of the form `/webhooks/wh_<32-char-id>`.

Create its Bearer secret in one of two ways:

1. In the Hub dashboard, open the saved trigger and choose **Create secret** (or **Rotate secret** later). Copy the secret immediately because Hub displays it only once.
2. Through the public API, send `POST /api/v1/triggers/webhook-secret` with `{"triggerId":"<trigger-id>"}` using an organization credential that holds `configuration:install`. Hub returns `{ "path": "/webhooks/wh_...", "secret": "whsec_..." }`.

Rotating a secret invalidates the previous secret immediately. Redeploying the same trigger `name` with `webhook.received` via `paseo hub deploy` keeps both the endpoint path and its active secret intact.

## Send a webhook request

Send an HTTP `POST` request with the secret in the `Authorization: Bearer` header:

```sh
curl -X POST "$WEBHOOK_URL" \
  -H "Authorization: Bearer $WEBHOOK_SECRET" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: alert-123" \
  -d '{"alert":"Disk usage over 95%","host":"prod-01"}'
```

On success, Hub saves the receipt, queues the run, and returns HTTP `202`:

```json
{
  "status": "accepted",
  "runId": "00000000-0000-4000-8000-000000000000"
}
```

Runs appear in [Activity](/docs/hub/activity) under the source `webhook.received`.

## Request limits and responses

- Hub accepts UTF-8 text bodies up to 32 KiB and rejects requests containing a literal NUL character.
- When `Content-Type` is `application/json` or ends in `+json`, Hub validates that the body parses as JSON. Omitting `Content-Type` defaults to `text/plain`.
- Pass an optional `Idempotency-Key` header (up to 200 printable ASCII characters with no spaces) so retries return the original `runId` instead of starting duplicate runs. Keys are scoped per endpoint.
- Each endpoint accepts up to 60 new deliveries per minute.

| Status | Meaning                                                                 |
| ------ | ----------------------------------------------------------------------- |
| `202`  | Delivery accepted and run queued (`{ "status": "accepted", "runId" }`). |
| `400`  | Invalid body, invalid `Content-Type`, NUL character, or bad key.        |
| `401`  | Unknown endpoint or missing or invalid Bearer secret.                   |
| `403`  | Organization reached its monthly execution allowance.                   |
| `409`  | The trigger is disabled.                                                |
| `413`  | Request body exceeds 32 KiB.                                            |
| `429`  | Endpoint exceeded 60 new deliveries in the current minute window.       |

## How the payload reaches the agent

Hub frames the webhook body and delivery metadata (`contentType` and `receivedAt`) as untrusted external data.

If your `run.prompt` omits `${{ paseo.prompt }}`, Hub appends the framed webhook payload to the end of your instructions automatically. To control where the payload appears inside your prompt, insert `${{ paseo.prompt }}` where you want it placed.

Include `${{ paseo.context }}` if you also want the structured `webhook` metadata object (`contentType` and `receivedAt`). To post findings to Slack or Discord from a webhook run, add [Integration tools](/docs/hub/tools).
