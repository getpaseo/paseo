---
title: Linear triggers
description: Start reactive, autonomous, or native agent-session Hub workflows from Linear.
nav: Linear
order: 70
category: Hub
---

# Linear triggers

Connect a workspace through [Linear for Hub](/docs/hub/self-hosting/linear-app), then use its
stable Linear IDs to scope each workflow. Display names are not accepted for projects, states,
teams, labels, assignees, or users.

## Choose the event

| `on`                         | Fires when                                                                         |
| ---------------------------- | ---------------------------------------------------------------------------------- |
| `linear.issue_entered_scope` | An issue is created in, or transitions into, the configured project or team scope. |
| `linear.issue_assigned`      | An issue's assignee changes to a user.                                             |
| `linear.comment_created`     | A comment is created on an issue.                                                  |
| `linear.agent_session`       | A native agent session is created or receives another prompt.                      |

`linear.issue_entered_scope` is the intentionally autonomous event. It requires `filters.project`
or `filters.team` and fires only on the edge into the complete configured scope. Editing the title
or description of an issue already in scope does not start another run.

`linear.issue_assigned`, `linear.comment_created`, and `linear.agent_session` are reactive. They
require a non-empty `filters.from_users` list containing the Linear IDs of actors allowed to start
the workflow.

## Filter Linear events

All supplied filters compose with AND.

| Filter           | Meaning                                                                                |
| ---------------- | -------------------------------------------------------------------------------------- |
| `connection`     | Linear connection slug.                                                                |
| `project`        | Linear project ID; either this or `team` is required for `linear.issue_entered_scope`. |
| `team`           | Linear team ID; useful when issues are not assigned to Linear projects.                |
| `states`         | The issue's current workflow-state ID must be in the list.                             |
| `labels`         | The issue must currently have every listed Linear label ID.                            |
| `exclude_labels` | The issue must have none of the listed Linear label IDs.                               |
| `assignees`      | The issue's resulting assignee ID must be in the list.                                 |
| `from_users`     | Actor IDs allowed to assign, comment, or prompt a session.                             |
| `pattern`        | For comments or sessions, text that must start the direct user message.                |
| `contains`       | For comments or sessions, text that must occur in the direct user message.             |
| `replies_only`   | For comments, `true` restricts the trigger to replies.                                 |

`from_users` identifies the person who performed the assignment, wrote the comment, or prompted
the agent session.
`assignees` identifies the issue's resulting assignee. They are different checks.

## Act as a native Linear agent

Enable **Agent session events** when you [create the Linear app](/docs/hub/self-hosting/linear-app).
Mentioning the app or delegating an issue creates a session; another message on that session sends
a `prompted` event and starts another workflow run.

`.paseo/workflows/linear-agent.yml`:

```yaml
name: linear-agent
on: linear.agent_session
max_runtime: 1h
filters:
  connection: acme-linear
  project: 00000000-0000-0000-0000-000000000000
  from_users: [11111111-1111-1111-1111-111111111111]
steps:
  - id: respond
    environment: dev
    max_runtime: 45m
    idle_timeout: 5m
    agent: codex
    prompt:
      - text: |
          Act on this Linear agent-session request. Reply with hub.reply, then call
          hub.finish_execution.

          <current-turn>
          ${{ paseo.prompt }}
          </current-turn>

          <linear-context>
          ${{ paseo.context }}
          </linear-context>
    allow_outputs:
      - { type: linear.reply, max: 1, required: true }
```

For a new session, `${{ paseo.prompt }}` is Linear's canonical `promptContext`, including its
issue, relevant comments, and guidance. For a follow-up it is the new prompt activity's original
body. `${{ paseo.context }}` exposes the session and issue; on follow-ups its chronological thread
contains the issue root and up to 49 activities strictly before the triggering prompt. Optional
history failure does not fail the run.

Hub emits an ephemeral `thought` when it accepts the session. `linear.reply` becomes a native
`response` activity, which completes the session, while a failed workflow emits an `error`
activity. The example marks `linear.reply` as required so a successful run cannot finish without
completing the session.

