---
id: pas-ud2l
status: closed
deps: []
links: []
created: 2026-04-27T15:46:14Z
type: task
priority: 1
assignee: Ryan Swift
tags: [opencode, handoff, paseo-local]
---

# OpenCode live handoff ownership model

Define the safe ownership model for handing a live OpenCode session between terminal OpenCode and Paseo without corrupting state or losing context.

## Acceptance Criteria

Documents the allowed state transitions; clarifies when terminal OpenCode must be idle; identifies which Paseo close/archive/abort actions are safe for externally resumed sessions.

## Decision

MVP handoff is explicit single-owner handoff, not simultaneous live control.

The user is comfortable remembering to quit the terminal OpenCode session first, for example with `/q`, before resuming the same OpenCode session in Paseo. Paseo does not need to safely coordinate two active clients controlling the same OpenCode session for this iteration.

## Allowed State Transitions

1. Terminal OpenCode owns the session while the laptop workflow is active.
2. User explicitly quits/detaches terminal OpenCode before handoff.
3. Paseo discovers the persisted OpenCode session by project/cwd.
4. User resumes the session into Paseo.
5. Paseo owns turns for that session while the mobile/desktop Paseo workflow is active.
6. If the user wants to return to terminal OpenCode, they should stop/close the Paseo-managed view first, then resume/continue from terminal.

## Safety Rules

- Paseo should avoid aborting or archiving upstream OpenCode state when closing an externally resumed session that has no active Paseo turn.
- If a Paseo turn is active, cancel/interrupt should still abort that active turn.
- Normal UI close should remove Paseo management state without mutating the underlying OpenCode session.
- Resume flows should use handoff language that reminds the user to quit the terminal OpenCode session first.
- Recently active sessions can be warned about, but the MVP can rely on explicit user discipline rather than hard locking.

## Non-Goals

- Detecting every currently attached OpenCode terminal client.
- Supporting simultaneous terminal and Paseo turns against the same OpenCode session.
- Implementing distributed locking across OpenCode clients.
