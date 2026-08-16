# Timeline sync

Agent chat delivery has two paths:

1. **Live stream** — `agent_stream` WebSocket messages for immediacy. These may be delta-shaped lifecycle updates.
2. **Authoritative history** — `fetch_agent_timeline_request` for correctness. This always returns full projected timeline items, never lifecycle deltas.

The invariants are:

> A continuously subscribed client applies every committed row in order. Opening or resuming an
> agent establishes the daemon's current tail in one bounded request, with older history reachable
> through backward pagination.

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

## Gap recovery is paged but complete

Large unbounded timeline responses can exceed relay frame limits, so catch-up uses bounded pages. Bounded does not mean partial.

Page limits are projected-item targets. A tool call lifecycle is one projected item even if it spans many source sequence numbers, and assistant/reasoning chunks are merged before counting. The response carries `seqStart`, `seqEnd`, `sourceSeqRanges`, and `collapsed` so clients can advance sequence cursors without rendering delta rows.

When live delivery detects a sequence gap, the app fetches `direction: "after"`. If the daemon
responds with `hasNewer: true`, the app immediately fetches the next page from `endCursor`. Gap
recovery is complete only when `hasNewer: false`.

Initialization timeouts guard lack of catch-up progress, not the full multi-page sync. A successful page that queues the next `after` page refreshes the watchdog.

Opening or resuming an agent fetches one bounded latest tail page. Older history remains
user-driven by scrolling upward.

Reaching the history-start threshold loads one older page and preserves the visible content anchor.
Cursor progress does not trigger another page. The user must leave and return to the threshold unless
the anchored page still leaves the viewport at history start, as with short or compacted content; in
that case pagination continues as one loading operation until the page fills the viewport or history
is exhausted.

## Durable item anchors

Provider message IDs are not guaranteed for every displayed item. Paseo-generated system errors are one example. Rendered item indices are not durable either because pagination and projection can merge source rows.

Actions that address a point in chat history, such as Fork, use the daemon timeline `epoch` plus the projected item's `seqEnd`. The app carries that position on the rendered assistant item for both live and fetched history. When adjacent projected chunks merge, the merged item retains the newer chunk's position.

The daemon validates that the epoch is current and the exact source sequence still exists before slicing rows. It slices before projection so later lifecycle updates cannot leak into the selected context.

## Resume behavior

Opening, reconnecting, or revisiting after a selective-delivery coverage gap fetches the latest tail
page.
Focus alone does not mutate timeline state; the tail response is compared with the local
authoritative range first.

- The same epoch and `window.maxSeq` is an exact display no-op. The app advances synchronization
  bookkeeping without replacing timeline arrays, preserving an upward-scrolled viewport.
- When the page overlaps or is adjacent to the local end cursor, only projected items newer than
  that cursor are applied. Already-covered rows are not replayed.
- A true middle gap, epoch change, or rewind atomically replaces stale canonical history with the
  latest tail. The replacement reconciles positioned live rows beyond its coverage and unresolved
  local submissions; it never retains two discontiguous canonical ranges.

The installed tail carries `hasOlder`, so history skipped by a replacement remains reachable through
ordinary backward pagination. A backward page is accepted only when it is adjacent to the current
history start; a response requested from a pre-replacement range is stale and is discarded.

## Client replica lifetime

The host runtime owns each session replica for as long as the host remains registered. React
providers attach message handlers and UI integrations to that replica, but mounting or unmounting a
provider must not create or clear it. A provider can remount during Fast Refresh or ordinary UI
recomposition while the runtime still owns the same directory snapshot and timeline cursors.

Removing the host from the registry is the destructive boundary: it stops the runtime and clears the
session and host-scoped setup state together.

The durable replica cache persists synchronization authority only when it can store the complete
current canonical window losslessly. The stored range describes those exact items: `startSeq` drives
older pagination and `endSeq` drives forward catch-up. Restore paints the items immediately, requests
`after endSeq`, and requests `before startSeq` when the user loads older history.

The first resume request is bounded. If it reports more newer history, fetch one latest bounded tail
instead of replaying every missed page. Live gap recovery still pages forward until current.

If the canonical window exceeds the cache item limit, contains a discontiguous retained range, has a
live head, or includes presentation data the cache cannot encode losslessly, persistence drops the
range and keeps a display-only tail. Restore then uses the ordinary bounded `tail` bootstrap. Never
slice items while retaining the pre-slice range; that falsely certifies discarded source rows.

Live rows received between cache paint and catch-up stay in the separate live head and reconcile with
the authoritative range through the existing forward-page path. The cache does not persist sync
generation or unreconciled local submissions.

Every daemon-derived live item carries its timeline epoch and sequence position. Bootstrap
replacement keeps only positioned rows newer than the page it installs, while unresolved local
user presentations identify themselves by having client identity without a timeline position. This
prevents a page from duplicating rows it already covers without coupling display continuity to the
shorter-lived submission registry. Unreconciled local presentations are not persisted in the durable
replica cache.

## Selective and legacy delivery

The app chooses one delivery policy from `server_info.features.selectiveAgentTimeline`:

