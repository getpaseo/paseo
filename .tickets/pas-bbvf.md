---
id: pas-bbvf
status: open
deps: []
links: []
created: 2026-04-28T14:06:42Z
type: task
priority: 2
assignee: Ryan Swift
tags: [opencode, handoff, app, backlog]
---

# Bug: resumed agent pane stays on empty placeholder until unrelated UI update

Resuming an existing OpenCode session in Paseo can leave the active agent pane showing the empty "Start chatting with this agent..." placeholder even though the daemon has already resumed the agent and fetched timeline data. Switching to another tab or starting another agent causes the original pane to redraw and show the existing timeline.

Observed during packaged desktop validation after `build:desktop`:

- User resumed `ses_23016ff4cffeBIymo1v9uJVU4L` from `/home/rswift/dev/skills`.
- Daemon logged `resume_agent_request` duration around `1410ms`, not a long backend stall.
- Runtime metrics showed `agents.total: 1`, `byLifecycle.idle: 1`, and `timelineStats.totalItems: 9`.
- `fetch_agent_timeline_request` latency was `1ms`.
- Pane remained on empty placeholder until the user tabbed elsewhere/started another agent, which forced the UI to update.

Likely area:

- Agent pane store subscriptions or history readiness flags are not invalidating the active pane after resumed-session authoritative history is applied.
- A broader layout/session update incidentally fixes the stale render.

Acceptance criteria:

- After a resumed agent's timeline is available, the active agent pane renders the timeline without requiring tab switches or unrelated UI updates.
- The empty placeholder is only shown for genuinely empty agents.
- Add a focused app/store test for a resumed agent receiving authoritative history while its pane is already mounted, if practical.
