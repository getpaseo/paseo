---
name: paseo-simplify-loop
description: Use when a Paseo user wants behavior-preserving simplifications applied to an existing patch and checked before final review.
---

# Paseo simplify loop

One writer, at most **five iterations**, then `paseo-review-loop`. A small remaining finding or a deadline never resets that budget.

## Prepare once

Capture intention/request/plan, workspace/cwd, branch, HEAD, selected base SHA, status, staged/unstaged changes, target paths and exact original diff. Record selected untracked contents separately. Reuse an existing capture on resume; keep original dirty hunks protected and the original base fixed. Later pass deltas do not redefine ownership. If ownership overlaps or is uncertain, stop that correction.

Call `list_profiles`; require `paseo-workflow-final-review` for the writer and `paseo-workflow-audit-economic` for simplification audits. Missing IDs stop with the exact missing ID and **Settings → Plugins → paseo-workflow → Workflow profiles → Install / repair profiles**. Never substitute profiles/providers or install them implicitly. Load `paseo-simplify` for the audit phase and `paseo-review-loop` for the final phase; if unavailable, report the missing bundled skill.

Use the existing authorized writer when present. Otherwise `create_agent` with that workspace, `launchProfileId: "paseo-workflow-final-review"`, `writePolicy: "read_write"`, a short title and the frozen briefing as `initialPrompt`. Copy the selected profile's `provider/model` into `provider`, and mode/effort/features into `settings.modeId`, `settings.thinkingOptionId`, `settings.features`; omit absent optional settings, never guess a missing model. If already that manager, continue without creating another writer. The coordinator and all auditors remain non-writing, including staging and committing.

Record run ID, iteration count and child IDs. Give launches string-record `labels` such as `{ "paseo.skill.run": "<run-id>", "paseo.skill.step": "simplify-writer" }`, and `notifyOnFinish: true`. On resume inspect `list_agents` and recorded `get_agent_activity`, reuse the existing operation, and await notifications without polling. Neither MCP creation nor prompting exposes an idempotency key: never invent one or resend ambiguous work. `outcome_unknown` requires inspection, not another writer. Preserve a plugin's `verification_required`; do not bypass its phase controls.

## Each pass

1. Count the pass before launching it. Run the `paseo-simplify` audit phase against the frozen boundary plus current owned delta. Its children use `writePolicy: "read_only"`; they never edit, commit or delegate. Unsupported read-only enforcement stops the launch. Up to four independent angles are justified only by volume/cost.
2. Deduplicate findings. Stop on no findings, no measurable progress, an uncertain/sensitive finding, or five completed iterations. Only the writer may apply certain, local simplifications with **no functional effect**. No speculative architecture work or expansion of the target diff.
3. After each changed pass, the writer runs applicable targeted build/typecheck/lint/tests and inspects the actual delta. Record exact commands, exit codes and owned hunks. A failure stops the loop: revert only a proven-owned failing hunk when safe; otherwise preserve it and report the failure. Never reset, stash or overwrite unrelated work.

## Finish and hand over

The same writer checks HEAD, current diff and index against the recorded boundary. Stage only explicit owned files/hunks (`git add -- <paths>` or `git add -p -- <path>`), inspect `git diff --cached`, and preserve pre-existing staged work. Mixed or concurrent changes block committing; never use blanket staging. Create a functional commit only if authorized and the staged delta is verified and entirely attributable.

Continue with `paseo-review-loop`, carrying the original intention/request/plan/base/diff, current delta, real commit IDs, checks, iteration count and unresolved findings. Reuse the manager; do not launch a second writer for independence. A blocked loop hands over its limits without claiming completion. Never push, merge, deploy or cause external effects. Tests and agent text prove neither a commit nor a remote operation; inspect the resulting Git state.
