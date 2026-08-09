---
title: How Hub works
description: How a provider event reaches a workflow and a Paseo daemon.
nav: How it works
order: 62
category: Hub
---

# How Hub works

Hub connects the places where requests arrive to the machines where your agents run.

```text
GitHub / Slack / Discord / manual request
                    ↓
                  Hub
        matches a project trigger
                    ↓
                workflow
          runs ordered agent steps
                    ↓
             Paseo daemon
             starts the agent
```

## The pieces

- A **connection** lets Hub receive events from GitHub, Slack, or Discord.
- A **daemon** is a registered machine running the Paseo daemon.
- A **project** groups one configuration with the connections and daemons it uses.
- An **environment** names where a workflow step runs: a daemon, its working directory, and an optional worktree.
- A **trigger** says which provider event can start a workflow and which events are allowed through.
- A **workflow** is the ordered set of steps that runs after a trigger matches.
- A **step** starts one agent execution, with its own prompt, agent selection, credentials, reply capabilities, and limits.

The configuration lives in `.paseo/hub.yml` when the project uses a GitHub source. A project has one active configuration revision at a time.

## From event to agent

1. A provider sends an event to Hub. GitHub and Slack use webhooks; Discord uses its gateway connection; manual runs use the Hub API.
2. Hub verifies the provider event and identifies its project resource, such as a repository, workspace, or guild.
3. Hub evaluates triggers and their filters, including the required `from_users` allowlist.
4. A matching trigger creates a workflow run from the active configuration revision.
5. The workflow evaluates its next step. A false `if` condition skips that step; a true condition starts it on the configured daemon.
6. The daemon starts the agent and Hub records its replies, structured output, status, and completion.
7. The next step sees the completed step's output. When no steps remain, the workflow run is complete.

Complete configurations are in [Workflows](/docs/hub/workflows).

## Activation

When Hub syncs `.paseo/hub.yml`, it validates the configuration and resolves its references:

- `filters.repo`, `filters.workspace`, and `filters.guild` must name resources available through the organization's connections.
- `environment.daemon` must match a registered daemon's friendly slug.
- Step ids, expressions, input filters, output schemas, and durations must be valid.

If activation fails, Hub keeps the previous active revision. The Configuration tab shows the failed sync and its validation error; Activity continues to reflect the last active revision.

## Security boundaries

Triggers require a non-empty `from_users` allowlist for externally sourced events. Protect the configuration repository because anyone who can change the active configuration can choose which connections, daemons, and agent capabilities a project uses.

These controls do not sandbox the agent or make input safe. See [Hub security](/docs/hub/security) for the host boundary, provider-native policy, and defense-in-depth guidance.

GitHub credentials are never implied by the trigger. A step holds GitHub authority only when it declares a [`github` block](/docs/hub/github), whatever started the run.
