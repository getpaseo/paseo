---
id: pas-rm8c
status: open
deps: []
links: []
created: 2026-04-27T16:37:10Z
type: task
priority: 3
assignee: Ryan Swift
tags: [opencode, handoff, backlog]
---

# Backlog: improve slow OpenCode resume loading state

Resuming a closed OpenCode session in Paseo can sit on the empty "start chatting with this agent" placeholder for ~30s before the existing timeline appears. The session eventually loads, but the UX looks like an empty/new agent while daemon-side resume and persisted timeline hydration are slow.

Observed with `ses_230571c69ffeGhECMhCj55bWlq`:

- `resume_agent_request` completed after about 30s and logged `ws_slow_request`.
- OpenCode DB still contained the expected `3` user messages and `3` completed assistant messages.
- Paseo created a new idle agent record pointing at the same OpenCode session.
- Related log noise included OpenCode provider refresh timeouts and slow persisted-agent fetches.
- Manual handoff validation still succeeded after the delay, so this is a loading-state/performance backlog item rather than a correctness blocker.
- Likely improvement areas: decouple resumed-agent creation from slow provider/workspace refresh work, and render a history-loading state until authoritative timeline hydration completes.

Acceptance criteria:

- Resumed sessions should not show an empty-chat placeholder while history is still hydrating.
- The UI should show an explicit loading/history hydration state or partial skeleton.
- The resume path should avoid waiting on unrelated provider/workspace refresh work where practical.
