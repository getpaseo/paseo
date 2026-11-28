---
title: Hub triggers
description: Connect events, schedules, and webhooks to agents running on your Paseo daemons.
nav: Triggers
order: 64
category: Hub
---

# Triggers

A trigger defines what starts an agent on your daemon, who is allowed to invoke it, which agent runs, and what tools or replies it can use.

You can author triggers in the Hub dashboard under **Triggers** (in Form or YAML view), or store them in `.paseo/triggers/*.yml` and deploy with `paseo hub deploy`.

`.paseo/triggers/github-issue.yml`:

```yaml
name: triage-issue
on:
  github.issue_created:
    connection: acme-github
    filters:
      repo: acme/api
      from_users: [alice]
run:
  target:
    daemon: devbox
    cwd: /workspace/api
  agent:
    provider: codex
    mode: full-access
  max_runtime: 90m
  idle_timeout: 10m
  prompt: |
    Triage this issue, reply with your summary using reply, then call finish_execution.
    ${{ paseo.context }}
```

See the [Trigger YAML reference](/docs/hub/configuration/reference) for every supported field.

## Choose the agent in Hub

When you create or edit a trigger in the Hub dashboard, choose the daemon and enter its working directory first. Hub asks that daemon for its available providers, models, execution modes, and thinking options.

Only daemons granted `hub.execute` appear as targets. Hub supports any provider configured on your Paseo daemon, including Claude Code, Codex, OpenCode, Pi, and custom or plugin providers. Hub automatically preapproves its own MCP tools when the provider supports preapproval.

Changing the daemon or working directory reloads the available choices. If an existing trigger names a model, mode, or thinking option that the daemon no longer reports, Hub marks that value unavailable without overwriting it. You can keep the authored value, pick a current value, or edit the YAML directly.

If the daemon is offline or needs a newer Paseo version, the agent selectors show an error with a retry action while the rest of the trigger remains editable.

## Saving checks the agent against the daemon

During daemon validation, Hub sends the provider, model, mode, thinking option, provider-native `options`, and named `choices` to the target daemon. If a value is unavailable, Hub rejects it and names the field.

```text
run.agent.mode: Mode 'default' is not available for provider 'opencode'
```

If the target and agent settings stay the same, you can save edits through the dashboard while the daemon is offline. For example, you can edit only the prompt, filters, or limits. Creating a trigger or changing its daemon, working directory, or agent settings requires a connected target daemon.

Hub always validates agent settings against a connected target daemon for `paseo hub deploy` and direct API installs (`POST /api/v1/triggers/install`). This applies even if you change only the prompt. When `paseo hub init` validates a trigger, it also requires a connected target daemon.

## Continue the same agent

Triggers default to **Same conversation** (`continuation: { mode: conversation }`). Follow-up messages in the same Slack or Discord thread, events on the same GitHub issue or pull request, and events on the same Linear issue continue the existing agent session instead of starting a new one. Events without a conversation start a new agent.

If the agent is still busy, the new prompt steers its current work. Each arrival keeps its own reply destination, output limits, and completion contract. If the reusable workspace was archived, Hub restores it before delivering the follow-up prompt.

Choose **Custom key** (`{ mode: key, key: "..." }`) to group arrivals by an input expression, or **New agent** (`{ mode: new }`) to start a fresh agent every time.

```yaml
name: support
on:
  slack.mention:
    connection: acme-slack
    filters:
      from_users: [U01234567]
run:
  target:
    daemon: laptop
    cwd: /Users/you/code/support
  agent:
    provider: codex
    mode: full-access
  continuation:
    mode: conversation
  max_runtime: 30m
  idle_timeout: 5m
  prompt: Handle this request, answer with reply, and call finish_execution when complete.
```

