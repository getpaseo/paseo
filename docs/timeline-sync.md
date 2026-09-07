# Timeline sync

Agent chat delivery has two paths:

1. **Live stream** — `agent_stream` WebSocket messages for immediacy. These may be delta-shaped lifecycle updates.
2. **Authoritative history** — `fetch_agent_timeline_request` for correctness. This always returns full projected timeline items, never lifecycle deltas.

The daemon keeps canonical rows only for its runtime. Provider history is the durable transcript
authority and repopulates those rows when an agent resumes.

The invariants are:

> A continuously subscribed client applies every committed row in order. Opening or resuming an
> agent establishes the daemon's current tail in one bounded request, with older history reachable
> through backward pagination.

Tool output is bounded before it enters either delivery path. Canonical shell tool output is sliced
to 64 KiB, and the same bounded item is used for runtime timeline rows and live stream events.
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

When live delivery detects a sequence gap, the app fetches `direction: "after"` from its current
cursor and remembers the sequence the live row reached. If the daemon responds with
`hasNewer: true`, the app immediately fetches the next page from `endCursor`. A catch-up is
complete only when the daemon reports `hasNewer: false` and the accepted coverage has reached
every sequence the live stream reported while the catch-up ran: a page the daemon built before
those rows existed cannot settle them, however it was requested, so the owner continues from the
cursor that page established. One catch-up runs per agent; a gap observed while it is running
raises its obligation instead of starting another request. A non-advancing reply cannot disprove
activity observed while the request was in flight. A newly raised obligation starts the next
page immediately, without an error. A reply that makes no progress against an obligation already
known when it started retains that obligation and uses bounded error backoff. Cancellation (the agent leaves view,
the connection drops) forgets the observed head; the next catch-up starts from the cursor and the
daemon returns everything after it.

Initialization timeouts guard lack of catch-up progress, not the full multi-page sync. A successful page that queues the next `after` page refreshes the watchdog.
Response completion is independent of row admission: an obsolete tail can finish its initialization
without replacing newer accepted rows. Requests carry the existing init-promise identity, so an old
response cannot settle a replacement initialization.

Opening or resuming an agent fetches one bounded latest tail page. Older history remains
user-driven by scrolling upward.

A failed catch-up or subscription reconcile retries on its own, doubling from 1s to a 30s ceiling.
A fixed 1s retry turned a persistent daemon-side refusal — a Codex thread that already has an active
writer, say — into a request and a log line every second on an idle app. The delay resets on success,
reconnect, delivery-mode change, and visibility change, so recovery is still immediate once the
condition clears. Republishing the same visibility set is a no-op and never bypasses backoff.

Background retries are silent. The retry the user presses in the sync-error callout is a fallible
user action and owns its pending state: `retrying` is a status the sync model publishes, not a React
boolean, so the button reports in-flight and the callout returns to `error` when the attempt fails.

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
  local submissions; it never retains two discontiguous canonical ranges. A tail whose window ends
  behind the local cursor is a rewind, so it supersedes every positioned row up to that cursor
  rather than only the positions it carries; a gap replacement covers only what it carries.

The installed tail carries `hasOlder`, so history skipped by a replacement remains reachable through
ordinary backward pagination. A backward page is accepted only when it is adjacent to the current
history start; a response requested from a pre-replacement range is stale and is discarded.

## Client replica lifetime

`timeline/replica.ts` is the host-lived timeline write authority. Cache restore, pages, live batches,
submissions and removal publish atomically into the existing Zustand read projection; unchanged
facts retain their references. `viewed-timeline-sync.ts` owns demand and fetch scheduling, available
before a network client so saved history can paint offline. Matching display and verified inputs
share one reduction. Fully covered identified text adopts canonical row identity and metadata;
partial coverage preserves live rows and newer text. Persistence uses the accepted transition,
never mutable UI state.

Unpositioned live updates do not revoke known in-session source coverage or sequencing: current
daemons also emit out-of-band timeline updates. They can make the restart page display-only, which
grants no resume coverage when reopened. Display pagination remains available, and older pages
cannot certify unpositioned content. Positioned activity ahead of incomplete catch-up preserves the
preceding certified baseline. A cold overflow awaiting its latest tail still accepts live observations;
only an intentionally detached, synchronized history window excludes them.
Epoch changes invalidate old display positions; authoritative resets, including empty windows,
invalidate the old durable baseline. A delayed old-epoch cache cannot replace newer live display.