- Selective daemons receive every agent visible in any pane plus the most recently viewed hidden
  agents, up to five subscribed agents. Visible agents always win: if more than five are visible,
  they all remain subscribed and no hidden agent does. Switching and app backgrounding preserve
  this connection-scoped hot set, so returning to an agent still covered by it needs no catch-up.
  Losing window keyboard focus does not make a selected pane invisible. Disconnecting clears hidden
  hot agents; reconnect restores the currently visible set before authoritative catch-up. Revisiting
  an evicted retained timeline displays its cached state immediately while authoritative catch-up
  advances it to the current tail.
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

Every path that sends a message to an agent — composer send, dictation accept-and-send, queued
send-now, and the automatic queue drain in `HostRuntime` — goes through
`dispatchComposerAgentMessage` with a submission writer. There is no second transport for the same
product action: calling `client.sendAgentMessage` directly skips the submitted row and the pending
footer, and permanently drops attachments because the daemon does not echo them back.

A submitted prompt is one `UserMessageItem` row. That row is the authoritative local presentation:
its stable identity, text, timestamp, images, and attachments do not change when the provider
acknowledges it. Submission lifecycle is a separate record keyed by agent, not another row shape.
The transaction registry records two independent settlement facts: canonical acknowledgement and RPC
settlement. Canonical acknowledgement retires optimistic activity immediately. When both facts are
known, whichever arrives second deletes the record. A canonical acknowledgement that arrives first
prevents a later transport error from rolling back a prompt already observed.

The daemon's accepted response waits for the correlated run start and guarantees that the canonical
submitted row has been recorded. It publishes the accepted turn's liveness before that row, so the
client applies authoritative activity before canonical acknowledgement retires optimistic activity.
Timeline render batching does not delay lifecycle application. Directory status never settles a
submission. Overlapping sends settle independently rather than collapsing to one newest pending
message.

Daemons advertising `server_info.features.canonicalSubmittedPrompts` guarantee that every accepted
prompt carrying a client message id is recorded and streamed as a canonical `user_message` with that
same id. This includes daemon-handled commands that do not allocate a foreground turn; their submitted
row is recorded before handler output. The app tracks submission transactions only for hosts with this
capability. Older hosts keep the shipped untracked optimistic-row behavior and roll that row back on RPC
rejection.

Turn activity has one client-side replica. Lifecycle events can attach `turnId`, and agent snapshots can
expose `activeTurn: { turnId, startedAt } | null`. An identified terminal cannot close a different
identified turn; an unnamed legacy terminal can close the current turn. Snapshots, stream events,
cancellation requests, and every visible surface update the same per-agent record. The snapshot covers
both user-started foreground turns and autonomous provider turns;
foreground control ownership remains a separate daemon concern. Cancellation request identity is stored
with that record rather than in a React component, so an old request cannot clear a newer one. Submissions
remain a separate pre-turn registry and retire on canonical acknowledgement.

The compatibility boundary for older daemons is snapshot normalization: running/idle status becomes an
anonymous active turn or idle state once, and downstream code consumes the same activity shape. The app
does not combine anonymous lifecycle events, timestamps, timeline rows, and resume coverage to infer a
second running state. Disconnect and replica removal remain destructive close boundaries. Elapsed time
comes only from turn liveness, never from submission records or whichever timeline rows happen to be
mounted.

The daemon records one canonical submitted user row at acceptance. Its wire `messageId` is the
submission's `clientMessageId`, so the row is born with its final identity and remains immutable on
the wire. A correlated provider echo records the provider's native identity internally without
dispatching another timeline event. Rewind resolves the wire identity to that provider identity at
the provider boundary. Daemon-handled prompts follow the same identity rule.

Content matching is limited to the dated compatibility path for daemon timelines created before
that field existed. Canonical ingestion may match only an explicit unreconciled local candidate;
the draft-create handoff is the one boundary that also permits the legacy canonical twin to have
arrived first. Generic reducers and consumers do not reimplement message identity matching.

Ordinary bootstrap, same-epoch reset, and catch-up replacement preserve unmatched locally submitted
rows because a provider may never echo them. A known epoch change or rewind replaces history and
drops acknowledged local rows omitted by the new canonical epoch; every transaction not yet
acknowledged by the provider, and no other local row, crosses that destructive boundary. A cold
reset without an existing epoch is destructive because the client has no continuity anchor.

Tail rows are positioned history, so an unmatched local presentation is appended after the
canonical replacement rather than ordered by timestamps from different machines. The head is a
live overlay: cursorless items stay there during continuity replacement until canonical positions
arrive, while a destructive replacement retains only active submission transactions.

Canonical replacement owns both timeline lanes. A matching local row keeps its presentation ID and
payload while taking the canonical row's ordered position. If a live assistant head is the
canonical assistant prefix, it stays in the head lane. No row may be returned in both lanes.

## Relevant code

- Server live stream forwarding: `packages/server/src/server/session.ts`
- App sync planning: `packages/app/src/timeline/timeline-sync-plan.ts`
- App viewed-agent synchronization: `packages/app/src/timeline/viewed-timeline-sync.ts`
- App stream/timeline reducer: `packages/app/src/timeline/session-stream-reducers.ts`
- Session wiring: `packages/app/src/contexts/session-context.tsx`
