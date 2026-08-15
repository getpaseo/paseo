---
title: Hub FAQ
description: Common questions about projects, connections, configuration, and daemons in Paseo Hub.
nav: FAQ
order: 78
category: Hub
---

# Hub FAQ

## Do I need Hub to use Paseo?

No. Paseo runs agents on your machines without it. Hub adds what a single daemon cannot do on its own: starting agents from external activity, versioned configuration, a shared record of what ran, and team access.

## Can one organization connect several GitHub organizations?

Yes. Connections belong to the organization and there is no limit on how many you add. Each gets its own slug.

## How should I split my work into projects?

The way you already split it: one per product, one per team, or one per repository. A project owns one set of environments and triggers, so anything that should be configured and deployed together belongs in the same project.

Projects share the organization's connections and daemons, so a new project does not mean connecting GitHub or registering a daemon again.

## Can two projects watch the same repository?

Yes. Both run. Repositories are not owned by a project.

## Can the configuration live somewhere other than the repository being watched?

Yes. `filters.repo` can name any repository the organization can reach, so a private repository can hold the `.paseo` bundle for workflows that watch public repositories. Protect push access because the bundle selects the organization's connections, daemons, agents, and outputs.

## Where do triggers go now?

Each trigger and its ordered steps live in one direct `.paseo/workflows/*.yml` file. `hub.yml` contains only named environments and agents. Hub rejects monolithic `triggers` configuration instead of translating it.

## Can I edit configuration in the dashboard?

Yes, with a manual source. A project using a GitHub source is read-only in the dashboard, since the repository is the source of truth. Switching to manual copies the active revision into the editor and stops syncing.

## Who can trigger an agent?

Only identities in a trigger's allowlist. `from_users` works for every provider. GitHub triggers can instead use `from_teams` with `organization/team-slug`; only active team members match. If Hub cannot check that membership, it does not start a run.

## What happens if the daemon is offline?

Dispatch fails and the event is recorded as failed. Nothing is queued, so trigger it again once the daemon is back.

## Does logging out disconnect my daemon?

No. The stored CLI login is a human organization credential; the enrolled daemon has its own relationship credential. Interactive `paseo hub logout` offers to disconnect a daemon related to the same Hub. Declining is normal, and JSON or noninteractive logout never disconnects unless you pass `--disconnect-daemon`.

## Can an agent reply back to Slack or Discord?

Yes. Put `allow_outputs` on the step and tell the agent to call `hub.reply` in the prompt. [Tell the agent which tool to call](/docs/hub/workflows#tell-the-agent-which-tool-to-call) shows the prompting; reply limits and `required` are in the [output capability reference](/docs/hub/configuration/hub-yml#output-capabilities).

GitHub has no reply capability; give the step a [`github` block](/docs/hub/github) and the agent acts through the `gh` CLI.

## Can I use it without GitHub?

Yes. A project with a manual configuration and a Discord or Slack connection works fine. GitHub is only needed if you want configuration synced from a repository.
