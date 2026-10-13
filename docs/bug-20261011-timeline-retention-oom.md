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

The daemon now retains a bounded recent window over a durable row log. Reconnect and refresh send
replacement notifications to modern clients, which fetch their own pages. Older clients keep
ordered full-history replay.

Retention limits, recovery guarantees, and accepted semantic changes live in
[timeline sync](timeline-sync.md#bounded-retention). The file layout and persistence contract live
in [data model](data-model.md#durable-timeline-rows).

## Follow-ups

No per-host heap knob was added with this fix. The separate provider-subagent store is not bounded.
The trailing assistant-run semantics of finish notifications predate this fix; changing which
message a notification shows remains a separate product decision.
