---
title: GitHub access
description: Grant a workflow step a scoped GitHub token and a working git setup, minted per execution and revoked when the step ends.
nav: GitHub access
order: 65
category: Hub
---

# GitHub access

A step gets GitHub authority from a `github` block:

```yaml
steps:
  - id: implement
    environment: development
    max_runtime: 90m
    idle_timeout: 10m
    github:
      connection: example-github
      repositories:
        - example/project
      permissions:
        contents: write
        pull_requests: write
    agent:
      provider: codex
      mode: full-access
    prompt:
      - text: |
          Implement the request, commit, push the branch, and open a
          pull request with `gh pr create`.

          Call hub.finish_execution when the step is complete.
      - text: |
          <user-prompt>
          ${{ paseo.prompt }}
          </user-prompt>
```

The agent can clone, commit, push, and call `gh` in the listed repositories. Nothing is configured on the daemon host.

Nothing else grants GitHub authority. A run triggered from a GitHub event has no token and no git configuration unless its step declares the block.

## The block

| Field          | Notes                                                                                                     |
| -------------- | --------------------------------------------------------------------------------------------------------- |
| `connection`   | The project's GitHub connection slug.                                                                     |
| `repositories` | The repositories the token can reach.                                                                     |
| `permissions`  | GitHub installation-token permission names, such as `contents`, `pull_requests`, `issues`.                |
| `duration`     | How long the token lives. Defaults to `1h`, the GitHub maximum. Shorter revokes early; longer is invalid. |

Permissions cannot exceed what the GitHub App installation was granted. A block asking for `contents: write` on an installation that only has read fails.

Hub mints the token when the step starts and revokes it when the execution ends, whatever the outcome.

## What the agent's environment contains

Hub supplies `GH_TOKEN` and git configuration through environment variables alone:

- Commits author as the App's bot account, with its GitHub noreply email.
- `git@github.com` remote URLs are rewritten to HTTPS, and the credential helper answers with the token.
- Global and system git config are ignored, and nothing prompts a terminal.

The daemon host's own git identity and credentials are never used or changed.

## Only the step that needs it

Authority is per step, so a routed workflow grants it only to the branch that does the work. A Slack-triggered run:

```yaml
environments:
  - name: triage
    kind: daemon
    daemon: my-macbook
    cwd: /Users/you/code/project

  - name: development
    kind: daemon
    daemon: my-macbook
    cwd: /Users/you/code/project
    worktree:
      mode: branch-off
      newBranch: hub/work
      base: origin/main

triggers:
  - name: slack-work
    on: slack.mention
    max_runtime: 3h
    filters:
      workspace: T01234567
      channels: [C01234567]
      from_users: [U01234567]
    steps:
      - id: classify
        environment: triage
        max_runtime: 2m
        idle_timeout: 30s
        agent:
          provider: codex
          options:
            approval_policy: never
            sandbox_mode: read-only
            web_search: disabled
        prompt:
          - text: |
              Decide whether this request needs an answer or a change.

              Call hub.finish_execution with the decision as the structured result.
          - text: |
              <user-prompt>
              ${{ paseo.prompt }}
              </user-prompt>
        output:
          schema:
            type: object
            additionalProperties: false
            required: [kind]
            properties:
              kind:
                enum: [answer, change]

      - id: answer
        if: ${{ steps.classify.outputs.kind == 'answer' }}
        environment: triage
        max_runtime: 10m
        idle_timeout: 2m
        agent:
          provider: codex
          options:
            approval_policy: never
            sandbox_mode: read-only
            web_search: disabled
        prompt:
          - text: |
              Answer the request without changing files.

              Call hub.reply to send your answer to the originating conversation.
              Call hub.finish_execution when the step is complete.
          - text: |
              <user-prompt>
              ${{ paseo.prompt }}
              </user-prompt>
        allow_outputs:
          - type: slack.reply

      - id: change
        if: ${{ steps.classify.outputs.kind == 'change' }}
        environment: development
        max_runtime: 90m
        idle_timeout: 10m
        github:
          connection: example-github
          repositories:
            - example/project
          permissions:
            contents: write
            pull_requests: write
        agent:
          provider: codex
          mode: full-access
        prompt:
          - text: |
              Make the change, verify it, commit, push the branch, and open a
              pull request with `gh pr create`.

              Call hub.reply with a link to the pull request.
              Call hub.finish_execution when the step is complete.
          - text: |
              <user-prompt>
              ${{ paseo.prompt }}
              </user-prompt>
        allow_outputs:
          - type: slack.reply
```

The classifier and the answer step read untrusted text with no GitHub authority. Only the selected worker holds a token, scoped to one repository. [Hub security](/docs/hub/security) covers the rest of the authority model.

## Other integrations

Any connection credential can be supplied explicitly as an environment variable:

```yaml
env:
  SOME_TOKEN: "${{ paseo.connections.some-connection.token }}"
```

The `github` block is the ergonomic form of this for GitHub: it adds the repository and permission restriction and the git setup on top of the raw token.
