# Per-chat companion stream

The managed-agent panel offers **Chat / Stream / Find in chat**. Stream is a quiet review surface
for the current conversation. The compact workspace tab menu also offers **View stream**.
The internal `artifacts` view identifier is retained so existing client-local tab actions keep working.

The design borrows OpenChat's chat-scoped Thoughts idea: keep questions and useful context alongside
the conversation, with an obvious way back to it. V1 automatically captures moments; it does not
add manual notes, message pinning, model-generated summaries, or another agent execution loop.

## Contents and meaning

- Structured question and permission events appear immediately. Plan approvals are decision cards.
  A provider resolution marks the request accepted or declined. Failed/interrupted turns and session
  recreation expire requests that can no longer be answered. Reading Stream never answers a request.
- The final contiguous assistant response at a terminal turn becomes a review card. Intermediate tool
  narration, tool logs, and reasoning do not become cards. A final prose response ending in a question
  mark becomes a question card (code spans, fenced code, and URLs are excluded from this heuristic).
  A subsequent user message labels a prose question **Reply sent**, not “resolved”. Structured
  questions stay pending until the provider resolves them.
- Completed, failed, and canceled turns have distinct outcome cards. **Turn ended** is a lifecycle
  fact, not certification that the requested task succeeded. Failure/interruption includes the reason.
- Existing file artifacts retain their cards, previews, and workspace-file open behavior. They still
  represent the latest collected version of each path, not an immutable file history.

Cards interleave by timestamp, newest first. **Needs a reply** filters unresolved questions and
requests without changing the chat. **Read** expands text in place. **Reply in chat** returns to
Chat's current bottom and its existing permission/composer controls; **Back to chat** preserves
its reading position. The mounted chat and composer survive view switches. New entries do not
switch tabs, focus the composer, prompt for approval, or add notification behavior.

## Data and compatibility

`packages/protocol/src/companion-stream.ts` owns the structural wire schema. The optional
`companionEntries` agent snapshot field is persisted with the ordinary agent record. The server
collector in `packages/server/src/server/agent/companion-stream.ts` sees accepted live events after
coalescing; provider history replay does not invent past turn outcomes or pending decisions.

Capture starts after upgrading the host. V1 retains the most recent 50 moments with at most 4,000
characters per entry. Longer content is explicitly marked as an excerpt; full context remains in
Chat. The bounded snapshot is independent of how much chat history the phone has paged in.
It survives reconnects and host reloads; an unfinished final response is not yet a captured moment.

`server_info.features.companionStream` gates the new feature once in the panel. Older hosts show an
upgrade message while preserving their existing file-artifact view. The client does not reconstruct
an approximate stream from legacy RPCs. Cached cards remain reviewable while disconnected, with a
notice that pending statuses may be stale.

## Verification

Focused tests cover collection/deduplication, split response chunks, agent isolation, question and
permission transitions, interruption, response bounds, coalescer integration, stored/wire snapshot
round-trips, old snapshot compatibility, file/moment ordering, pending filtering, and locale parity.

For a prepared isolated phone build, verify the following without relaunching a shared app:

1. Open a managed chat in compact layout; Chat, Stream and Find remain visible and tappable at large
   text sizes. Stream is also available from the workspace tab menu.
2. Leave a composer draft, scroll up in Chat, open Stream, expand a response and return. The draft
   and reading position remain. New incoming cards do not navigate or submit a response.
3. Trigger a structured question or plan approval. It appears under Needs a reply. Reply in chat
   reaches the existing controls; accepting/declining updates the same card rather than duplicating it.
4. Finish, fail, or interrupt a turn; review the distinct outcome and generated file cards. Open a
   Markdown/image artifact and return through the existing workspace navigation.
5. Disconnect and reconnect. Cached cards remain visible; reconnection refreshes status. Reopen the
   conversation and verify saved moments. An older host shows its upgrade message and file artifacts.

Provider-owned child timelines remain separate read-only panels, as before.
