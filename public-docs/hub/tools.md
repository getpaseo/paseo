---
title: Integration tools
description: Grant any Hub trigger scoped Slack and Discord read and post tools through Hub MCP.
nav: Integration tools
order: 71
category: Hub
---

# Integration tools

Any Hub trigger can grant scoped Slack and Discord tools to its agent through the Hub MCP server. A daily schedule can post a CI summary to Slack, a webhook handler can read recent Discord context before posting an update, or a GitHub trigger can notify a Slack channel without installing external CLIs or putting chat tokens on your daemon.

Hub keeps provider tokens on the server and enforces the connection, action, and channel allowlist on every tool call.

## Configure in the dashboard or YAML

In the Hub trigger editor, open **Integration tools**, select a connected Slack or Discord integration, enter the allowed channel IDs, and choose **Read**, **Post**, or both.

In `.paseo/triggers/*.yml`, add `run.tools`:

```yaml
name: nightly-digest
on:
  schedule.tick:
    recurrence:
      start: "2026-09-09T08:00:00"
      rule: "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR"
      timezone: America/New_York
run:
  target:
    daemon: devbox
    cwd: /workspace/project
  agent:
    provider: codex
    mode: full-access
  continuation:
    mode: new
  tools:
    slack:
      connection: engineering-slack
      actions: [post]
      channels: [C012AB3CD]
    discord:
      connection: community-discord
      actions: [read, post]
      channels: ["123456789012345678"]
  prompt: |
    Scan recent Discord messages with discord_latest, summarize open bugs,
    and post the digest to Slack channel C012AB3CD with slack_post.
    Call finish_execution when done.
```

## Grant fields

| Field        | Required | Notes                                                                              |
| ------------ | -------- | ---------------------------------------------------------------------------------- |
| `connection` | yes      | Integration slug from **Integrations**, such as `engineering-slack`.               |
| `actions`    | yes      | Non-empty list containing `read`, `post`, or both.                                 |
| `channels`   | yes      | Explicit allowlist of 1 to 50 channel IDs. Quote Discord snowflake IDs as strings. |

See [Find your Slack IDs](/docs/hub/triggers/slack#find-your-slack-ids) and [Find your Discord IDs](/docs/hub/triggers/discord#find-your-discord-ids) to copy channel IDs.

## Available Hub MCP tools

| Grant        | Tools exposed to the agent                                                                                                                                                                                                                                                   |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Slack read   | `slack_list_channels` lists granted channel IDs. `slack_read` reads channel or thread messages (`limit`, `thread_ts`, `cursor` from `nextCursor`).                                                                                                                           |
| Slack post   | `slack_post` posts to a granted channel or replies to a thread using its starter `thread_ts`.                                                                                                                                                                                |
| Discord read | `discord_list_channels` lists granted channels and forums. `discord_read` reads a channel, forum, thread, or exact message URL (`before` from `nextBefore`). `discord_latest` scans recent messages across granted channels, including active and recently archived threads. |
| Discord post | `discord_post` posts to a granted channel, replies in a thread, or opens a contextual thread on a channel message.                                                                                                                                                           |

## Enforcement and behavior

- Hub checks every tool call against the declared `connection`, `actions`, and `channels`. Discord thread and forum post access is allowed only when the thread's parent channel is in `channels`.
- When Hub has an HTTPS origin and a recorded daemon agent, agents with `post` access receive the run's **Open in Paseo** URL in their request context so digests and reports can link directly to the session.
- Because tool contracts belong to the active session, changing `run.tools` on a continuing trigger requires **New agent** (`continuation: { mode: new }`) or a new continuation key on the next run.
- If your `run.tools` block uses YAML anchors or aliases, edit the trigger in YAML view so Hub preserves those references.
