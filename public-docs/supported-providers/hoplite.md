---
title: Hoplite
description: Install and configure Hoplite for Paseo.
nav: Hoplite
order: 28
category: Providers
---

# Hoplite

Run Hoplite's cloud coding agent in Paseo through the Hoplite CLI on your daemon host.

## Getting started

1. Install the [Hoplite CLI](https://hoplite.sh/docs/cli) on your daemon host.
2. Run `hoplite login`.
3. In Paseo, open **Settings → Hosts → your host → Providers**, select **+ Provider**, find **Hoplite**, and choose **Add**.

Paseo launches `hoplite acp`. See [Hoplite's ACP guide](https://hoplite.sh/docs/cli/acp) for authentication and project setup.

If `hoplite` is outside your daemon's PATH, use a [command override](/docs/custom-providers) and keep `acp` in the arguments.

## Projects and the cloud workspace

Hoplite runs the agent in a cloud workspace. Your local files and Paseo's loopback MCP tools are not available in that cloud workspace.

Open a repository that is linked to a Hoplite project, or set `agents.providers.hoplite.env.HOPLITE_PROJECT_ID` to use one project everywhere. Without a linked repository or a pinned project, discovery reports `No Hoplite project`.
