# Timeline sync

Agent chat delivery has two paths:

1. **Live stream** — `agent_stream` WebSocket messages for immediacy. These may be delta-shaped lifecycle updates.
2. **Authoritative history** — `fetch_agent_timeline_request` for correctness. This always returns full projected timeline items, never lifecycle deltas.

The invariant is:

> If the daemon has committed timeline rows for an agent, any connected client that opens or resumes that agent eventually displays every row through the daemon's current tail.

Tool output is bounded before it enters either delivery path. Canonical shell tool output is sliced
to 64 KiB, and the same bounded item is used for durable timeline rows and live stream events.
Provider history hydration applies the same rule so reopening an agent cannot restore an oversized
tool payload.

## Presence is not delivery

Client heartbeat reports presence:

- device type
- app visibility
- focused agent
- last activity time

Heartbeat is used for notification routing. It must not be used as a correctness gate for `agent_stream` delivery. A stale mobile focus heartbeat may affect whether the user gets notified; it must not make timeline rows disappear from the live stream.

## Catch-up is paged but complete

Large unbounded timeline responses can exceed relay frame limits, so catch-up uses bounded pages. Bounded does not mean partial.

Page limits are projected-item targets. A tool call lifecycle is one projected item even if it spans many source sequence numbers, and assistant/reasoning chunks are merged before counting. The response carries `seqStart`, `seqEnd`, `sourceSeqRanges`, and `collapsed` so clients can advance sequence cursors without rendering delta rows.

When the app fetches `direction: "after"` and the daemon responds with `hasNewer: true`, the app must immediately fetch the next page from `endCursor`. The catch-up is complete only when `hasNewer: false`.

Initialization timeouts guard lack of catch-up progress, not the full multi-page sync. A successful page that queues the next `after` page refreshes the watchdog.

The first load of an agent without a local cursor is different: it fetches a bounded latest tail page. Older history remains user-driven by scrolling upward.

## Durable item anchors

Provider message IDs are not guaranteed for every displayed item. Paseo-generated system errors are one example. Rendered item indices are not durable either because pagination and projection can merge source rows.

Actions that address a point in chat history, such as Fork, use the daemon timeline `epoch` plus the projected item's `seqEnd`. The app carries that position on the rendered assistant item for both live and fetched history. When adjacent projected chunks merge, the merged item retains the newer chunk's position.

The daemon validates that the epoch is current and the exact source sequence still exists before slicing rows. It slices before projection so later lifecycle updates cannot leak into the selected context.

## Resume behavior

When a client resumes with a known cursor, it catches up after that cursor to completion. It does not replace the view with a latest tail page, because tail pagination can skip the middle of a long background run.

When a client resumes without a cursor, it fetches the latest tail page.

## Selective and legacy delivery

The app chooses one delivery policy from `server_info.features.selectiveAgentTimeline`:

- Selective daemons receive the union of agents visible in every pane. Additions subscribe and
  catch up immediately. Every visibility-driven removal, including app backgrounding, stays
  subscribed for a short grace period so brief tab, pane, route, and app switches do not repeatedly
  unsubscribe and catch up. Losing window keyboard focus does not make a selected pane invisible.
  Disconnecting and disposal clear pending grace because the subscription itself no longer exists.
  After grace has expired, a retained timeline stays covered when revisited until authoritative
  catch-up completes; cached partial output is never presented as current history.
- Legacy daemons keep globally streaming agent timelines. Visibility still triggers the existing
  authoritative catch-up, but the app does not issue selective-subscription RPCs.

This policy is owned by `viewed-timeline-sync.ts`; downstream reducers do not branch on daemon
version.

## Projected pages reconcile with live presentation

A projected page is canonical state, not a sequence of live deltas. One projected item can overlap
rows already received live—for example, a tool call retained at its original display position while
its completion advances `seqEnd`, followed by a merged assistant message. The app uses
`sourceSeqRanges` to replace overlapping assistant and reasoning projections before applying the
remaining page through the existing stream reducer. It must not append full projected text to a
live prefix.

Optimistic user prompts are presentation state rather than canonical history. Incremental catch-up
temporarily separates them, applies canonical entries, lets canonical user rows reconcile through
the existing optimistic-message rules, then restores any unmatched prompts after the caught-up
history. This keeps late history before a newly submitted prompt without duplicating an
acknowledged prompt.

## Relevant code

- Server live stream forwarding: `packages/server/src/server/session.ts`
- App sync planning: `packages/app/src/timeline/timeline-sync-plan.ts`
- App viewed-agent synchronization: `packages/app/src/timeline/viewed-timeline-sync.ts`
- App stream/timeline reducer: `packages/app/src/timeline/session-stream-reducers.ts`
- Session wiring: `packages/app/src/contexts/session-context.tsx`
