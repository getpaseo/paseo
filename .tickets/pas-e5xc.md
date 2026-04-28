---
id: pas-e5xc
status: closed
deps: [pas-8jal]
links: []
created: 2026-04-26T17:15:51Z
type: feature
priority: 2
assignee: Ryan Swift
parent: pas-1baz
tags: [opencode, server, cli]
---

# Resume OpenCode persisted session in Paseo

Allow selecting an OpenCode persisted session and creating a Paseo-managed agent from its persistence handle.

## Acceptance Criteria

Given a listed OpenCode session id, Paseo can resume it into a managed agent record and subsequent paseo send/attach flows work from that point forward.
