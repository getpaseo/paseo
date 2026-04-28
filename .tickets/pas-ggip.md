---
id: pas-ggip
status: closed
deps: []
links: []
created: 2026-04-26T17:15:51Z
type: feature
priority: 1
assignee: Ryan Swift
parent: pas-1baz
tags: [opencode, server]
---

# Discover persisted OpenCode sessions

Implement OpenCodeAgentClient.listPersistedAgents by reading OpenCode persisted sessions for a cwd/project and returning PersistedAgentDescriptor records.

## Acceptance Criteria

Given a cwd with OpenCode history, listPersistedAgents returns session id, cwd, title, last activity, persistence handle, and a small timeline. Given no history, it returns an empty list without error.
