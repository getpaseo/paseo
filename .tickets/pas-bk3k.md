---
id: pas-bk3k
status: closed
deps: []
links: []
created: 2026-04-29T13:08:10Z
type: feature
priority: 1
assignee: Ryan Swift
parent: pas-rpes
tags: [opencode, subagents, backend]
---

# Map OpenCode task tool calls to subagent details

Teach the OpenCode adapter to recognize task tool calls with subagent_type/description input and emit ToolCallDetail type sub_agent instead of unknown raw JSON.

## Design

Extend the OpenCode tool-call detail parser for tool=task. Preserve raw input/output in metadata or unknown fallback only where necessary. Use description and subagent_type from task input; use task output/error to populate log and status-friendly details.

## Acceptance Criteria

A completed OpenCode task tool renders as a sub_agent detail; an aborted/failed OpenCode task preserves the subagent metadata and error; existing non-task tool parsing is unchanged.
