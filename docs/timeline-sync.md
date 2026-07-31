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

Opening, reconnecting, or revisiting after selective-delivery grace fetches the latest tail page.
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

The durable replica cache is a display cache, not a synchronization checkpoint. Its timeline record
contains only the focused `agentId` and a truncated item tail. It never persists a cursor, epoch,
older-history availability, authority status, or sync generation because those facts would describe
the complete source dataset rather than the truncated display dataset.

Restoring that cache produces a painted timeline: the items may render immediately, but the first
daemon timeline request is still `tail`. A successful tail response atomically establishes canonical
items, range, and older-history availability. Live rows received between cache paint and that tail
response stay in the separate live head, do not advance a cursor or trigger gap recovery, and are
reconciled with the authoritative tail and subsequent catch-up.

Every daemon-derived live item carries its timeline epoch and sequence position. Bootstrap
replacement keeps only positioned rows newer than the page it installs, while unresolved local
user presentations identify themselves by having client identity without provider identity or a
timeline position. This prevents a page from duplicating rows it already covers without coupling
display continuity to the shorter-lived submission registry. Unreconciled local presentations are
not persisted in the durable replica cache.

## Selective and legacy delivery

The app chooses one delivery policy from `server_info.features.selectiveAgentTimeline`:

- Selective daemons receive the union of agents visible in every pane. Additions subscribe and
  catch up immediately. Every visibility-driven removal, including app backgrounding, stays
  subscribed for a 30-second grace period so brief tab, pane, route, and app switches do not repeatedly
  unsubscribe and catch up. Losing window keyboard focus does not make a selected pane invisible.
  Disconnecting and disposal clear pending grace because the subscription itself no longer exists.
  After grace has expired, revisiting a retained timeline displays its cached state immediately and
  authoritative catch-up advances it to the current tail.
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
The transaction registry records RPC acceptance and provider acknowledgement independently for
agent-scoped sends. Provider acknowledgement exists solely so a later transport error cannot roll
back a prompt already observed canonically; it does not own whether the local presentation remains
visible.

The daemon's accepted response already waits for the correlated run start, but its response and the
canonical submitted row reach client state independently and may arrive in either order. The
transaction therefore records RPC acceptance and provider acknowledgement as separate phases. RPC
acceptance marks the record accepted unless provider acknowledgement already arrived; canonical
acknowledgement marks the record acknowledged unless RPC acceptance already arrived. Only the second
authority removes the transaction. Directory status never settles a submission. Overlapping sends
settle independently rather than collapsing to one newest pending message.

Daemons advertising `server_info.features.canonicalSubmittedPrompts` guarantee that every accepted
prompt carrying a client message id is recorded and streamed as a canonical `user_message` with that
same id. This includes daemon-handled commands that do not allocate a foreground turn; their submitted
row is recorded before handler output. The app creates two-phase submission records only for hosts with
this capability. Older hosts keep the shipped untracked optimistic-row behavior and roll that row back
on RPC rejection.

Turn liveness is the union of an unsettled submission and an open stream turn. `turn_started` opens the
turn; ordered `turn_completed`, `turn_failed`, and `turn_canceled` events close it. A running directory
transition may seed or raise an open turn during hydration or after a selective stream subscription
lapses, but directory status never closes one or settles a submission. Disconnect and replica removal
are the other destructive close boundaries.

Canonical submitted user rows carry the provider's `messageId` and Paseo's optional
`clientMessageId`. The user-message producer reconciles them by `clientMessageId`, adds provider
identity to the existing row, and keeps the local presentation in its original timeline slot.
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
