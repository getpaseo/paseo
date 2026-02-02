# UI vs Background Agents — Labels Spec

## Goal
Distinguish UI agents (visible in the mobile app) from background/CLI agents with a minimal labels system.

## Non-Goals
- Complex label semantics (namespaces, inheritance, or validation beyond `key=value`).
- Additional MCP tools or prompt injection.

---

## Summary of Decisions
- **Labels are the single source of truth** for UI vs background.
- `--ui` is **syntactic sugar** for `--label ui=true`.
- **Default `paseo run` is background** (no `ui=true`).
- **Only agents with `ui=true`** show in the mobile app.
- **No special MCP injection** for UI agents.

---

## CLI Changes

### `paseo run`
Add support for labels and UI flag.

#### New Flags
- `--label <key>=<value>` (repeatable)
- `--ui` (equivalent to `--label ui=true`)

#### Behavior
- `paseo run "Fix tests"` → no labels set
- `paseo run --ui "Fix tests"` → label `ui=true`
- `paseo run --label env=ci --label team=infra "Fix tests"`

#### Parsing Notes
- Accept multiple `--label` flags.
- Treat `--ui` as a shorthand that **adds** `ui=true` (do not override an explicit `--label ui=...`).
- If a user passes `--label ui=false` and `--ui`, the explicit label wins (keep `ui=false`).

### `paseo ls`
Add label filtering.

#### New Flags
- `--label <key>=<value>` (repeatable)
- `--ui` (equivalent to `--label ui=true`)

#### Filtering Behavior
- `paseo ls` shows **background agents only** (agents without `ui=true`).
- `paseo ls --ui` shows agents with `ui=true`.
- `paseo ls --label env=ci` filters to agents with `env=ci`.
- `paseo ls --label env=ci --ui` filters to `env=ci` **and** `ui=true`.
- Keep `-a` / `--all-statuses` and `-g` / `--global` behavior unchanged; label filtering is orthogonal.

---

## Daemon Changes

### Label Storage
- Store labels on the agent object in the daemon (e.g., `labels: Record<string, string>`).
- Persist labels to disk (same persistence mechanism as agents today).

### Label Filtering
- When listing agents, apply label filters as **exact match** on key/value.
- If multiple `--label` flags are provided, require **all** to match (AND semantics).

### UI Agent Behavior (`ui=true`)
- UI agents are visible in the mobile app UI.
- No special MCP server injection or prompt injection for UI agents.

---

## Metadata Generation (Title + Branch)
- The daemon may generate agent metadata **asynchronously** on creation using the initial user prompt.
- Title generation is skipped when a title is explicitly provided.
- Branch generation is only attempted when running inside a Paseo-owned worktree and the branch is still the worktree directory name.

---

## Acceptance Criteria
- `paseo run --ui "Task"` creates an agent with `labels.ui === "true"`.
- UI agents show up in the mobile app; background agents do not.
- No MCP-based self-identification remains in the system.
