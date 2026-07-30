# Workflows

Workflows are user-defined state machines that coordinate Paseo agents and workspaces. The daemon
runs them through one `WorkflowService`; the app, CLI, WebSocket API, and agent tools are clients of
that service.

Paseo still owns agent identity, provider sessions, turns, timelines, permissions, projects,
workspaces, worktrees, and reload. A workflow owns its spec, materialized inputs, flow instances,
routing events, run state, limits, stop and resume intent, and audit records. Do not add a workflow
daemon, socket, subprocess adapter, or workflow-specific MCP server.

Loops remain a separate fixed retry primitive. Do not translate Loop records into workflows or route
Loop APIs through `WorkflowService`.

## Create and run a workflow

Workflow definitions are JSON data. Saving one never rebuilds Paseo.

- Browser web and Electron: open **Workflows**, paste or import JSON, validate, save, fill declared
  parameters, then run.
- CLI: use `paseo workflow validate`, `import`, `specs`, `show`, and `run`.
- Agent tool catalog: use `validate_workflow`, `save_workflow`, and `run_workflow`.

User specs live under `$PASEO_HOME/workflows/specs/`. Bundled JSON templates provide `echo-demo`,
`goal`, `reviewed-goal`, and `research-project`. A built-in ID cannot be shadowed by a user file.
Use the templates in `packages/server/src/server/workflow/templates/` as complete examples.

The root launch context may supply a workspace and agent. Parameters with `defaultFrom` set to
`current.workspace`, `current.worktree`, or `current.agent` resolve from that context before the
canonical materialized spec is written. Required unresolved defaults fail validation. Optional
unresolved defaults materialize as `null`.

Submission validates and persists a queued run before it returns the run ID. Provider, model, mode,
thinking, workspace, and agent checks continue in the queued run. Reusing the caller agent waits for
the invoking turn to become idle without holding the submission request.

## JSON contract

`schemaVersion` is `paseo.workflows.v0.2`. A spec declares:

- parameters and root `current.*` bindings
- workspace reuse or worktree creation
- named agent roles, creation settings, and `reuse-agent` or `fresh-agent` persistence
- named flows with an entry state
- prompts and materialized inputs
- protocol repair attempts and run limits

States use one action: `turn`, `call`, `map`, `return`, or `stop`.

`turn` routing accepts only a named `emit_event` tool call declared by that state. The event message
becomes `event.message`; optional data is checked against the event's JSON Schema and becomes
`event.data`. Invalid, missing, stale, unauthorized, and duplicate events do not route the flow.
Protocol failures can retry the same turn up to the declared repair limit, then use the
`error.protocol` route. Agent failures use `error.agent`. There is no prose or sentinel routing.

`call` starts a nested flow. `map` starts one child flow per item, honors its concurrency bound, and
joins results in input order. A child may reuse the parent workspace or create an isolated Paseo
worktree. Agent reuse is local to the flow instance; `fresh-agent` creates a new agent for each turn.

Optional event data uses standard JSON Schema and is compiled during spec validation in
`packages/server/src/server/workflow/spec.ts`.

## Persistence and recovery

New runs use this layout:

```text
$PASEO_HOME/workflows/
├── specs/{workflow-id}.json
└── runs/{run-id}/
    ├── spec.json
    ├── state.json
    ├── events.jsonl
    ├── rendered-prompts/
    └── event-history/
```

`spec.json` is the fully materialized canonical JSON used by that run. `state.json` is replaced
atomically. `events.jsonl` is append-only. Rendered prompts and accepted-event records retain the
workflow turn, native turn, agent, and flow identities needed for inspection and replay rejection.
The run state retains active and completed turn identities plus agent and workspace control targets.

On daemon startup, `WorkflowService` loads non-terminal intent and reconciles each recorded turn
against the existing Paseo agent and its canonical timeline. It calls the normal
`ensureAgentLoaded()` path; it does not restore provider sessions itself. A matching active turn is
awaited, a matching completed turn is consumed, and only a missing turn can be launched. The stable
workflow client message ID prevents a recovered turn from being appended twice.

Historical `$PASEO_HOME/workflow-runs/{run-id}/spec.yaml` runs remain inspectable. The reader
normalizes their state and audit records without mutating them. They remain non-resumable unless the
native state contract can prove safe control ownership.

Stop is graceful. It records intent, lets active native turns settle, and launches no new action.
The run becomes `stopped` after active turns drain. Resume continues the persisted runnable state.
Terminal `complete`, `failed`, and limit-stopped runs do not restart.

## Tool authorization

`emit_event` is a native Paseo tool. Providers may expose the transport-neutral Paseo tool catalog
through their own adapter; MCP injection is not required.

The tool has no workflow capability token. `WorkflowService` resolves authorization from:

1. the caller agent attached by Paseo's tool catalog
2. that agent's current native foreground turn
3. the persisted active workflow turn
4. the event name and optional data schema declared by that turn

The service accepts the event once. Caller-supplied agent IDs, run IDs, workflow turn IDs, native
turn IDs, or filesystem paths cannot override those bindings. Stale turns, replays, duplicates, and
events from another agent are rejected.

Clients can control workflows only through the authenticated daemon connection. Spec and run IDs
are validated as opaque names; storage rejects traversal and symlinked targets. The app never
receives filesystem write authority. Prompt reads are limited to prompt files referenced by the
selected run state, including for historical runs.

## Surfaces and compatibility

The WebSocket API uses `workflow.spec.*` and `workflow.run.*` request/response pairs. Clients gate
the entire feature on `server_info.features.workflows`; do not add per-operation fallbacks.
`@getpaseo/client`, the CLI, the Workflows screen, and the native agent tools use the same service.

The Workflows screen is available in browser web and Electron desktop. It shows specs, declared
parameters, validation results, run state, events, rendered prompts, errors, and links to native
agent and workspace screens. Transcripts, permissions, agent controls, and workspace controls stay
on their existing Paseo surfaces. Mobile has no Workflows route in this release; backend and
protocol behavior remain platform-neutral.
