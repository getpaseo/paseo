---
title: Hub triggers
description: How Hub matches an inbound event to a trigger: events, filters, and the allowlist that gates every execution.
nav: Triggers
order: 66
category: Hub
---

# Triggers

A trigger says which provider event can start a workflow. The [Hub workflows](/docs/hub/workflows) page covers the steps, inputs, routing, prompts, and deadlines that run after a match.

```yaml
triggers:
  - name: mention
    on: github.issue_comment
    filters:
      repo: acme/api
      contains: "@paseo"
      from_users: [alice]
    max_runtime: 2h
    steps:
      - id: work
        environment: dev
        max_runtime: 90m
        idle_timeout: 10m
        agent: { provider: codex, mode: full-access }
        prompt:
          - text: Call hub.finish_execution when the step is complete.
          - text: |
              <user-prompt>
              ${{ paseo.prompt }}
              </user-prompt>
```

Field-by-field detail is in the [`hub.yml` reference](/docs/hub/configuration/hub-yml).

## Events

| `on`                                 | Fires when                            |
| ------------------------------------ | ------------------------------------- |
| `github.issue_comment`               | A comment on an issue or pull request |
| `github.issues`                      | An issue is opened or edited          |
| `github.pull_request_review`         | A review is submitted                 |
| `github.pull_request_review_comment` | A comment on a diff                   |
| `slack.mention`                      | The bot is mentioned in a channel     |
| `discord.mention`                    | The bot is mentioned in a guild       |
| `manual.run`                         | A run started from the API            |

Each provider page documents its events and the data they expose:

- [GitHub triggers](/docs/hub/triggers/github)
- [Slack triggers](/docs/hub/triggers/slack)
- [Discord triggers](/docs/hub/triggers/discord)

## Filters

`filters` is required, and `from_users` must be present and non-empty. A trigger without it is rejected at validation.

The allowlist is what keeps a stranger's comment on a public issue from starting an agent on your machine. There is no default, because a safe default differs per repository.

An allowlist is one layer of defense. It does not make a permitted account trustworthy after compromise or make prompt injection harmless. See [Hub security](/docs/hub/security) before choosing the daemon, working directory, provider policy, and outputs for an external trigger.

| Filter       | Applies to     | Matches                                                         |
| ------------ | -------------- | --------------------------------------------------------------- |
| `from_users` | all            | GitHub: login. Slack and Discord: **user id**, not display name |
| `repo`       | GitHub         | `owner/name`                                                    |
| `workspace`  | Slack          | Team id, `T01234567`                                            |
| `guild`      | Discord        | Guild id                                                        |
| `channels`   | Slack, Discord | Channel ids                                                     |
| `contains`   | all            | Substring of the message text                                   |
| `pattern`    | all            | Prefix of the message text                                      |
| `connection` | all            | A connection slug, when the organization has several            |

All conditions must pass. There is no `any` mode.

## Which connection an event comes from

`repo`, `workspace`, and `guild` are resolved to immutable ids when the configuration activates, along with the connection that owns them. Naming a resource the organization has no connection for fails activation, so you find out on push rather than when someone comments.

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

Put `allow_outputs` on the step that should reply. The Hub provider reply capabilities are `slack.reply` and `discord.reply`; set `max` when a step needs more than one update, or `required: true` when it must emit at least one reply before it can finish. A required type must be registered and available for the execution context. GitHub-triggered agents receive a scoped GitHub credential for `gh` and can comment through that credential instead of a Hub output tool. See the [`hub.yml` output capability reference](/docs/hub/configuration/hub-yml#output-capabilities) for the contract.

The declaration grants the `hub.reply` tool; the prompt has to tell the agent to call it. See [Tell the agent which tool to call](/docs/hub/workflows#tell-the-agent-which-tool-to-call).
