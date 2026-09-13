---
name: paseo-review-loop
description: Use when a Paseo user requests a final review loop for a completed change against its intent and plan, including any authorized local corrections.
---

# Paseo final review

One manager owns every write. After corrections, allow **one corrected-delta re-review**. A remaining defect ends automation, even when another fix looks cheap. Resume never replenishes this budget.

## Establish ownership

Capture once: intention, original request, approved plan/constraints, workspace/cwd, branch, selected base SHA, functional HEAD/commit IDs, original status/index and exact target diff/paths. Reuse supplied captures. Missing intent, base or ownership that changes the decision requires clarification before mutation. Preserve unrelated dirty work and staged hunks.

Call `list_profiles`; require `paseo-workflow-final-review` and the audit IDs selected below. A missing profile stops with its exact ID and **Settings → Plugins → paseo-workflow → Workflow profiles → Install / repair profiles**. No profile/provider fallback or implicit installation. An unset model needs configuration on that profile, not a guessed replacement.

Reuse the existing final-review manager. If none exists, `create_agent` with the captured `workspaceId`, `launchProfileId: "paseo-workflow-final-review"`, `writePolicy: "read_write"`, a short title and the frozen briefing as `initialPrompt`. If already that manager, continue here. Every launch uses `provider: "<configured-provider>/<configured-model>"`: a string, never an object or `settings.model`. Copy mode/effort/features into `settings.modeId`, `settings.thinkingOptionId`, `settings.features`; omit absent optional settings. Only this manager may edit, stage or commit; the coordinator never takes over its writes.

Record run/step and child IDs, using string-record `labels` such as `{ "paseo.skill.run": "<run-id>", "paseo.skill.step": "final-audit-deep" }` and `notifyOnFinish: true`. Before resuming inspect `list_agents` and recorded `get_agent_activity`; reuse existing work and await finish notifications without polling. MCP has no creation/prompt idempotency key. Never replay ambiguous launches/prompts; report `outcome_unknown` with the known IDs for inspection.

If the workflow plugin already owns this review, follow its current phase/prompt and requested JSON only. It dispatches auditors and authorizes correction/commit; do not create parallel orchestration or send competing prompts. Keep `verification_required` unresolved until its evidence/ownership problem is addressed; never bypass it with a standalone manager.

## Adversarial audit

Compare the captured intention/request/plan/base/diff, not merely style or passing tests. The manager classifies before delegation:

| Classification                                             | Required audit profiles                                         |
| ---------------------------------------------------------- | --------------------------------------------------------------- |
| SIMPLE: local, narrow change                               | `paseo-workflow-audit-economic`                                 |
| STRUCTURAL: architecture, contracts or complex logic       | `paseo-workflow-audit-deep`                                     |
| SENSITIVE: security, permissions, data or external effects | `paseo-workflow-audit-deep` and `paseo-workflow-audit-security` |

At most **two concurrent auditors**, all `writePolicy: "read_only"`. Unsupported enforcement stops the launch; never weaken it. Children cannot read the parent's conversation: include the captured intention/request/plan/base/diff in each `initialPrompt`, or point to an existing readable snapshot. Give explicit **no edits, mutations, commits or delegation**. Independent reviewers return file/line, evidence, impact, smallest fix and certainty/locality/verifiability/external-effects flags. In plugin JSON, keep relative paths in `files` and location/evidence in `summary`. Missing, canceled or incomplete responses are not a clean review.

## Correct, verify, finish

Deduplicate findings. Auto-correct only authorized, certain, local, verifiable defects without external effects. Escalate auth, secrets, payments, migrations, remote data, deletion and ambiguous intent; tests do not authorize them. Automatic final corrections also require a clean initial workspace and clean functional-commit boundary, as the plugin requires. Dirty or concurrent ownership uncertainty means `verification_required`, even with no findings.

After a correction, inspect its owned delta and run applicable targeted build/typecheck/lint/tests. Keep actual command/exit-code evidence for this correction. In plugin-managed turns, agreed validation commands must be the **final tool calls**; then wait for the host. Earlier green runs and manager prose do not satisfy its canonical current-turn evidence gate.

Recheck unchanged functional HEAD and agreed files. Have one read-only auditor re-review **only the verified corrected delta** (economic for SIMPLE, deep otherwise). A finding, changed delta or missing evidence now means `verification_required`: no second correction/re-review cycle and no automatic commit.

Only a proven, authorized correction earns a second commit. The manager stages explicit owned files/hunks, inspects `git diff --cached`, rechecks HEAD/diff and verifies the resulting commit SHA/content. Mixed staged work blocks committing. No correction means no extra commit. Never reset, push, merge, deploy or cause external effects. Report findings, checks, actual commits and unresolved limits; agent text or local tests do not prove an external operation.
