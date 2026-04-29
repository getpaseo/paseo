---
id: pas-rpes
status: closed
deps: []
links: []
created: 2026-04-29T13:08:10Z
type: epic
priority: 1
assignee: Ryan Swift
tags: [opencode, subagents, ux]
---

# OpenCode subagent UX parity

Make OpenCode subagent/task runs understandable and controllable in Paseo. OpenCode task tool calls currently appear as generic long-running tools, hiding the child session and making normal subagent stalls look like opaque hangs.

## Design

Use Paseo's existing ToolCallDetail sub_agent shape as the first integration point. Keep subagents inside the parent timeline for now rather than promoting them to sidebar agents. Treat long-running child work as normal agent activity that needs visibility, not as a separate hang-prevention feature.

## Acceptance Criteria

OpenCode task tool calls are represented as subagent activity in the parent timeline; users can see the subagent type, description, child session id when known, child actions/status, and final result/error.
