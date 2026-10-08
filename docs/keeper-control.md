# Keeper control API

An opt-in set of RPCs for a local consumer (the "keeper") that inspects an agent and then sends it a
message without being able to clear a question that appeared between the two calls. The existing
`send_agent_message_request` is unchanged.

## Enabling

Off by default. Set `daemon.keeperControl.enabled: true` in `config.json` and restart; there is no live
toggle. When on, `server_info.features.keeperControl` is `true`. When off, every keeper RPC answers
`disabled` and does nothing.

## RPCs

| Request                                    | Permission        | Purpose                                                |
| ------------------------------------------ | ----------------- | ------------------------------------------------------ |
| `keeper.agent.get_snapshot.request`        | `workspace.read`  | Incarnation, generation, pending ids and kinds, cursor |
| `keeper.agent.send_message.request`        | `workspace.write` | Guarded send                                           |
| `keeper.agent.get_pending_request.request` | `workspace.write` | Bounded detail of one pending permission or question   |
| `keeper.events.read.request`               | `workspace.read`  | Cursor read of the event feed, optional long-poll      |

All take the full agent ID; prefixes and titles are never resolved.

## State the guard compares

- **Session incarnation**: a random ID minted whenever a provider session is bound to the agent
  (create, resume, reload). A new session means a new incarnation.
- **Permission generation**: a per-agent counter that increases on every real change to the pending
  permission set (a request appearing or disappearing, including a provider-side reconciliation). It is
  kept across session replacement, so within one daemon process it never goes backwards.
- **Boot ID**: changes on every daemon start. Generations restart from zero then, so always compare
  `(bootId, incarnation, generation)` and treat a changed boot ID as "re-snapshot".

## Guarded send

Inside the agent's serialization lane the daemon: applies queued provider events; compares incarnation
and generation; writes a durable `pending` receipt; applies events again and compares again; then calls
the provider with no await in between. A rejection at any point happens before a message is recorded, a
turn is interrupted, the provider is called, or a permission is resolved, and the receipt is released.

The send never passes `clearPendingPermissions`, never interrupts, never unarchives or loads an agent.
A question that arrives while the provider acknowledges is held by the existing steer barrier or pending
start and applied afterwards: it stays pending.

`onActiveTurn` is required: `steer` steers the running turn and is refused with `steer_unavailable` if
the provider cannot (there is no replace fallback); `reject` refuses with `turn_active`.
`allowPendingPermissions` defaults to false, so a send while anything is pending is `permission_pending`.

Results: `accepted`, `duplicate`, `rejected` (with `reason`), `outcome_unknown`. Reasons: `disabled`,
`agent_not_found`, `agent_not_live`, `agent_archived`, `stale_incarnation`, `stale_generation`,
`permission_pending`, `turn_active`, `steer_unavailable`, `admission_busy`, `idempotency_conflict`,
`send_failed`. `rejected` always means zero side effects; retry after a fresh snapshot. A receipt that appears
between the pre-check and the reserve answers `duplicate` or `outcome_unknown` and is never sent.
The receipt lookup runs before any agent-existence check, so a retry after an unknown outcome
still answers `outcome_unknown`. A failed receipt release is retried once; if it fails again the reply is `outcome_unknown`, never `rejected`,
because the pending receipt is still on disk. A provider error after the start was dispatched stays
`outcome_unknown`, since the daemon cannot tell whether the provider acted.

## What an acknowledgement means

`accepted` means the provider accepted the turn start or the steer (`delivery` is `turn_started` or
`steered`). It does not mean the agent read, answered or acted on the message, and there is no queueing:
a message the provider did not accept is rejected. Completion is observed through `turn.completed`
events.

## Dedupe and retries

`idempotencyKey` is scoped to the agent; the fingerprint covers `text` and `onActiveTurn` only, so a
retry may carry newer expected values. Receipts are files under `<paseoHome>/keeper-send-receipts`.
A `completed` receipt answers `duplicate`. A `pending` receipt (a crash, a timeout, a failed ack)
answers `outcome_unknown` and is never resent; choose a new key only after confirming the message did
not land. The same key with different text is `idempotency_conflict`. Concurrent retries of one key are
serialized in-process. A retry never sends twice.

## Event feed

`keeper.events.read.request` returns events in `seq` order with cursor `<epoch>.<seq>`. Categories:
`lifecycle`, `turn_complete`, `question`, `permission`. Each carries event ID, seq, timestamp, agent ID,
boot ID, session incarnation, permission generation, request ID and turn ID where they apply.

The feed carries no question text, tool input or credentials. Read those through
`keeper.agent.get_pending_request.request`, which requires the current incarnation and generation and
truncates (`truncated: true`).

Ordering: seq is assigned when the event arrives. Permission events carry the exact generation after
that change. Reads return only events already flushed to `<paseoHome>/keeper-events`, so a consumer
never sees an event a restart would forget. Retention is bounded (10,000 events). A cursor from another
epoch, or one older than retention, returns `resyncRequired: true`: take a fresh snapshot and use its
`eventCursor`.

## Restart behavior

The feed and receipts survive a restart; incarnations, generations and in-flight sends do not. After a
restart every agent has a new incarnation (sessions are reloaded) and a new boot ID, so all old guards
are stale. An agent whose close outlives the shutdown timeout gets a `lifecycle.close_timeout` event instead of
its closure event. If the feed cannot write (disk full, I/O error) it stops advancing for the rest of the process, and
`keeper.events.read` and `keeper.agent.get_snapshot` answer with `error: "event feed stalled: ..."`;
treat that as "restart the daemon". Events buffered but not flushed at a crash are lost, which is why reads never expose them.

## Known races

The guarded send holds the agent's lifecycle lane as well as its foreground lane, so reload, archive
and detach queue behind it. The archive flag is re-read after the receipt is reserved; the tiny window
between that read and the provider call is not closed. With the flag off, pending permissions stay a
plain map and no generation is counted.

The daemon cannot exclude the provider emitting a question at the same moment it accepts the turn; it
preserves that question rather than excluding it. Turn events from a session that was just replaced may
carry the newer incarnation. A provider that cannot steer while a question is pending is reported as
`steer_unavailable`, not worked around.
