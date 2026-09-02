---
name: paseo-browser
description: Drive websites through Paseo's browser automation CLI. Use when an agent needs to open or inspect a real browser tab, click, type, fill forms, upload files, evaluate JavaScript, capture screenshots, or read browser logs with `paseo browser`, especially when browser MCP tools are unavailable or intentionally omitted from the session.
---

# Paseo Browser

Use `paseo browser` as the CLI adapter to Paseo's browser automation catalog. It runs the same daemon-side tools as `browser_*` MCP calls; do not replace it with a separate Playwright or CDP implementation.

## Prerequisites and scope

A connected Paseo Desktop client supplies the browser host. Browser tools must be enabled on the daemon. If a command reports `BROWSER_NO_HOST` or `BROWSER_DISABLED`, explain which prerequisite is missing instead of restarting the daemon.

Browser tabs belong to a workspace. Run commands from that workspace directory, or pass the same scope to every command:

```bash
paseo browser tabs --cwd /absolute/workspace/path
paseo browser tabs --workspace <workspace-id>
```

Use `--workspace` for a remote daemon unless the `--cwd` path is meaningful on both machines. Add `--host <host>` to every command when targeting a non-default daemon.

## Core workflow

1. Open a tab and retain its opaque `browserId`:

   ```bash
   paseo browser new-tab https://example.com --format json
   paseo browser tabs --format json
   ```

2. Wait for a stable page state, then snapshot:

   ```bash
   paseo browser wait <browser-id> --text "Example Domain" --timeout 30000
   paseo browser snapshot <browser-id>
   ```

3. Use only `@eN` refs from the latest snapshot:

   ```bash
   paseo browser click <browser-id> @e3
   paseo browser fill <browser-id> @e7 "Ada Lovelace"
   paseo browser keypress <browser-id> Enter --ref @e7
   ```

4. Snapshot again after navigation or a DOM-changing action. Refs are ephemeral; on `BROWSER_STALE_REF`, take a new snapshot and resolve the element again. Never guess a ref.

5. Capture evidence or diagnostics when useful:

   ```bash
   paseo browser screenshot <browser-id> --full-page --out /tmp/page.png
   paseo browser logs <browser-id> --max-entries 100 --format json
   ```

6. Close tabs created for the task:

   ```bash
   paseo browser close-tab <browser-id>
   ```

Prefer `--format json` when extracting IDs or inspecting structured results. Use the default human output when a person will read the command directly.

## Command reference

```text
paseo browser new-tab [url]
paseo browser tabs
paseo browser navigate <browser-id> <url>
paseo browser click <browser-id> <ref> [--button <button>] [--double-click] [--modifiers <modifier>]
paseo browser fill <browser-id> <ref> <value>
paseo browser type <browser-id> <text> [--ref <ref>]
paseo browser select <browser-id> <ref> <value>
paseo browser drag <browser-id> <source-ref> <target-ref>
paseo browser hover <browser-id> <ref>
paseo browser keypress <browser-id> <key> [--ref <ref>]
paseo browser scroll <browser-id> <delta-x> <delta-y> [--ref <ref>]
paseo browser upload <browser-id> <ref> <file...>
paseo browser evaluate <browser-id> <js-function> [--ref <ref>]
paseo browser snapshot <browser-id>
paseo browser wait <browser-id> (--text <text> | --url <fragment>) [--timeout <ms>]
paseo browser logs <browser-id> [--max-entries <count>]
paseo browser screenshot <browser-id> [--full-page] [--out <path>]
paseo browser resize <browser-id> <width> <height>
paseo browser reload <browser-id>
paseo browser back <browser-id>
paseo browser forward <browser-id>
paseo browser close-tab <browser-id>
```

Run `paseo browser <command> --help` for exact arguments and options.

## Action rules

- Use `fill` to replace an input's value. Use `type` when key-by-key input behavior matters or when typing into the focused element.
- Pass JavaScript to `evaluate` as a function, for example `'() => document.title'`. With `--ref`, the resolved element is the function's first argument.
- `wait` accepts exactly one of `--text` or `--url`; its maximum timeout is 30000 ms.
- `click --modifiers` is repeatable and accepts `Alt`, `Control`, `Meta`, or `Shift`.
- `upload` paths must exist on the machine hosting the browser. A local path is not automatically copied to a remote daemon.
- Treat `BROWSER_TIMEOUT` as an operation failure, not evidence that the daemon should restart. Inspect `tabs`, retry only when safe, and preserve evidence before changing state.
- Use `evaluate` for targeted reads or actions that the semantic ref commands cannot express. Do not use it to bypass `snapshot` and refs for normal interaction.
