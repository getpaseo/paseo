---
id: pas-9az6
status: closed
deps: [pas-bk3k]
links: []
created: 2026-04-29T13:08:10Z
type: task
priority: 2
assignee: Ryan Swift
parent: pas-rpes
tags: [opencode, subagents, tests]
---

# Add coverage for OpenCode subagent task lifecycle

Add focused unit tests for OpenCode task-to-subagent mapping and child-session activity summarization.

## Design

Use synthetic OpenCode message/tool parts rather than live subagent runs. Cover running, completed, failed, and aborted task states, plus child session correlation when task output includes task_id.

## Acceptance Criteria

Focused OpenCode provider/tool-mapper tests pass; tests prove task input metadata, child session id extraction, action summarization, and error preservation.
