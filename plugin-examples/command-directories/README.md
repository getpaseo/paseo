# Command directories plugin example

This example contributes custom slash commands discovered for the active workspace. It is
provider-agnostic: executing a command expands its Markdown body and sends the resulting ordinary
prompt to the current agent.

Configure any number of daemon-host directories in `shared/config.ts`:

```ts
export const configuredCommandDirectories = [
  { relativeTo: "workspace", path: ".commands" },
  { relativeTo: "project", path: "team/commands" },
  { relativeTo: "absolute", path: "/opt/company/commands" },
];
```

Relative workspace paths resolve from the active workspace's actual directory, including a Paseo
worktree. Relative project paths resolve from the registered project's source checkout. Absolute
paths refer to the daemon machine. Earlier entries win duplicate command names.

Each direct `*.md` child becomes one command. For `.commands/review.md`:

```md
---
description: Review the current changes
argument-hint: [scope]
---

Review $ARGUMENTS and report findings by severity.
```

The composer shows `/review` only in workspaces where one configured directory contributes it.
Templates support `$ARGUMENTS`, positional `$1` through `$9`, named arguments such as `$TARGET`
from `TARGET=value`, and `$$` for a literal dollar sign.

Install the example after choosing its directories:

```bash
npm run typecheck
paseo plugin install /absolute/path/to/plugin-examples/command-directories
```
