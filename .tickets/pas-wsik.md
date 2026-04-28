---
id: pas-wsik
status: closed
deps: [pas-ud2l]
links: []
created: 2026-04-27T15:46:14Z
type: feature
priority: 1
assignee: Ryan Swift
tags: [opencode, handoff, server]
---

# Make resumed OpenCode session close non-destructive

Ensure Paseo does not abort, archive, or otherwise mutate upstream OpenCode sessions on normal UI close when the session was resumed from an external OpenCode handle and no Paseo turn is active.

## Acceptance Criteria

Closing a resumed external OpenCode agent in Paseo removes/stops only Paseo management state unless a Paseo turn is active; active turns still cancel safely; tests cover idle external close behavior.
