---
title: Hoplite
description: Install and add Hoplite for Paseo.
nav: Hoplite
order: 28
category: Providers
---

# Hoplite

Paseo runs Hoplite's cloud coding agent through the Agent Client Protocol (`hoplite acp`) on your installed `hoplite` CLI.

## Getting started

Add Hoplite from Settings in Paseo before you start an agent.

1. Install the [Hoplite CLI](https://hoplite.sh/docs/cli) on your daemon host.
2. Run `hoplite login` in a terminal.
3. In Paseo, open **Settings → Hosts → your host → Providers**, select **+ Provider**, find **Hoplite**, and select **Add**.

See [Hoplite's ACP guide](https://hoplite.sh/docs/cli/acp) for authentication and project setup. If `hoplite` is outside your daemon PATH, use a [command override](/docs/custom-providers#custom-binary) and keep `acp` in the arguments.

## Projects and the cloud workspace

Hoplite runs the agent in a cloud workspace. Your local files and Paseo's loopback MCP tools are not available there.

Open a repository that is linked to a Hoplite project, or set `agents.providers.hoplite.env.HOPLITE_PROJECT_ID` to use one project everywhere. Without a linked repository or a pinned project, discovery reports `No Hoplite project`.