The restart window holds at most the latest40 complete entries in source-start order. Loading older
scrollback cannot populate or enlarge it, even when projection merging leaves a short page or its
certificate has been withdrawn. Retained messages can gain complete continuations; overlapping
older tool lifetimes do not pull earlier entries into the window. `startSeq` identifies the source-start
boundary for `before` pagination; `endSeq` is the independently established synchronization position
for `after`. A discarded older tool may finish last, so the latter can exceed every retained row's
completion position. `hasOlder` preserves access to omitted history.

Cache values without source provenance paint verbatim but cannot authorize resume, including after
new live activity. Canonical replacement restores certification through the ordinary bounded tail
bootstrap; no local sorting or text deduplication repairs saved rows. Disjoint retained ranges keep
the preceding certified baseline. The codec preserves complete text, source chunks and attachment
references; unreconciled local submissions and UI sync generations are not durable. Cache budgeting
and write-behind guarantees belong to [data-model.md](data-model.md#replica-row-store).

Preparation keeps one promise per agent lifetime. Host identity transfer immediately republishes
retained state; a pending read repeats only when identity changed during that read, because physical
rename may have retired its key. Settled transfers perform no storage read. Directory scope exclusion
ends the lifetime and rejects delayed work but retains the saved timeline; only explicit deletion
removes it. First admission preserves in-flight work; re-admission begins a fresh lifetime. Retained
timeline data alone does not provide offline archived-route metadata.

DirectorySync coalesces fetch and acceptance into one operation. The first resume is bounded: a reply
with more history leads to one latest tail, while live gap recovery still pages to completion. A tail
passed by activity accepted during its request is obsolete; a tail behind the request's starting
cursor demonstrates rewind. Client window-replacement intent remains separate from daemon reset.
Covered canonical positions replace matching display history, while positioned rows beyond the page
survive as an unverified overlay. Submission continuity follows the rules below.

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

A projected page is canonical state, not live deltas. Positioned rows carry their source start and
text chunk offsets so page reconciliation replaces covered text while retaining newer chunks.
Tools keep their first-appearance order even when their completion arrives later. Both display lanes
share this source order; a missing canonical unit lands at its source start.

Message identity alone does not identify a segment: tools can divide same-ID text, and markdown can
split one segment into several rows. For unpositioned text, reconcile only a uniquely matching
contiguous segment using the same markdown boundaries as live rendering. A lagging canonical prefix
leaves newer text unpositioned. Known tool positions constrain ownership; identical unpositioned
segments without a distinguishing position remain ambiguous and are preserved. Text alone never
establishes message identity. Anonymous rows retain the conservative cursor-straddle fallback.
Insertion must not merge an identified segment whose ownership reconciliation already declined.

Every path that sends a message to an agent — composer send, dictation accept-and-send, queued
send-now, and the host runtime's automatic queue drain — goes through
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

Canonical turns and visible responses are different boundaries. System-injected prompts are absent from
the Paseo timeline, so one visible response can span several canonical turns without a user message
between them. Layout and copy group that response together; lifecycle, timing, tool sequences, and exact
fork positions retain the canonical `turnId` boundaries.

The compatibility boundary for older daemons is snapshot normalization: running/idle status becomes an
anonymous active turn or idle state once, and downstream code consumes the same activity shape. The app
does not combine anonymous lifecycle events, timestamps, timeline rows, and resume coverage to infer a
second running state. Disconnect preserves the last replicated turn until cache or network hydration
advances it; replica removal remains the destructive close boundary. Elapsed time comes only from turn
liveness, never from submission records or whichever timeline rows happen to be mounted.

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
- App timeline write authority: `packages/app/src/timeline/replica.ts`
- App viewed-agent synchronization: `packages/app/src/timeline/viewed-timeline-sync.ts`
- App stream/timeline reducer: `packages/app/src/timeline/session-stream-reducers.ts`
- Session wiring: `packages/app/src/contexts/session-context.tsx`
