# Agent lifecycle

How an agent is created, runs, becomes a subagent, gets archived, and disappears from the UI. The model spans the daemon (lifecycle, archive) and the client (tabs, the subagents track).

## States

```
initializing → idle → running → idle (or error → closed)
                 ↑        │
                 └────────┘  (agent completes a turn, awaits next prompt)
```

Each live agent in `AgentManager` carries a `lastStatus` of `initializing`, `idle`, `running`, or `error`. `closed` is the persisted, resumable state for an agent record that has no live provider runtime. State transitions persist to disk and stream to subscribed clients via WebSocket.

## Runtime residency

An unarchived agent may be `closed` without being deleted or archived. Closing releases its provider
processes and subscriptions while retaining its Paseo identity, persistence handle, timeline,
workspace, labels, title, usage, attention, timestamps, and parent relationship. Opening or prompting
the agent runs through `ensureAgentLoaded()`, which resumes the durable provider session under the
same Paseo agent ID. Provider history is not appended again when the canonical timeline is already
primed.

Idle agents remain resident indefinitely. Runtime closure happens only through an explicit lifecycle
action such as archive, replacement, reload, workspace teardown, or daemon shutdown.

A provider runtime can still die on its own — crash, OOM kill, host suspend. Work the agent parked
inside that process dies with it: Claude Code's background Bash shells, `Monitor` watches, and
workflows all live in the CLI process, and the completion notification that would have woken the
agent never arrives. A runtime that dies mid-turn is reported by whatever is draining its stream, but
between turns nothing is watching, so the agent sits at `idle` looking healthy while its background
work is gone. Report that exit as a turn failure so the agent lands in `error` with a timeline entry.
Only the Claude provider does this today; the others still report a death only when a turn happens to
be in flight.

### Cancellation

Provider interruption is idempotent at the provider connection boundary. It resolves when the prior
foreground turn can no longer run, including when the provider reports that it is already idle. It
rejects only when the provider may still own the turn. Provider adapters translate native errors
into that contract; lifecycle callers do not interpret provider-specific errors.

After an acknowledged interrupt, the manager settles the captured run even when no terminal event
arrives or the run was still waiting for its provider turn id. The captured run token prevents an
older cancellation from settling a newer turn. If interruption is rejected or times out, the agent
keeps its active foreground turn and replacement, reload, rewind, and Stop report the failure.
Accepting new work after an ambiguous interruption would create a split-brain session.

## Relationships

Agents can launch other agents via the agent-scoped `create_agent` MCP tool. Agent-scoped creation is always asynchronous and always stamps `paseo.parent-agent-id`, pointing back at the caller. Omit `workspaceId` to use the caller's workspace, or pass an existing workspace ID returned by `create_workspace`. Placement never changes parentage.

- **Subagents** — exist as part of the creating agent's work, appear in that agent's subagent track, and are archived with it.
- **Detached agents** — stand on their own after an explicit detach transition, do not appear in the former parent's subagent track, and are not archived with it.

Parent archive detaches a subagent instead of archiving it when either condition holds:

- The child belongs to another workspace.
- The child is currently open in an agent tab.

All other children archive with the parent. After the workspace layout hydrates, the client marks
every managed subagent present in its tabs with `paseo.open-agent-tab.<client-id>=true` through the
generic agent metadata update. This includes background and restored tabs; navigation does not own
the marker. Closing a tab sets that client's label to `false`. Any `true` client label keeps the child
open. Detach clears the parent and every open-tab label. The surviving child therefore becomes a
normal root agent immediately, and closing its still-open tab archives it.

Runtime ownership is resolved from explicit workspace ID and caller context, never from `cwd`. Workspace creation is a separate operation with `local | worktree` isolation; agent creation only selects an existing workspace.

Users can also detach an existing subagent from the subagents track. Detach is deliberately a manual lifecycle gesture, not an agent-facing MCP tool. It removes the parent and open-tab lifecycle labels: it does not stop, archive, move, or restart the agent. The agent keeps its current `cwd` and `workspaceId`, leaves the former parent's track, and behaves like a root agent for tab close, workspace activity, and future parent archive.

`notifyOnFinish` defaults to `true` for agent-scoped creation and background prompt follow-ups because most delegated work needs to report back to the creating agent. Set it to `false` only for truly fire-and-forget agents or prompts.
Permission requests are notification checkpoints, not the end of that subscription. The caller is notified again after a permission response when the child finishes, errors, or requests another permission.
The permission notification includes the normalized request plus the child and request IDs, so the caller can inspect it and respond without fetching agent status.
A watched child that closes before its finish event also notifies the caller so delegated work cannot disappear silently during archive or workspace teardown.

