# #6522 — Unbounded timeline retention OOMs the daemon worker

**Fixed:** 2026-10-11, on the branch resolving [#6522](https://github.com/getpaseo/paseo/issues/6522).

## Problem

A single OpenCode session (38.8 MB of timeline, 20,319 parts, still growing) kept the daemon
worker's in-memory timeline unbounded while the provider's own history sat in a 5.6 GB
`opencode.db` on AFS. Relay flaps caused repeated reconnects, and every reconnect and refresh
replayed the full history to clients, so the worker spent its cycles re-sending megabytes of rows
while its heap kept climbing. Result: an OOM crash-loop (41 restarts) on a 2 CPU host with a
2.19 GB V8 heap; `fetch_agent_timeline` p50 reached ~45 s.

## Root cause

Two retention decisions compounded:

1. The in-memory timeline kept every canonical row for the lifetime of the daemon process. No
   byte or row cap, and provider history is not read back into memory, so nothing bounded growth.
2. Replacement delivery materialized the full timeline (`fetchTimeline` with `limit 0`) on every
   reconnect and refresh, even though modern clients only need the epoch change and then refetch
   their own pages.

## Fix

- Bounded in-memory window (16 MiB / 50,000 rows by default) over a durable append-only row log at
  `$PASEO_HOME/timeline-rows/{agentId}.jsonl`. Eviction is gated on the durable watermark, so a
  row whose disk write has not confirmed is never dropped. Mechanics:
  [timeline sync](timeline-sync.md#bounded-retention); layout:
  [data model](data-model.md#durable-timeline-rows).
- Reconnect and refresh send `agent.timeline.replacement` without materializing the timeline. Only
  pre-`timelineReplacementInvalidation` clients receive the full replay, now read through the
  durable-store merge.
- Reads the window cannot answer — full-history reads after eviction, boundary `before` pages,
  post-restart reads, fork context — backfill from the durable store. Timeline search and prompt
  listing merge the window with committed durable rows, so rows awaiting their durable write stay
  visible.
- Resuming an agent with a contiguous durable log primes the timeline from disk; the first
  hydration replays the session history for its provider-subagent events only, since the subagent
  store is not durable. A log with a gap below its top does not prime: the first hydration
  re-primes the full timeline from provider history (new epoch, rows re-committed from seq 1), and
  keeps the gapped rows when the provider no longer holds the history (implicit rebuilds only; an
  explicit rewind with an empty history is a legitimate clear).

## Accepted semantic changes

- MCP `get_agent_activity` with no `limit` returns the in-memory window, not the full history.
- Rewind and prompt enrichment that address an evicted row degrade to the `clientMessageId`
  identity match instead of matching against evicted row content.
- Deep `before`/`after` pagination and full-history reads parse the whole durable file. There is
  deliberately no resident cache; a large history pays that transient read cost on every such
  read. Bounded `tail` pages are the exception: they scan the log from the end in batches, falling
  back to the full read when the scan exceeds its cap.
- A durable write that fails all its retries stalls the watermark at its seq: the window keeps the
  row and everything after it until a later write for the agent succeeds and replays it. A
  persistent disk error therefore degrades to pre-fix retention for that agent, with the failures
  logged as errors.
- A row that dies with the process before its durable write confirms leaves either a gap in the
  log (an earlier failed write) or a contiguous log with the tail missing. The gap re-primes from
  provider history on first hydration; the contiguous case heals through the same hydration's
  seeded-log verification ([timeline sync](timeline-sync.md#bounded-retention)).

## Follow-ups

- Tuning knobs exist (`PASEO_TIMELINE_WINDOW_MAX_BYTES`, `PASEO_TIMELINE_WINDOW_MAX_ROWS`); no
  per-host heap knob was added with this fix.
- Subagent store retention is not bounded by this change.
- The last-assistant-message read (finish notifications, subagent prompt context) returns the
  trailing contiguous run of assistant text, which can span several assistant messages. That
  semantics predates the durable store and is shared by the live and post-restart paths; whether
  notifications should show only the final message is a product decision.
