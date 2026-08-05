---
title: Hub triggers
description: How Hub matches an inbound event to a trigger: events, filters, and the allowlist that gates every execution.
nav: Triggers
order: 64
category: Hub
---

# Triggers

A trigger says: when this event arrives, from this source, from these people, run this agent with this prompt.

```yaml
triggers:
  - name: mention
    on: github.issue_comment
    environment: dev
    filters:
      repo: acme/api
      contains: "@paseo"
      from_users: [alice]
    agent:
      provider: codex
      mode: full-access
    prompt: ${{ paseo.event.github.comment.body }}
```

Field-by-field detail is in the [`hub.yml` reference](/docs/hub/configuration/hub-yml). This page covers matching.

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

`allow_outputs` gives the agent a single-use `reply` tool for the conversation that triggered it:

```yaml
allow_outputs:
  - type: slack.reply
```

Only `slack.reply` and `discord.reply` exist. GitHub-triggered agents reply with the scoped `GH_TOKEN` they already have, so `gh issue comment` works.
