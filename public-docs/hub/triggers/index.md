---
title: Hub triggers
description: How Hub matches an inbound event to a trigger: events, filters, and the allowlist that gates every execution.
nav: Triggers
order: 66
category: Hub
---

# Triggers

A trigger says which provider event can start a workflow. The [Hub workflows](/docs/hub/workflows) page covers the steps, inputs, routing, prompts, and deadlines that run after a match.

`.paseo/workflows/github-issue.yml`:

```yaml
name: triage-issue
on: github.issue_created
filters:
  repo: acme/api
  from_users: [alice]
max_runtime: 2h
steps:
  - id: work
    environment: dev
    max_runtime: 90m
    idle_timeout: 10m
    agent: codex
    prompt:
      - text: Call hub.finish_execution when the step is complete.
      - text: ${{ paseo.prompt }}
```

Field-by-field detail is in the [configuration reference](/docs/hub/configuration/hub-yml).

## Events

| `on`                                  | Fires when                                           |
| ------------------------------------- | ---------------------------------------------------- |
| `github.issue_created`                | An issue is opened.                                  |
| `github.pull_request_created`         | A pull request is opened.                            |
| `github.issue_comment_created`        | A comment is created on an issue.                    |
| `github.pull_request_comment_created` | A conversation comment is created on a pull request. |
| `github.issue_label_added`            | A label is added to an issue.                        |
| `github.pull_request_label_added`     | A label is added to a pull request.                  |
| `linear.issue_entered_scope`          | An issue is created in, or enters, a project scope.  |
| `linear.issue_assigned`               | An issue is assigned to a user.                      |
| `linear.comment_created`              | A comment is created on an issue.                    |
| `linear.agent_session`                | A native agent session starts or is prompted.        |
| `slack.mention`                       | The bot is mentioned in a channel.                   |
| `discord.mention`                     | The bot is mentioned in a guild.                     |
| `manual.run`                          | A run started from the API.                          |

New GitHub workflows should use a semantic event. The five legacy events remain compatible: `github.issues`, `github.issue_comment`, `github.pull_request_review`, `github.pull_request_review_comment`, and `github.push`. See [GitHub triggers](/docs/hub/triggers/github) for complete workflows and when to use each event.

Each provider page documents its events and the data they expose:

- [GitHub triggers](/docs/hub/triggers/github)
- [Linear triggers](/docs/hub/triggers/linear)
- [Slack triggers](/docs/hub/triggers/slack)
- [Discord triggers](/docs/hub/triggers/discord)

## Filters

`filters` is required. `manual.run` and reactive external triggers require a non-empty `from_users`
allowlist. For `manual.run`, it matches the `actor` supplied by the dispatch request.
`linear.issue_entered_scope` is the deliberate exception: it is an autonomous policy, requires a
Linear project, and fires only when an issue enters the complete configured scope.

The allowlist is what keeps a stranger's comment on a public issue from starting an agent on your machine. There is no default, because a safe default differs per repository.

An allowlist is one layer of defense. It does not make a permitted account trustworthy after compromise or make prompt injection harmless. See [Hub security](/docs/hub/security) before choosing the daemon, working directory, provider policy, and outputs for an external trigger.

| Filter           | Applies to                     | Matches                                                                         |
| ---------------- | ------------------------------ | ------------------------------------------------------------------------------- |
| `from_users`     | manual and reactive events     | Manual actor; GitHub login; Linear, Slack, and Discord **user id**              |
| `repo`           | GitHub                         | `owner/name`                                                                    |
| `project`        | Linear                         | Project id                                                                      |
| `states`         | Linear                         | Current workflow-state ids                                                      |
| `assignees`      | Linear                         | Current assignee ids                                                            |
| `exclude_labels` | Linear                         | Any listed label id makes the issue ineligible                                  |
| `workspace`      | Slack                          | Team id, `T01234567`                                                            |
| `guild`          | Discord                        | Guild id                                                                        |
| `channels`       | Slack, Discord                 | Channel ids                                                                     |
| `contains`       | GitHub, Linear, Slack, Discord | GitHub and Linear substring; Slack and Discord invocation prefix                |
| `pattern`        | GitHub, Linear, Slack, Discord | Start of the provider's invocation text                                         |
| `connection`     | all                            | A connection slug, when the organization has several                            |
| `label`          | GitHub label-added events      | The label added by this delivery, case-insensitively                            |
| `labels`         | GitHub, Linear                 | Every listed current label; GitHub names case-insensitively, Linear ids exactly |

All conditions must pass. There is no `any` mode.

## Which connection an event comes from

`repo`, `project`, `workspace`, and `guild` are resolved to immutable ids when the configuration activates, along with the connection that owns them. Naming a resource the organization has no connection for fails activation, so you find out on push rather than when someone comments.

Omit the resource filter and the trigger listens to every connection of that provider in the organization. To pin it to one:

```yaml
filters:
  connection: acme-github
  from_users: [alice]
```

See [How Hub works](/docs/hub/concepts) for what activation compiles.

## When two triggers match

Both run. Triggers are not ordered and do not shadow each other, in one configuration or across projects.

## Replying

Put `allow_outputs` on the step that should reply. The reply capabilities are `linear.reply`, `slack.reply`, and `discord.reply`.

- Set `max` when a step needs more than one update.
- Set `required: true` when the step must emit at least one reply before it can finish. A required type must be registered and available for the execution context.

`linear.reply` posts to the triggering issue for issue/comment events and emits a native response
activity for an agent-session event. GitHub has no reply capability; a step with a
[`github` block](/docs/hub/github) comments through `gh` instead. The
[output capability reference](/docs/hub/configuration/hub-yml#output-capabilities) has the
contract.

The declaration grants the `hub.reply` tool; the prompt has to tell the agent to call it. See [Tell the agent which tool to call](/docs/hub/workflows#tell-the-agent-which-tool-to-call).
