---
id: pas-5rsk
status: closed
deps: [pas-ud2l]
links: []
created: 2026-04-27T15:46:14Z
type: feature
priority: 2
assignee: Ryan Swift
tags: [opencode, handoff, safety]
---

# Warn before resuming recently active OpenCode sessions

Detect or approximate recently active OpenCode sessions and warn before Paseo resumes them, because simultaneous terminal and Paseo control can create queued placeholder messages or abort contention.

## Acceptance Criteria

Recently updated sessions are labeled or warned in CLI/UI; users can still explicitly resume; warning copy explains terminal OpenCode should be idle before handoff.
