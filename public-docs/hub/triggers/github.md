---
title: GitHub triggers
description: Configure GitHub events as Hub triggers and route them into durable workflows.
nav: GitHub
order: 65
category: Hub
---

# GitHub triggers

## Events

| `on`                                 | Fires when                                        |
| ------------------------------------ | ------------------------------------------------- |
| `github.issue_comment`               | A comment on an issue or pull request is created. |
| `github.issues`                      | An issue is opened or edited.                     |
| `github.pull_request_review`         | A review is submitted.                            |
| `github.pull_request_review_comment` | A comment is added to a diff.                     |

Which repositories produce events is set on the GitHub App installation. `filters.repo` narrows a trigger to one `owner/name` repository.

## Filters

```yaml
filters:
  repo: example/project
  contains: "@paseo"
  from_users: [maintainer]
```

`from_users` matches the sender's GitHub login. `contains` checks the event text; `pattern` checks its start. The text is the comment body for comments and reviews, and the issue title plus body for issues. All filters must pass.

## Invocation

Put the configured marker in the message, then put leading inputs in the text parsed after that marker:

```text
@paseo repo=project agent=claude investigate the failed sync
```

Hub consumes only declared consecutive headers and passes `investigate the failed sync` as `${{ paseo.prompt }}`. See [Hub workflows](/docs/hub/workflows) for input types, defaults, choices, and rejected Activity records.

## Credentials and replies

Hub mints a GitHub token for each execution, scoped to the installation and the triggering repository, and puts it in the agent's environment as `GH_TOKEN`. That authenticates the `gh` CLI. Say what to do with it in the prompt, and name the Hub tool that completes the step:

```text
Post the answer as an issue comment with `gh`.
Call hub.finish_execution when the step is complete.
```

The token authenticates API calls. It does not configure git, and Paseo does not set a commit identity or a credential helper, so configure those on the daemon host before a step commits or pushes.

Hub's `hub.reply` tool covers Slack and Discord, not GitHub. See [Tell the agent which tool to call](/docs/hub/workflows#tell-the-agent-which-tool-to-call) and the [workflow scenarios](/docs/hub/workflows#scenarios) for review and PR workflows.
