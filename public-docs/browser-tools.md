---
title: Browser tools
description: The browser_* MCP tools agents use to drive Paseo browser tabs.
nav: Tools reference
order: 37
category: Browser
---

# Browser tools

The `browser_*` tools are injected into agents alongside the other [Paseo MCP tools](/docs/mcp) when [browser automation](/docs/browser) is enabled.

Shared concepts:

- **`browserId`** identifies a tab. It comes from `browser_new_tab` or `browser_list_tabs` and is required by every tab-scoped tool.
- **`ref`** identifies an element, e.g. `@e3`. Refs come from the latest `browser_snapshot` of the same tab and expire when the page changes — stale refs return an error instead of acting on the wrong element.
- Every result reports **dialogs** the page opened during the command (alerts accepted; confirm/prompt/beforeunload dismissed).

Arguments marked `?` are optional.

## Goal execution

| Tool           | Arguments                                                              | Purpose                                                                                   |
| -------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `browser_goal` | `goal, browserId? \| url?, verify, values?, maxSteps?, minConfidence?` | Run a bounded Jev loop and pass only after every required text or URL check is satisfied. |

Provide either `browserId` or `url`. Each `values` entry contains an `env` variable name and optional description; Paseo resolves the value locally and does not send it to TypeSafe. `verify` is a non-empty array of `{ "text": "..." }` or `{ "url": "..." }` checks.

## Tabs

| Tool                | Arguments                  | Purpose                                                                   |
| ------------------- | -------------------------- | ------------------------------------------------------------------------- |
| `browser_list_tabs` | —                          | List open tabs in the agent's workspace across connected hosts.           |
| `browser_new_tab`   | `url?`                     | Open a tab in the background and return its `browserId`.                  |
| `browser_close_tab` | `browserId`                | Close a tab and clean up its webview.                                     |
| `browser_resize`    | `browserId, width, height` | Resize the tab's viewport — check a layout at phone or tablet dimensions. |

## Handing a tab to the user

| Tool              | Arguments           | Purpose                                                                                                     |
| ----------------- | ------------------- | ----------------------------------------------------------------------------------------------------------- |
| `browser_handoff` | `browserId, reason` | Give the user the tab for a login, 2FA, CAPTCHA, or payment. Returns at once; the agent then ends its turn. |

While the user holds the tab, every browser tool on it returns `browser_denied`. When the user presses Done or Cancel, the agent receives a message with the tab's URL and title. See [taking control of a tab](/docs/browser#taking-control-of-a-tab).

## Reading the page

| Tool                 | Arguments                              | Purpose                                                                               |
| -------------------- | -------------------------------------- | ------------------------------------------------------------------------------------- |
| `browser_snapshot`   | `browserId`                            | Return the page as an accessibility tree with element refs.                           |
| `browser_screenshot` | `browserId, fullPage?`                 | Capture a PNG of the viewport, or the full page with `fullPage`.                      |
| `browser_logs`       | `browserId, maxEntries?`               | Read recent console messages and network timing entries.                              |
| `browser_wait`       | `browserId, text? \| url?, timeoutMs?` | Wait until the page contains text or reaches a URL fragment (exactly one of the two). |

## Interacting

| Tool               | Arguments                                           | Purpose                                                                              |
| ------------------ | --------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `browser_click`    | `browserId, ref, button?, doubleClick?, modifiers?` | Click an element — left/right/middle, double-click, keyboard modifiers.              |
| `browser_fill`     | `browserId, ref, value`                             | Set the value of an input-like element.                                              |
| `browser_type`     | `browserId, text, ref?`                             | Type text into an element, or into the focused element when `ref` is omitted.        |
| `browser_keypress` | `browserId, key, ref?`                              | Press a key (`Enter`, `Escape`, `Tab`, `Space`, …) on an element or the focused one. |
| `browser_hover`    | `browserId, ref`                                    | Hover an element — triggers real CSS `:hover`.                                       |
| `browser_select`   | `browserId, ref, value`                             | Choose an option in a `<select>`.                                                    |
| `browser_drag`     | `browserId, sourceRef, targetRef`                   | Drag one element onto another.                                                       |
| `browser_upload`   | `browserId, ref, filePaths`                         | Set files on a file input. Paths must be inside the agent's workspace.               |
| `browser_scroll`   | `browserId, deltaX, deltaY, ref?`                   | Scroll the page, or center the wheel input over an element with `ref`.               |

## Navigation

| Tool               | Arguments        | Purpose                                             |
| ------------------ | ---------------- | --------------------------------------------------- |
| `browser_navigate` | `browserId, url` | Go to an `http(s)` URL.                             |
| `browser_back`     | `browserId`      | Go back — errors when there is no history to go to. |
| `browser_forward`  | `browserId`      | Go forward — errors when there is no forward entry. |
| `browser_reload`   | `browserId`      | Reload the page.                                    |

## Scripting

| Tool               | Arguments                   | Purpose                                                                                                                                  |
| ------------------ | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `browser_evaluate` | `browserId, function, ref?` | Run a JavaScript function in the page. With `ref`, the resolved element is passed as the first argument. Results return as bounded JSON. |

## Errors

Tools return structured errors rather than failing silently. The ones agents see most:

| Code                | Meaning                                                                                                       |
| ------------------- | ------------------------------------------------------------------------------------------------------------- |
| `browser_disabled`  | Browser tools are turned off on this host.                                                                    |
| `browser_no_host`   | No browser host (desktop app) is connected. Retryable.                                                        |
| `browser_stale_ref` | The ref no longer matches the page — take a new snapshot.                                                     |
| `browser_timeout`   | The element never became actionable, or the wait condition never held.                                        |
| `browser_denied`    | The action isn't allowed — e.g. a non-`http(s)` URL, no history to navigate, or a tab handed off to the user. |
