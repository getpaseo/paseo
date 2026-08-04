---
title: How Hub works
description: The Hub object model, how an inbound event reaches a project, and what happens when a configuration is activated.
nav: How it works
order: 62
category: Hub
---

# How Hub works

## The object model

```text
organization
├── members
├── connections    GitHub installations, Slack workspaces, Discord guilds
├── daemons        registered machines that run agents
└── projects
    └── configuration
        ├── environments
        └── triggers
```

**Connections belong to the organization.** One organization can hold several GitHub installations, several Slack workspaces, and several Discord guilds at the same time. Your personal GitHub account and two company organizations can sit side by side.

**Every connection gets a slug**, generated from the account it points at: `getpaseo-github`, `boudra-github`, `acme-slack`. Slugs are unique inside the organization, and configuration uses them to name a specific connection.

**Daemons belong to the organization too.** Register a machine once and any project can use it.

**A project is one set of environments and triggers.** Projects are how you separate work that should stay separate: one product, one team, one repository. They share the organization's connections and daemons, so separating costs you nothing.

**A project has one active configuration.** You edit it in the dashboard or sync it from a repository, and it applies as a whole.

**Nothing is attached to a project in the dashboard.** No screen assigns a repository or a channel. The project's configuration decides what it listens to, through trigger filters.

## Routing

```text
event arrives
  → the connection verifies it (signature, or an authenticated gateway)
  → the event carries a resource id (repository, workspace, guild)
  → Hub finds compiled routes referencing that resource
  → the trigger's filters run
  → the trigger's environment executes
```

Routes are compiled when a configuration is activated, not evaluated per event. A repository is not owned by one project, so if two projects both name it, both run.

## Activation

Activating a configuration resolves what you wrote into stable identities:

| You write                    | Hub resolves it to                      |
| ---------------------------- | --------------------------------------- |
| `filters.repo: owner/repo`   | a GitHub repository id and a connection |
| `filters.workspace: T0123…`  | a Slack workspace and a connection      |
| `filters.guild: 9876…`       | a Discord guild and a connection        |
| `environment.daemon: my-box` | a registered daemon id                  |

If any of those cannot be resolved through a connection in the organization, activation fails and the previous revision stays active. You find out when you push, rather than when someone comments on an issue.

A trigger with no resource filter routes to every connection of that provider in the organization. Add `filters.connection: <slug>` to narrow it to one.

## Executions

A matched trigger produces an execution. Hub sends the create request to the daemon, then owns that agent's lifecycle: reconnect recovery, output observation, and completion.

- `timeout` is absolute and defaults to `1h`.
- `idle_timeout` starts only when the daemon reports the agent idle, resets on the next idle report, and clears when the agent reports running. It defaults to `5m`.
- Every dispatched agent gets a per-execution MCP server with `finish_execution`. Completion is authoritative when the agent calls it.
- `allow_outputs` adds a single-use `reply` tool for Slack and Discord executions.

If Hub loses the create response, or the daemon reconnects, Hub resends the same create intent with the same execution id. The daemon returns the existing agent instead of running the prompt twice.

## Trust boundary

A project's configuration can reference any connection in its organization. Anyone who can push to the configuration repository controls that project's access to those connections, so protect that branch the way you protect a release branch.

Triggers require a `from_users` allowlist for the same reason. Without one, any stranger commenting on a public issue could start an agent on your machine.
