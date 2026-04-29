---
id: pas-i58o
status: closed
deps: [pas-bk3k, pas-47pd]
links: []
created: 2026-04-29T13:08:10Z
type: feature
priority: 1
assignee: Ryan Swift
parent: pas-rpes
tags: [opencode, subagents, ui]
---

# Show OpenCode subagent child activity in Paseo

Surface the child subagent's actual activity under the parent task so users can tell what is blocking or progressing.

## Design

Reuse the existing sub_agent actions/log UI first. Populate actions from child session tool parts where available: read/glob/bash/edit/search summaries, running/completed/failed state, and final result/error. Avoid a new sidebar concept until the inline timeline proves insufficient.

## Acceptance Criteria

A running OpenCode subagent shows recent child tool actions in the parent task details; completed/failed/aborted child activity updates the parent task display; mobile bottom sheet and desktop inline details both remain usable.