## Provider-managed child agents

Some providers can create their own child sessions inside one provider runtime. OMP's task tool reports these with `child_session` events; `AgentManager` imports the live provider handle, stamps `paseo.parent-agent-id`, and surfaces the result as a normal subagent in the parent's subagents track.

The provider still owns the underlying runtime. Paseo keeps an agent record so the child can be opened, tracked, archived, and cascaded with the parent, but prompts and history hydration route through the provider adapter for that native child handle.

## Archive

Archive is a **soft delete**: the agent record stays on disk with `archivedAt` set, the runtime is closed, and the agent disappears from active lists. Archive is **global** — it lives on the server and propagates to every connected client.

Archive sets `archivedAt`, invokes the provider's native archive hook, and cascades to managed
children.

`create_agent_request` can opt an agent into `autoArchive`. In that mode the daemon archives the agent after the first terminal turn event (`turn_completed`, `turn_failed`, or `turn_canceled`). When the agent owns an isolated workspace, auto-archive archives that workspace too; the managed worktree is removed when its final workspace reference is gone.

Archiving runs through `AgentManager.archiveAgent` (`packages/server/src/server/agent/agent-manager.ts`):

1. Snapshot the current session into the registry
2. Set `archivedAt` and normalize `lastStatus` away from `running`/`initializing`
3. Notify subscribers
4. Close the runtime (kills the process if still running)
5. **Resolve children** — detach cross-workspace and open-tab children; cascade-archive the rest recursively

Cascade is what keeps subagent fleets from outliving their orchestrator.

Workspace archive is a separate lifecycle. Archiving or removing a worktree can close a surviving
agent record without setting the agent's `archivedAt`, while its `workspaceId` still points at the
archived workspace. History navigation must not infer workspace lifecycle from `agent.archivedAt`
or mutate either lifecycle. The workspace route asks the daemon for authoritative recovery state;
only the route's explicit Unarchive or Restore action changes the archived workspace.

History navigation preserves the selected agent as an explicit recovery target. If both that agent
and its workspace are archived, the workspace recovery action restores the workspace and unarchives
the selected agent as one user action. Other archived agents in the restored workspace remain
recoverable from History. Opening one pins its tab and renders the archived-agent callout. Authoritative
timeline catch-up may load provider history with a runtime-only `history` resume purpose, which must
leave both Paseo's `archivedAt` and the provider's native archive state unchanged. **Unarchive** remains
the only transition back to an interactive runtime: it runs the provider's native unarchive hook
(including Codex `thread/unarchive`) before the normal agent resume and timeline hydration flow. A
provider session can be archived outside Paseo while its Paseo agent remains active. Interactive
resume repairs that drift through the provider's native unarchive hook; history resume does not.

Provider session connection owns every process it spawns until the session is registered with
`AgentManager`. If initialization, persisted-session resume, or initial history hydration fails,
`connect()` must dispose that process before rethrowing; the manager cannot clean up a session it never
received.

## Tabs vs archive

These are two distinct concepts that used to be conflated:

| Concept                    | Scope      | Triggers                   |
| -------------------------- | ---------- | -------------------------- |
| **Tab** (workspace layout) | Per-client | User opens/closes a view   |
| **Archive** (lifecycle)    | Global     | Explicit lifecycle gesture |

Closing a tab on a **root agent** still archives — the tab is the agent's home, so closing it means "I'm done with this agent." A confirm dialog protects against archiving a running agent by accident.

Closing a tab on a **subagent** (any agent with `parentAgentId`) is **layout-only**. The app clears the current client's open-tab label before removing the tab. Another client's open tab remains protected. The agent stays unarchived and stays in its parent's track, so a later parent archive cascades to it when no client still has it open. The user can re-open the tab from the track at any time. Single and bulk tab close apply the same policy.

The asymmetry is intentional: a subagent's persistent relationship lives in the parent's track. Same-workspace subagents are not auto-opened as tabs; the user opens one from that track when needed. A cross-workspace subagent is also auto-opened as a tab in its own workspace so opening that workspace does not appear empty. It remains in the parent's track until it is actually detached.

## Workspace activity

Agent lifecycle status stays literal: a parent agent is `idle` when its own turn is idle, even if a child is running.

