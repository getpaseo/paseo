---
id: pas-073j
status: closed
deps: [pas-8jal]
links: []
created: 2026-04-26T17:15:51Z
type: feature
priority: 2
assignee: Ryan Swift
parent: pas-1baz
tags: [cli, opencode]
---

# Add CLI command for persisted sessions

Add a CLI surface to list external provider sessions for a cwd, initially OpenCode-focused.

## Acceptance Criteria

paseo agent sessions --provider opencode --cwd . lists external OpenCode sessions with id, title, cwd, and last activity in table and JSON output.
