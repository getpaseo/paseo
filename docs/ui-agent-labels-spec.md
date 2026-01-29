# UI vs Background Agents — Labels + UI MCP Spec

## Goal
Introduce a simple labels system to distinguish UI agents (visible in the mobile app) from background/CLI agents, while keeping the implementation minimal and extensible.

## Non-Goals
- No complex label semantics (no namespaces, inheritance, or validation rules beyond `key=value`).
- No migration or auto-tagging beyond explicit flags.
- No new MCP tools beyond `set_title` and `set_branch`.

---

## Summary of Decisions
- **Labels are the single source of truth** for UI vs background.
- `--ui` is **syntactic sugar** for `--label ui=true`.
- **Default `paseo run` is background** (no `ui=true`).
- **Only agents with `ui=true`** get the UI MCP injection and show in the mobile app.
- **Remove the current `agent-control` MCP injection** from all agents.
- **Branch name is simple and consistent**; avoid extra indirection or derived naming.

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
When an agent has label `ui=true`:
1. **Inject** the new `Paseo` MCP server with **only** `set_title` and `set_branch`.
2. **Inject** UI-specific prompt instructions (see below).
3. **Expose** agent in mobile app UI (mobile filters to `ui=true` on the server side or via API).

Agents without `ui=true`:
- **No Paseo MCP injection.**
- **No UI prompt instructions.**
- **Not shown** in the mobile app UI.

### Remove Agent-Control MCP Injection
- Remove the current agent-control MCP injection for **all** agents.
- This logic should be deleted (not conditionally disabled).

---

## MCP: `Paseo` Server Definition

### Name
`Paseo` (exact capitalization)

### Tools (ONLY)
- `set_title(title: string)`
- `set_branch(name: string)`

### Availability
- **Injected only** when `labels.ui === "true"`.

---

## Prompt Instructions (Injected Only for UI Agents)
Keep the instructions short and direct. Inject them at the start of the prompt for UI agents.

**Text to inject (verbatim):**
```
You are running under Paseo. You MUST call set_title immediately after understanding the task. Call it exactly once per task—do not repeat.
You are running inside a Paseo-owned worktree. Call set_branch once (alongside set_title) to name your branch.
```

---

## Mobile App Behavior
- The app shows **only agents with `ui=true`**.
- No change to app UI beyond filtering logic.

---

## Migration / Removal Checklist
- [ ] Remove agent-control MCP injection from the daemon for all agents.
- [ ] Add new `Paseo` MCP injection gated on `labels.ui === "true"`.
- [ ] Ensure `paseo run` supports `--label` and `--ui`.
- [ ] Ensure `paseo ls` supports `--label` and `--ui` filtering.
- [ ] Persist labels with agent metadata.

---

## Acceptance Criteria
- `paseo run --ui "Task"` creates an agent with `labels.ui === "true"`.
- UI agents have access to only `set_title` and `set_branch` MCP tools.
- Background agents have **no** `Paseo` MCP tools.
- `paseo ls --ui` returns only UI agents.
- Mobile app displays only UI agents.
- No remaining references to the old agent-control MCP injection.