Hub includes an `executionId` in each prompt. On a continuing agent, pass that `executionId` when calling `reply` and `finish_execution` so Hub routes the output to the right arrival. See [Agent continuation](/docs/hub/configuration/reference#agent-continuation).

## Events

| `on`                                   | Fires when                                                              |
| -------------------------------------- | ----------------------------------------------------------------------- |
| `github.issue_created`                 | A GitHub issue is opened.                                               |
| `github.pull_request_created`          | A GitHub pull request is opened.                                        |
| `github.pull_request_ready_for_review` | A draft pull request is marked ready for review.                        |
| `github.pull_request_synchronized`     | New commits are pushed to an open pull request.                         |
| `github.issue_comment_created`         | A comment is posted on a GitHub issue.                                  |
| `github.pull_request_comment_created`  | A conversation comment is posted on a pull request.                     |
| `github.issue_label_added`             | A label is added to a GitHub issue.                                     |
| `github.pull_request_label_added`      | A label is added to a pull request.                                     |
| `linear.comment_created`               | A comment is posted on a Linear issue.                                  |
| `linear.issue_assigned`                | A Linear issue is assigned or reassigned.                               |
| `linear.issue_entered_scope`           | A Linear issue is created in scope or transitions into scope.           |
| `slack.mention`                        | The bot is mentioned in a Slack channel or thread.                      |
| `discord.mention`                      | The bot is mentioned in a Discord channel or thread.                    |
| `schedule.tick`                        | A recurring calendar schedule fires in your timezone.                   |
| `webhook.received`                     | An authenticated HTTP `POST` arrives at the trigger's webhook endpoint. |
| `manual.run`                           | A run is dispatched through the Hub API.                                |

Read the guide for each trigger source:

- [GitHub triggers](/docs/hub/triggers/github)
- [Linear triggers](/docs/hub/triggers/linear)
- [Slack triggers](/docs/hub/triggers/slack)
- [Discord triggers](/docs/hub/triggers/discord)
- [Scheduled triggers](/docs/hub/triggers/schedules)
- [Inbound webhooks](/docs/hub/triggers/webhooks)

## Filters

External provider triggers require a non-empty `from_users` allowlist. There are three exceptions:

- `linear.issue_entered_scope` requires `filters.project` and can omit `from_users`.
- `schedule.tick` uses `recurrence` and accepts no `connection` or `filters`.
- `webhook.received` authenticates callers with a Bearer secret and accepts no `connection` or `filters`.

The dashboard defaults **Audience** to **Everyone** and saves `from_users: ["*"]`. GitHub, Slack, and Discord accept this wildcard. To limit who can trigger a run, choose **Specific people** or list the allowed logins or user IDs in `from_users`.

For Linear comments and assignments, **Everyone** matches no users. Choose **Specific people** and enter the allowed Linear user UUIDs in **User IDs**, or list them in `from_users` in YAML.

Allowlists do not sandbox the agent or sanitize untrusted text, so read [Hub security](/docs/hub/security) before granting write access or widening the audience.

| Filter             | Applies to                     | Matches                                                                            |
| ------------------ | ------------------------------ | ---------------------------------------------------------------------------------- |
| `from_users`       | GitHub, Linear, Slack, Discord | GitHub login, or Linear, Slack, and Discord user ID                                |
| `repo`             | GitHub                         | Repository in `owner/name` form                                                    |
| `workspace`        | Slack                          | Workspace team ID (`T01234567`)                                                    |
| `guild`            | Discord                        | Server guild ID (quoted string)                                                    |
| `channels`         | Slack, Discord                 | Channel IDs                                                                        |
| `project`          | Linear                         | Linear project UUID                                                                |
| `states`           | Linear                         | Linear workflow state UUIDs                                                        |
| `assignees`        | Linear                         | Linear assignee user UUIDs                                                         |
| `contains`         | GitHub, Linear, Slack, Discord | Substring on GitHub and Linear comments, or invocation prefix on Slack and Discord |
| `exclude_contains` | GitHub                         | Substring that disqualifies the event                                              |
| `pattern`          | GitHub, Linear, Slack, Discord | Prefix at the start of the text or after the mention                               |
| `label`            | GitHub label-added events      | Exact label added by this event, case-insensitively                                |
| `labels`           | GitHub, Linear                 | Every listed label must be present (names on GitHub, UUIDs on Linear)              |
| `exclude_labels`   | Linear                         | Any listed label UUID disqualifies the issue                                       |

All conditions compose with AND. There is no `any` mode.

## Pinning a connection

Set `connection` on the event object to pin a trigger to one organization integration slug. Without `connection` or a resource filter (`repo`, `workspace`, `guild`), the trigger listens across every integration of that provider in the organization.

```yaml
on:
  github.issue_comment_created:
    connection: acme-github
    filters:
      from_users: [alice]
```

## When two triggers match

Both run. Triggers are independent, unordered, and do not shadow each other.

## Replying and Open in Paseo links

Hub grants the `reply` tool when the event has an issue, pull request, or thread to reply to.

A `github.push` event has no reply destination. If you require `github.reply` for a push, Hub fails the run before it starts the agent.

To cap how many replies an agent can send or require at least one reply before `finish_execution` succeeds, declare `run.outputs`:

```yaml
run:
  outputs:
    slack.reply:
      max: 1
      required: true
```

Use `github.reply`, `linear.reply`, `slack.reply`, or `discord.reply` to match the trigger source. The prompt must tell the agent to call `reply` and `finish_execution` because Hub does not rewrite your prompt to add tool instructions. See [Output capabilities](/docs/hub/configuration/reference#output-capabilities).

When Hub has a configured HTTPS origin and the run has a recorded daemon agent, Hub appends an **Open in Paseo** link to conversation replies so signed-in organization members can open the live session in Paseo or inspect the run in Hub.

To read or post to Slack or Discord channels from any trigger (including schedules, webhooks, GitHub, and Linear), grant [Integration tools](/docs/hub/tools).