## Respond to a command comment

Assume `.paseo/hub.yml` defines an environment named `dev` and an agent named `codex`.

`.paseo/workflows/linear-comment.yml`:

```yaml
name: linear-comment
on: linear.comment_created
max_runtime: 1h
filters:
  connection: acme-linear
  project: 00000000-0000-0000-0000-000000000000
  from_users: [11111111-1111-1111-1111-111111111111]
  contains: /paseo
steps:
  - id: answer
    environment: dev
    max_runtime: 30m
    idle_timeout: 5m
    agent: codex
    prompt:
      - text: |
          Answer the Linear request with hub.reply, then call hub.finish_execution.

          <user-prompt>
          ${{ paseo.prompt }}
          </user-prompt>

          <linear-context>
          ${{ paseo.context }}
          </linear-context>
    allow_outputs:
      - { type: linear.reply, max: 1, required: true }
```

For a Linear comment, `${{ paseo.prompt }}` preserves the complete original comment. `pattern` and
`contains` choose where declared leading `key=value` inputs are parsed; they do not rewrite the
prompt. `linear.reply` posts to the triggering issue through the connected Linear application.

Authoring `${{ paseo.context }}` opts the step into Linear context. It includes the organization,
actor, structured issue project and team, triggering comment, and a bounded chronological thread:
the issue title and description followed by up to 49 comments strictly before the trigger. A reply
also exposes its parent as `linear.comment.parent_id`. If optional history cannot be loaded, the
context marks the thread unavailable and still includes the issue root.

Use a second `linear.comment_created` trigger with `replies_only: true` and no text marker when an
allowlisted user should be able to continue by replying without mentioning the app again.

## Start a first-draft PR when an issue enters scope

The project scout below first classifies an issue without Hub-issued GitHub authority. Only an
eligible issue reaches the implementation step, which has explicit repository permissions and one
Linear reply.

`.paseo/hub.yml`:

```yaml
environments:
  project:
    kind: daemon
    daemon: workstation
    cwd: /work/acme/repo
    worktree:
      mode: branch-off
      newBranch: paseo/linear-${{ paseo.execution.id }}
      base: origin/main
agents:
  codex:
    provider: codex
```

`.paseo/workflows/linear-project-scout.yml`:

```yaml
name: linear-project-scout
on: linear.issue_entered_scope
max_runtime: 2h
filters:
  connection: acme-linear
  project: 00000000-0000-0000-0000-000000000000
  states: [22222222-2222-2222-2222-222222222222]
  exclude_labels: [33333333-3333-3333-3333-333333333333]
steps:
  - id: assess
    environment: project
    max_runtime: 20m
    idle_timeout: 5m
    agent: codex
    prompt:
      - text: |
          Assess this Linear issue for a safe, self-contained first-draft PR. Set eligible
          to true only when the change is clear, bounded, testable, and requires no product
          or security decision. Then call hub.finish_execution with an output object containing
          that eligible decision; do not return it only as prose.

          ${{ paseo.context }}
    output:
      schema:
        type: object
        required: [eligible]
        properties:
          eligible: { type: boolean }
        additionalProperties: false

  - id: implement
    if: ${{ steps.assess.outputs.eligible == true }}
    environment: project
    max_runtime: 90m
    idle_timeout: 10m
    agent: codex
    github:
      connection: acme-github
      repositories: [acme/repo]
      permissions:
        contents: write
        pull_requests: write
    prompt:
      - text: |
          Implement the issue, run focused checks, and open a draft pull request. Then call
          hub.reply with the pull-request URL and a short summary, and call
          hub.finish_execution. Do not open a pull request if the issue proves ambiguous.

          ${{ paseo.context }}
    allow_outputs:
      - { type: linear.reply, max: 1, required: true }
```

The project filter is the autonomous trust boundary in this example. Use `team` instead when a
team maps to the repository and issues may have no Linear project. Narrow either route further with
states, labels, excluded labels, and assignees. The trigger grants no repository credential. Only
the `github` block on `implement` authorizes GitHub access, and only that step can emit
`linear.reply`.
