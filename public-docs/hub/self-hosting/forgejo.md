---
title: Forgejo for Hub
description: Approve a Forgejo instance, connect repository-limited accounts, and receive signed events.
nav: Forgejo
order: 75.5
category: Hub
---

# Forgejo for Hub

Forgejo is not a GitHub App integration. An instance operator approves the Forgejo origin first,
then organization owners connect accounts to that approved instance. This keeps origin approval
separate from each organization's repository and PAT choices.

## Approve an instance

In Hub's Forgejo settings, an instance operator enters the canonical HTTPS origin and chooses
whether Hub may reach a private-network address. Hub checks the Forgejo identity and requires
Forgejo `16.0.3` or later before the instance becomes active.

Approve a private-network origin only when the Hub deployment is intentionally allowed to reach
it. Organization owners cannot enter a URL during connection setup; they choose an approved
`instanceId`. The public resource for an approved connection contains only `slug`, `instanceId`,
`accountLogin`, and enrolled `repositories`, never the origin or a credential.

Run the instance health check after a Forgejo upgrade, certificate change, DNS change, or other
identity change. An incompatible, unreachable, or identity-drifted instance needs operator review
before it can be used safely. Scheduled recovery continues in the background while Hub is running.

## Connect an organization

An organization owner creates a connection from an approved instance, a connection slug, a
claimed Forgejo username, and a repository-limited personal access token. The token must include
one issue capability (`read:issue` or `write:issue`) and one repository capability
(`read:repository` or `write:repository`). Hub rejects OAuth2 credentials, passwords, unscoped
tokens, and unrelated scopes.

Enroll only the repositories the connection needs. The connection PAT supports event intake,
repository health, and reactions. Configure a separate repository-limited execution PAT when a
workflow needs a `forgejo` step-authority block. Hub checks the execution PAT's repositories and
capabilities at step launch; it never widens either boundary. Forgejo cannot mint a narrower token
for a step that requested a subset of that PAT; the injected `FORGEJO_TOKEN` is the stored
execution PAT after subset validation. Store a narrower execution PAT when a step must not inherit
the broader credential.

Hub also runs bounded scheduled recovery on the frozen health interval without an operator
request. On-demand instance health checks still use the same coordinator. Automatic retry never
claims `REMOTE_CLEANUP_PENDING` work.

Rotate or revoke the connection and execution PATs in the Forgejo connection lifecycle controls.
Use rotation when an upstream token's identity, scope, or repository list changes. Do not put a PAT
in `.paseo` configuration files.

## Webhook delivery

Forgejo event triggers need a public HTTPS Hub URL that Forgejo can reach. Set the stable public
Hub URL before configuring webhooks:

```dotenv
PASEO_HUB_APP_URL=https://hub.example.com
```

A Hub instance can connect to Forgejo and read repository-backed configuration without an inbound
webhook. Event triggers and automatic configuration synchronization need the callback to be
reachable.

After repositories are enrolled, choose one webhook mode:

- **Automatic:** provide a one-time webhook-admin PAT. Hub creates or reconciles managed hooks,
  verifies them, then discards that PAT.
- **Manual:** Hub gives you a callback URL and webhook secret. Add those values to every enrolled
  Forgejo repository yourself.

Both modes use `push`, `issues`, `issue_comment`, `pull_request`, `pull_request_review`, and
`pull_request_review_comment`. Hub verifies each Forgejo HMAC signature before accepting a
delivery. Keep the webhook secret in Forgejo's webhook configuration, never in the repository.

## Configuration source and triggers

Select **Forgejo** as a project's configuration source, then choose one enrolled repository. Hub
records the source kind as `forgejo`, reads the `.paseo` bundle from that repository's default
branch, and records the exact commit used for each synchronization. A default-branch push can
synchronize the source; the project also provides an explicit sync action.

Author semantic `forgejo.*` triggers in `.paseo/workflows/` and grant repository authority only
through a step-level `forgejo` block. See [Forgejo triggers](/docs/hub/triggers/forgejo) and
[Forgejo access](/docs/hub/forgejo) for complete workflow examples.

## Cleanup and troubleshooting

Before disconnecting, inspect the impact preview. Hub blocks future Forgejo execution and removes
managed hooks where it can; manual hooks remain yours to remove. When a managed hook cannot be
removed, the disconnect reports `REMOTE_CLEANUP_PENDING`. Use **Resume remote cleanup** with a
one-time webhook-admin PAT to finish the remote deletion. Hub uses that PAT for recovery only; it
does not become a connection credential.

| Symptom                           | Check and remediation                                                                                                                                   |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No approved instance is available | Ask an instance operator to approve the canonical HTTPS origin and verify Forgejo `16.0.3` or later.                                                    |
| A PAT is rejected                 | Restrict it to repositories and include one issue and one repository capability. Do not use OAuth2, a password, an unscoped token, or unrelated scopes. |
| A repository is absent            | Confirm that the connection PAT can see it, then enroll it before selecting it for hooks or configuration.                                              |
| Events are missing                | Confirm Hub's public HTTPS URL, callback URL, webhook secret, selected repositories, and required event families.                                       |
| Reactions are missing             | Confirm that the event has a reaction target and the connection PAT has `write:issue` for that enrolled repository.                                     |
| Health is degraded                | Rotate or replace a changed connection PAT, then recheck the instance, repository, and hook health.                                                     |
| `REMOTE_CLEANUP_PENDING` remains  | Resume remote cleanup with a one-time webhook-admin PAT; do not create a broader permanent connection for cleanup.                                      |
