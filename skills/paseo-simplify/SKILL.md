---
name: paseo-simplify
description: Use when a Paseo user wants findings about unnecessary complexity or duplication in a specific diff, without applying changes.
---

# Paseo simplify

Audit only. Never edit, create or delete files, stage, commit, or invoke provider-native review commands. Use Paseo children, not provider-internal delegation.

## Establish the boundary

Capture once: workspace/cwd, request, branch, HEAD, selected base SHA, `git status --porcelain=v1`, staged/unstaged changes and the exact target diff/paths. Include requested untracked content explicitly; Git diff omits it. Preserve unrelated dirty work. If the caller supplies this snapshot, reuse it. A loop may supply its current delta too; never replace the original base or expand its scope.

Call `list_profiles`. Require the exact ID `paseo-workflow-audit-economic`; read its current settings/notes. If absent, stop with: `Profile 'paseo-workflow-audit-economic' is missing. Open Settings → Plugins → paseo-workflow → Workflow profiles → Install / repair profiles.` Do not install anything or substitute another profile/provider. Unsupported enforced read-only launches also stop; report the host/profile error without weakening the policy.

## Launch recipe

Use `create_agent` with the captured `workspaceId`, a short `title`, `launchProfileId` equal to that profile ID, `writePolicy: "read_only"`, and `notifyOnFinish: true`. Materialize `provider` as the configured `provider/model`; copy `modeId`, `thinkingOptionId`, and `featureValues` into `settings.modeId`, `settings.thinkingOptionId`, and `settings.features`. Omit absent values; never guess a model.

Record one run ID, each child ID and step in the conversation. Set string-record `labels`, for example `{ "paseo.skill.run": "<run-id>", "paseo.skill.step": "simplify-1-reuse" }`. Before resuming, inspect `list_agents` and the recorded child's `get_agent_activity`; reuse an existing operation. MCP creation has no `idempotencyKey`: do not invent one. Do not replay an uncertain creation or prompt. Report `outcome_unknown` with the child/run identity for inspection. A plugin's `verification_required` remains unresolved until its evidence is checked.

For a small diff use one auditor covering all four angles. Split into up to four independent read-only auditors only when diff volume and likely benefit justify the extra cost:

| Angle          | Look for                                         |
| -------------- | ------------------------------------------------ |
| Reuse          | Existing helper or pattern replacing duplication |
| Simplification | Fewer branches or unnecessary indirection        |
| Efficiency     | Demonstrable wasted work without semantic change |
| Altitude       | Logic placed at the wrong abstraction level      |

Every `initialPrompt` includes the frozen snapshot/diff, assigned angles and this boundary: **Read only; never edit, mutate, commit or delegate. Report only evidenced simplifications with unchanged behavior.** Inspect relevant callers and existing helpers. Do not give auditors each other's conclusions.

Await finish notifications; no polling, deadline-based relaunch or permission bypass. Inspect completed responses/activity. Missing or canceled output is incomplete, not a clean audit.

## Return

Deduplicate by underlying issue. Each finding contains `file:line`, evidence, impact and the smallest behavior-preserving proposal. Report coverage, unresolved items and an explicit empty result when justified. Agent assertions and green local checks do not prove external effects.
