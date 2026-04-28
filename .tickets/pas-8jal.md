---
id: pas-8jal
status: closed
deps: [pas-ggip]
links: []
created: 2026-04-26T17:15:51Z
type: feature
priority: 1
assignee: Ryan Swift
parent: pas-1baz
tags: [server, api]
---

# Expose persisted sessions over daemon API

Add backward-compatible WS/client support for listing provider persisted sessions filtered by provider and cwd.

## Acceptance Criteria

A daemon client can request persisted OpenCode sessions for the current cwd. Existing clients continue to parse messages because new fields are optional/additive.
