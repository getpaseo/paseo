---
name: plugin-branch-review
description: The feat/plugin-system branch's review history and the review bar it set — verify fixes, never trust them
metadata:
  type: project
---

`feat/plugin-system` (plugin system + marketplace) has been through 13 review rounds. Five of them found the _previous round's fix_ broken behind a fully green typecheck/lint/test gate.

**Why:** the stakeholder gate is "PR opens only once reviewers approve", and a green suite has repeatedly certified a live hole or a silent regression. The authoritative state lives in `.claude/handoff.md` on that branch.

**How to apply:** when reviewing anything on this branch, or any later sandbox/plugin change:

- Reproduce a claimed fix rather than reading it. Splice the implementation out (swap only the implementation file — `git stash` also reverts the test and quietly runs a smaller suite), watch the test go red, restore.
- When a fix lands in one platform file, open its twin. `sandbox.web.tsx` and `sandbox.tsx` have drifted apart every round; round 12's container-mount fix went into web only.
- iOS/Android have zero runtime evidence for this feature. Native-only code paths get scrutiny proportional to that.
- Cross-family (Codex) review is unavailable in this environment — HTTP 401 from api.openai.com. Every review here is Claude-on-Claude, which DELEGATION.md's contrarian-pairing rule does not want; say so in the report.
