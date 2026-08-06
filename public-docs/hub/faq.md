---
title: Hub FAQ
description: Common questions about projects, connections, configuration, and daemons in Paseo Hub.
nav: FAQ
order: 77
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

Yes. `filters.repo` can name any repository the organization can reach, so a private repository can hold `.paseo/hub.yml` for triggers that watch public ones. Push access to that repository grants access to the organization's connections, which is a good reason to keep it private and protected.

## Can I edit configuration in the dashboard?

Yes, with a manual source. A project using a GitHub source is read-only in the dashboard, since the repository is the source of truth. Switching to manual copies the active revision into the editor and stops syncing.

## Who can trigger an agent?

Only the users listed in a trigger's `from_users`. It is required and cannot be empty.

## What happens if the daemon is offline?

Dispatch fails and the event is recorded as failed. Nothing is queued, so trigger it again once the daemon is back.

## Can an agent reply back to Slack or Discord?

Yes, with `allow_outputs`. See the [`hub.yml` output capability reference](/docs/hub/configuration/hub-yml#output-capabilities) for reply limits and required outputs. On GitHub, agents reply through the scoped `GH_TOKEN` they already have, so `gh issue comment` works.

## Can I use it without GitHub?

Yes. A project with a manual configuration and a Discord or Slack connection works fine. GitHub is only needed if you want configuration synced from a repository.
