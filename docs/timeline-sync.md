# Timeline sync

Agent chat delivery has two paths:

1. **Live stream** — `agent_stream` WebSocket messages for immediacy.
2. **Authoritative history** — `fetch_agent_timeline_request` for correctness.

The invariant is:

> If the daemon has committed timeline rows for an agent, any connected client that opens or resumes that agent eventually displays every row through the daemon's current tail.

## Presence is not delivery

Client heartbeat reports presence:

- device type
- app visibility
- focused agent
- last activity time

Heartbeat is used for notification routing. It must not be used as a correctness gate for `agent_stream` delivery. A stale mobile focus heartbeat may affect whether the user gets notified; it must not make timeline rows disappear from the live stream.

## Catch-up is paged but complete

Large unbounded timeline responses can exceed relay frame limits, so catch-up uses bounded pages. Bounded does not mean partial.

When the app fetches `direction: "after"` and the daemon responds with `hasNewer: true`, the app must immediately fetch the next page from `endCursor`. The catch-up is complete only when `hasNewer: false`.

The first load of an agent without a local cursor is different: it fetches a bounded latest tail page. Older history remains user-driven by scrolling upward.

## Resume behavior

When a client resumes with a known cursor, it catches up after that cursor to completion. It does not replace the view with a latest tail page, because tail pagination can skip the middle of a long background run.

When a client resumes without a cursor, it fetches the latest tail page.

## Relevant code

- Server live stream forwarding: `packages/server/src/server/session.ts`
- App sync planning: `packages/app/src/timeline/timeline-sync-plan.ts`
- App stream/timeline reducer: `packages/app/src/timeline/session-stream-reducers.ts`
- Session wiring: `packages/app/src/contexts/session-context.tsx`
