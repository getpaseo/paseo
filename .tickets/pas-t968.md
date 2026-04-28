---
id: pas-t968
status: closed
deps: [pas-ud2l]
links: []
created: 2026-04-27T15:46:14Z
type: feature
priority: 2
assignee: Ryan Swift
tags: [opencode, handoff, cli]
---

# Add explicit OpenCode handoff CLI command

Add a CLI flow for handing an OpenCode session into Paseo from a terminal workflow, likely wrapping session discovery and resume with handoff-specific language.

## Acceptance Criteria

A command such as paseo agent handoff <session> or paseo agent resume-session clearly supports the handoff flow; errors and output explain that Paseo will manage the selected OpenCode session.
