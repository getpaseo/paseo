---
title: When to use the Paseo browser
description: When to reach for Paseo's built-in browser instead of Playwright or agent-browser.
nav: When to use
order: 36
category: Browser
---

# When to use

Paseo gives agents a [real browser inside Paseo](/docs/browser). Standalone tools like Playwright or agent-browser give an agent its own browser in a separate process. They overlap, so which one?

Use the Paseo browser when:

- **You're running agents remotely and want to watch.** You see the same browser the agent is driving, live in the Paseo desktop app — not a headless browser on a box you can't see.
- **You want the browser inside Paseo.** It's a tab in the same session, not a separate agent window to manage.
- **You don't want to set up extra tools.** It's built in — no separate MCP server or CLI to install and wire up.

Reach for Playwright or agent-browser when the browser work stands on its own — headless CI runs, an existing test suite, or automation that isn't tied to an agent session in Paseo.

The Paseo browser is [desktop only for now](/docs/browser).