Workspace status is an aggregate activity signal computed **per `workspaceId`**. Ownership is never derived from `cwd` — many workspaces may share one directory, and same-`cwd` siblings do not clump under one status. Root agents and cross-workspace subagents contribute their normal state bucket to their own workspace. Same-workspace descendants contribute `running` to the nearest ancestor in that workspace; their non-running attention, permission, and error states stay in the parent's subagents track. This makes a cross-workspace subagent behave like a detached agent for workspace visibility and status without removing its parent relationship.

## The subagents track

The track is a pill at the foot of an agent's pane (`packages/app/src/subagents/track.tsx`): a count you can read at a glance, and a panel behind it — a popover on wide screens, a sheet on compact ones — holding the rows. It floats over the transcript rather than sitting in a band above the composer, so the timeline scrolls underneath it; `packages/app/src/panels/agent-tracks.tsx` owns that placement, and the pill frame is shared with the task list in `packages/app/src/composer/tracks.tsx`.

The provider connection contract represents a provider-owned child as an ordinary session:
`session.opened` carries `parentSessionId`, and all later lifecycle and timeline events use the
child's own session ID. `restoration: "parent"` leaves recreation with the parent runtime;
`restoration: "core"` supplies persistence so Paseo can reopen it. New providers do not define a
second child event vocabulary.

Every row in the track is an ordinary managed child agent. Its membership rule
(`packages/app/src/subagents/select.ts`) is:

```
parentAgentId === thisAgent.id  AND  !archivedAt
```

Clicking a child opens a workspace tab. Session capabilities decide whether its pane has a composer
or is read-only. Both use `AgentStreamView`, so message, reasoning, tool-call, plugin-item, and layout
rendering stay identical.

Provider descriptors may include one compact subtitle. The provider owns its contents and formatting; clients display and truncate it without interpreting provider-specific model, thinking, or usage fields.

Provider-specific child discovery stays inside the provider implementation or native edge adapter.
The shared lifecycle starts only after that implementation emits `session.opened` with a parent ID.

Archived child agents disappear from the track. The archive button on a row opens a confirmation and
invokes the provider archive action when the session advertises it. **Archive finished** applies the
same lifecycle operation to each eligible child. Running and initializing children remain visible.

To keep the agent alive but remove it from the parent's track, use **detach**. The daemon clears the relationship lifecycle labels, emits the normal agent update, and every client reclassifies the agent from subagent to root/sibling from that updated snapshot.

## Why this shape

The decision was to **decouple "close tab" from "archive" only for subagents**, rather than universally:

- **Closing a tab on a root agent still archives** — preserves the existing UX users are trained on
- **Closing a tab on a subagent is layout-only** — fixes the lossy "click to read, close to dismiss view, lose the row" flow
- **Archive button on track rows** — gives subagents an explicit lifecycle gesture in their home surface
- **Detach button on track rows** — lets a subagent continue independently without killing its work
- **Cascade archive on parent** — keeps subagents from leaking when the parent is archived

We considered universal decoupling (no tab close ever archives, archive is always explicit) but rejected it: it changes a behavior root-agent users rely on.

## Limitations

### Subagent accumulation under long-lived parents

A parent that spawns many subagents will see the panel's list grow; the pill only counts them. Child
agents can be archived individually or with **Archive finished** when their session capabilities
allow it.

### Cross-client tab dismissal

Closing a subagent's tab on one client doesn't affect other clients' layouts. This is the expected behavior of decoupled tabs and is consistent with how layouts have always worked. Archive remains the global gesture for cross-client cleanup.

## Storage

```
$PASEO_HOME/agents/{cwd-with-dashes}/{agent-id}.json
```

`{cwd-with-dashes}` is derived from the agent's filesystem `cwd`. It is not the workspace id; agent storage stays cwd-keyed while workspace identity is the opaque workspace id.

Each agent is a single JSON file. Fields relevant to this doc:

| Field                                        | Type          | Meaning                                                                            |
| -------------------------------------------- | ------------- | ---------------------------------------------------------------------------------- |
| `id`                                         | `string`      | Stable identifier                                                                  |
| `archivedAt`                                 | `string?`     | Soft-delete timestamp (ISO 8601)                                                   |
| `labels["paseo.parent-agent-id"]`            | `string?`     | Parent agent ID, set automatically for agent-scoped creation and removed by detach |
| `labels["paseo.open-agent-tab.<client-id>"]` | `string?`     | `"true"` protects an open tab on that client; detach clears every matching label   |
| `lastStatus`                                 | `AgentStatus` | `initializing` / `idle` / `running` / `error` / `closed`                           |

See [`docs/data-model.md`](./data-model.md) for the full agent record.
