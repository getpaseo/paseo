---
id: pas-47pd
status: closed
deps: [pas-bk3k]
links: []
created: 2026-04-29T13:08:10Z
type: feature
priority: 1
assignee: Ryan Swift
parent: pas-rpes
tags: [opencode, subagents, backend]
---

# Link OpenCode task tools to spawned child sessions

Correlate an OpenCode parent task tool call with the child session it spawned so Paseo can show where the subagent work is happening.

## Design

Investigate reliable signals from OpenCode: task output task_id for completed tasks, session parentID from session list/log/API, and timing/input correlation for running tasks. Prefer explicit API data over log parsing. Keep this best-effort and optional so old sessions still render.

## Acceptance Criteria

When OpenCode exposes the spawned child session, the parent task detail includes that session id; missing child ids do not break rendering; tests cover completed task output and best-effort missing-child behavior.
