# Agent lifecycle

How an agent is created, runs, becomes a subagent, gets archived, and disappears from the UI. The model spans the daemon (lifecycle, archive) and the client (tabs, the subagents track).

## States

```
initializing → idle → running → idle (or error → closed)
                 ↑        │
                 └────────┘  (agent completes a turn, awaits next prompt)
```

Each agent in `AgentManager` carries a `lastStatus` of `initializing`, `idle`, `running`, `error`, or `closed`. State transitions persist to disk and stream to subscribed clients via WebSocket.

## Relationships

Agents can launch other agents via the `create_agent` MCP tool. When they do, the daemon stamps the new agent with a label `paseo.parent-agent-id` pointing back at the caller (`packages/server/src/server/agent/mcp-server.ts:804`). The client surfaces that as `agent.parentAgentId`.

There is exactly one relationship type today: `parentAgentId`. The daemon does not distinguish between:

- **Subagents** — children that exist as part of the parent's work (e.g. orchestration tasks the parent delegates and waits on)
- **Detached agents** — children launched to take over from the parent (e.g. handoffs, fire-and-forget delegations)

Both look the same in storage. This is an accepted limitation — see [Limitations](#limitations).

## Archive

Archive is a **soft delete**: the agent record stays on disk with `archivedAt` set, the runtime is closed, and the agent disappears from active lists. Archive is **global** — it lives on the server and propagates to every connected client.

Archiving runs through `AgentManager.archiveAgent` (`packages/server/src/server/agent/agent-manager.ts`):

1. Snapshot the current session into the registry
2. Set `archivedAt` and normalize `lastStatus` away from `running`/`initializing`
3. Notify subscribers
4. Close the runtime (kills the process if still running)
5. **Cascade-archive children** — any agent whose `paseo.parent-agent-id` label matches the archived agent gets archived too, recursively

Cascade is what keeps subagent fleets from outliving their orchestrator.

## Tabs vs archive

These are two distinct concepts that used to be conflated:

| Concept                    | Scope      | Triggers                   |
| -------------------------- | ---------- | -------------------------- |
| **Tab** (workspace layout) | Per-client | User opens/closes a view   |
| **Archive** (lifecycle)    | Global     | Explicit lifecycle gesture |

Closing a tab on a **root agent** still archives — the tab is the agent's home, so closing it means "I'm done with this agent." A confirm dialog protects against archiving a running agent by accident.

Closing a tab on a **subagent** (any agent with `parentAgentId`) is **layout-only**. The agent stays unarchived and stays in its parent's track. The user can re-open the tab from the track at any time. This is implemented in `handleCloseAgentTab` (`packages/app/src/screens/workspace/workspace-screen.tsx`).

The asymmetry is intentional: a subagent's home is the parent's track, not the tab. Tabs are ephemeral viewing slots; the track is the persistent record of the parent's children.

## The subagents track

The collapsible section above the composer in an agent's pane (`packages/app/src/subagents/subagents-section.tsx`). Membership rule (`packages/app/src/subagents/subagents.ts`):

```
parentAgentId === thisAgent.id  AND  !archivedAt
```

Archived subagents disappear from the track, by design. To remove a subagent from the track without closing its tab, use the **archive button (X)** on the row — it opens a confirm dialog and archives the subagent on confirm. That same archive shows the subagent leave the track on every connected client.

## Why this shape

The decision was to **decouple "close tab" from "archive" only for subagents**, rather than universally:

- **Closing a tab on a root agent still archives** — preserves the existing UX users are trained on
- **Closing a tab on a subagent is layout-only** — fixes the lossy "click to read, close to dismiss view, lose the row" flow
- **Archive button on track rows** — gives subagents an explicit lifecycle gesture in their home surface
- **Cascade archive on parent** — keeps subagents from leaking when the parent is archived

We considered universal decoupling (no tab close ever archives, archive is always explicit) but rejected it: it changes a behavior root-agent users rely on.

## Limitations

### Detached agents are cascade-archived

The daemon can't tell a "subagent" apart from a "detached agent" — both carry `paseo.parent-agent-id`. So when you archive an agent that previously launched a detached child (e.g. via `/paseo-handoff`), cascade will archive the detached child too, even though semantically it should outlive the originator.

Until a richer relation model lands (e.g. a `relation: "subagent" | "detached"` field on creation, or a separate channel for handoff launches), this trade-off stands. Workaround: don't archive an agent whose work was handed off, or unarchive the detached child afterward.

### Subagent accumulation under long-lived parents

A parent that spawns many subagents will see the track grow. There's no automatic cleanup for completed subagents — the user prunes via the archive button on each row. A bulk gesture (e.g. "archive all idle children") could land later if this becomes a real problem.

### Cross-client tab dismissal

Closing a subagent's tab on one client doesn't affect other clients' layouts. This is the expected behavior of decoupled tabs and is consistent with how layouts have always worked. Archive remains the global gesture for cross-client cleanup.

## Storage

```
$PASEO_HOME/agents/{cwd-with-dashes}/{agent-id}.json
```

Each agent is a single JSON file. Fields relevant to this doc:

| Field                             | Type          | Meaning                                                       |
| --------------------------------- | ------------- | ------------------------------------------------------------- |
| `id`                              | `string`      | Stable identifier                                             |
| `archivedAt`                      | `string?`     | Soft-delete timestamp (ISO 8601)                              |
| `labels["paseo.parent-agent-id"]` | `string?`     | Parent agent ID, set automatically by `create_agent` MCP tool |
| `lastStatus`                      | `AgentStatus` | `initializing` / `idle` / `running` / `error` / `closed`      |

See [`docs/data-model.md`](./data-model.md) for the full agent record.
