---
title: Browser automation
description: Give agents a real browser inside Paseo to open pages, click, type, and verify their work.
nav: Overview
order: 35
category: Browser
---

# Browser automation

Agents in Paseo can drive real browser tabs — the same tabs you see in the Paseo desktop app. An agent can open your dev server, read the page, click through a flow, fill a form, and take a screenshot, all without leaving your machine.

This closes the loop on frontend work: instead of telling you "the change should work," an agent opens the page and checks.

Typical uses:

- **Verify its own changes.** After editing a component, the agent opens the dev server, snapshots the page, and confirms the new text or layout is actually there.
- **Reproduce and diagnose bugs.** Click the exact sequence from a bug report, then read the console and network logs.
- **Exercise full flows.** Forms, multi-step wizards, hover menus, drag and drop, file uploads.
- **Work in logged-in sessions.** Tabs keep their session state. Log in once yourself, and the agent can work behind the login.

Because you share the browser with the agent, you can watch it work — and step in at any point.

## Enabling

Browser tools are off by default. Turn them on per host:

- **In the app:** open your host's settings and enable **Browser tools**.
- **In `config.json`** (`~/.paseo/config.json`):

```json
{
  "daemon": {
    "browserTools": {
      "enabled": true
    }
  }
}
```

The tools are part of the [Paseo MCP toolset](/docs/mcp), so **Inject Paseo tools** (`daemon.mcp.injectIntoAgents`) must also be on for agents to receive them. Existing agents may need a reload to pick up new tools.

> Browser tools let agents access and control Paseo browser tabs, including logged-in browser state. Only enable this for agents you trust.

## Desktop only, for now

Browser tabs are hosted by the Paseo desktop app. The daemon itself doesn't run a browser — it routes tool calls to a connected desktop app, and returns an error when none is connected. The wire contract is host-neutral, so other hosts can carry the same tools later.

## How an agent sees a page

The primary tool is `browser_snapshot`, which returns the page as an accessibility tree — headings, text, form state, and hierarchy — instead of raw HTML:

```yaml
- document "Settings"
  - heading "Workspace" [level=1]
  - text: "Connected as Maya"
  - textbox "Display name" [ref=@e2]
  - button "Save changes" [ref=@e3]
```

Interactive elements carry refs like `@e3`. The agent passes a ref to `browser_click`, `browser_fill`, and the other action tools. Refs come from the latest snapshot of that tab and expire when the page changes — a stale ref returns an error instead of acting on the wrong element.

For anything the tree can't capture, agents fall back to `browser_screenshot`, and `browser_logs` exposes console messages and network timing.

## Architecture

```
agent ──MCP──▶ daemon (broker) ──▶ browser host (desktop app) ──▶ webview
```

- **Workspace-scoped tabs.** An agent only sees and controls tabs in its own workspace. New tabs open in the background without stealing your focus.
- **Tab-to-host routing.** The daemon remembers which host owns each tab and routes tab commands there. `browser_list_tabs` aggregates all connected hosts.
- **Trusted input.** Clicks, keys, hovers, and drags are dispatched as real browser input events — CSS `:hover` triggers, and pages can't tell an agent's click from a user's. Every action first waits for its target to be visible, enabled, and stable.
- **Dialogs never block.** `alert` is accepted; `confirm`, `prompt`, and `beforeunload` are dismissed. Every handled dialog is reported in the tool result so the agent knows the page flow changed.

## Security

- Navigation is restricted to `http(s)` URLs.
- File uploads can only reference files inside the agent's workspace.
- Tabs share the browser profile you use in Paseo, including cookies and logins — that's what makes logged-in testing work, and why the feature is opt-in per host.

See the [tools reference](/docs/browser-tools) for the full tool list.
