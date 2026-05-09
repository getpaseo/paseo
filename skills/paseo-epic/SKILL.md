---
name: paseo-epic
description: Heavy-ceremony orchestration for big work — research, planning, adversarial review, phased implementation, audit, delivery. Use when the user says "epic", "long task", "build this end to end", or wants a feature that runs all night.
user-invocable: true
argument-hint: "[--autopilot] [--worktree] <task>"
---

# Paseo Epic

Heavy-ceremony orchestrator. Runs research → plan → implement → deliver as one resumable flow. The plan file at `~/.paseo/plans/<slug>.md` is the source of truth and survives compaction.

This usually runs for hours, often overnight. By the time agents are working, you cannot re-litigate intent with the user. Capture the requirements they have already given you in conversation — behaviors, the "why," UX rules, constraints — and write them into the plan as immutable before any planning agent spins up. Everything downstream (planner, adversarial reviewer, implementers) optimizes around those requirements; it does not relitigate them.

**User's request:** $ARGUMENTS

## Prerequisites

Read the **paseo** skill — it carries the surface (worktrees, agents, waiting, scheduling, preferences). Every agent you spawn reads it too.

The role and phase-type vocabulary lives in the roles reference shipped with this skill (`references/roles.md`).

## Modes

- **Default**: conversational. Grills, gates between phases, ask before deliver.
- `--autopilot`: no grills, no gates, run through deliver. For all-night work.
- `--worktree`: isolate the work in a new worktree.

## Hard rules

- **The plan file is the source of truth.** Re-read before every phase.
- **You are the only writer to the plan file.** Agents don't touch it.
- **Requirements are immutable.** What the user has stated about behavior, UX, "why it works this way," and acceptance criteria goes into the plan's Requirements block before any planner runs and does not change after. The technical plan (phases, ordering, approach) flexes around them. Planner and reviewer challenge HOW, never WHAT or WHY.
- **The epic is not done until every Requirement is met.** The plan ends with a lightweight check that audits every bullet in the Requirements block against the delivered code. If anything is unmet, the orchestrator loops back and fixes it before deliver — under `--autopilot` too.
- **Provider for every agent comes from orchestration preferences** — match the role's category.
- **Worktrees only via Paseo.** Never run `git worktree add` yourself.
- **Agents do not commit.** Delivery happens in the deliver phase.
- **Describe problems, not solutions.** Tell agents what's broken or needed; let them decide how. No specific line numbers or code snippets in prompts.
- **One agent per phase.** If a phase needs two, the planner split it wrong.
- **Don't poll agents.** Wait for them properly.

## Flow

```
Preferences → [Worktree] → Research → Capture intent → [Grill] → Plan → Adversarial review → [Confirm] → Implement → Deliver
onboard if                            always           ^^^^^^^                               ^^^^^^^^^
missing                                                default mode                          default mode
```

---

## 0. Preferences (pre-start)

Read `~/.paseo/orchestration-preferences.json`. /epic dispatches across these provider categories:

- `planning` — drafts and reviews the technical plan
- `research` — surveys the code before planning
- `impl` — writes code (refactor, implement)
- `ui` — implements styling/layout passes
- `audit` — read-only verification, including the final lightweight requirements check

If the file is missing or any of these categories is unset, walk the user through it once. Use `list_providers` and `list_models` to surface candidates, explain each category in one line, and use `AskUserQuestion` to collect a provider per category. Persist their choices straight to `~/.paseo/orchestration-preferences.json`.

Do not proceed past this step until every category /epic will use is set. This applies under `--autopilot` too — autopilot cannot start without known providers.

If the file is complete, say nothing and continue.

---

## 1. Research yourself

Read the code first. Grep the relevant area, read 2–4 key files, understand the current shape.

For ≥3 packages or architectural change, spawn one or two **researcher** agents — each scoped to one area. Provider from the `research` preference. Tell each researcher to read the roles reference for its mandate, read the area you've assigned, and report files / types / patterns / gotchas. No solutions. No edits.

State your own understanding to the user in 2–3 sentences.

## 2. Worktree (if `--worktree`)

Create a worktree via Paseo. Record the returned path and branch — they go into the plan frontmatter.

## 3. Capture intent (always)

Before any planning agent runs, distill what the user has already told you into a concrete Requirements list. This step runs even under `--autopilot` — it is the floor that grilling extends, not replaces.

Pull from the conversation that led to this skill being invoked: described behaviors, UX rules, the "why this works this way," constraints, what must not change, what the user explicitly accepted or rejected, and the **acceptance criteria** (concrete, testable conditions that say "the work is done"). Write each as a short imperative bullet. Lean inclusive — if the user mentioned it as a behavior, constraint, or success condition, it goes in.

Drop these bullets straight into the plan's `## Requirements (immutable)` block when you write the file in step 6. They become the input every downstream agent reads as fixed, and the bar the final check audits against.

If the user has only given product/UX requirements and no technical direction, that is fine. Capture the product requirements and acceptance criteria as immutable. The technical plan is what the planner gets to design and the reviewer gets to challenge.

## 4. Grill (unless `--autopilot`)

Use `AskUserQuestion`. One at a time, recommended option stated, branches resolved depth-first. Never ask code-answerable questions. Every 3–4 questions, summarize resolved decisions.

Anything the user resolves here becomes a Requirement and gets added to the immutable block.

Stop when branches are resolved or the user says "go".

## 5. Plan with adversarial review

### Spawn a planner

Persistent — keep iterating, do not archive after the first response. Provider from the `planning` preference.

Prompt it to:

- Read the roles reference for vocabulary.
- Take the Objective and the Requirements (immutable) block as fixed input. The technical plan optimizes around them; it does not redesign them. If a requirement looks wrong, flag it in chat — do not silently work around it.
- Think refactor-first: if existing code doesn't accommodate the change, plan the reshape before the feature. Phases like "wire up", "glue", "integrate" usually mean an upstream refactor was missed.
- Reply terse, one line per phase, in chat — not to disk.

### Challenge it

Send follow-ups. Push on edge cases, alternative orderings, smallest shippable slice, bolt-on phases that should be a refactor instead. Keep the challenge on HOW — phases, ordering, technical approach. The Requirements block is not on the table here. Iterate until the plan is sharp.

### Spawn a plan-reviewer

Provider from the `planning` preference. Prompt it to:

- Read the roles reference.
- Read the planner's draft and the Requirements block.
- Challenge the technical plan: bolt-ons, missing edge cases, over-engineering, wrong ordering, hidden dependencies. Push for alternatives. Force tradeoffs.
- Treat the Requirements block as fixed. If a requirement seems off, surface it as a flag for the orchestrator — do not propose an alternative plan that quietly drops or weakens it.

### Surface tradeoffs to the user

Never present raw planner output. Surface the choice:

> Planner wants A → B → C (working slice fastest, defers refactor).
> Reviewer argued for B → A → C (refactor first, slower but cleaner).
> Which?

Use `AskUserQuestion`. Iterate the planner if the user picks differently.

Archive the planner and plan-reviewer once the plan is locked.

## 6. Write the plan

Persist to `~/.paseo/plans/<slug>.md`:

```markdown
---
task: <slug>
status: not-started
worktree: <abs path or null>
branch: <branch or null>
pr: null
created: <ISO>
updated: <ISO>
---

# <Title>

## Objective

<one paragraph>

## Requirements (immutable)

What the user has stated. Behaviors, UX rules, the "why," constraints,
and acceptance criteria (testable conditions for "done").
Captured in step 3 (and extended by the grill in step 4).
This block does not change during planning, review, or implementation.
The final check before deliver audits every bullet here.

- <bullet>
- <bullet>

## Notes

- <ISO> orchestrator: <freeform>

## Phases

- [ ] **Phase 1** · <type> · <short name>
      Acceptance: <one line>

- [ ] **Phase N** · verify · requirements + acceptance audit
- [ ] **Phase N+1** · gate · user smoke test
- [ ] **Phase N+2** · deliver · <commit | PR + merge | cherry-pick>
```

Phase types: `refactor`, `implement`, `verify`, `gate`, `deliver`. Verify variants written inline: `verify · unslop`, `verify · qa`, `verify · spec`, `verify · review`. See the roles reference.

Status markers: `[ ]` not started, `[~]` in progress, `[x]` done, `[!]` blocked.

## 7. Confirm (default mode)

Show the phase list (not the file contents — they'll read it). 2–3 sentences. Wait.

If `--autopilot`: skip.

---

## 8. Implement

Loop: find next undone phase → mark `[~]` → dispatch by type → wait → verify → mark `[x]` → repeat.

Stop when: a `gate` phase is reached, all phases `[x]`, or a phase is `[!]` blocked and you can't unblock it.

### Dispatch by phase type

#### refactor

Spawn a refactorer. Provider from `impl` (or `ui` for styling-only reshapes). cwd = the worktree path if set. Tell it to:

- Read the roles reference and load the skills it names.
- Read the plan file, including the Requirements (immutable) block. Scope is Phase N; acceptance is pinned there.
- Reshape, not feature: behavior identical before and after. Existing tests stay green. Add a parity test if missing.
- When done: typecheck pass + relevant tests green. Do not commit. Do not update the plan.

#### implement

Spawn an impl agent. Provider from `impl` (or `ui` for styling-only). cwd = the worktree path if set. Tell it to:

- Read the roles reference and load the skills it names.
- Read the plan file, including the Requirements (immutable) block. Scope is Phase N. Requirements are constraints, not suggestions — implement to them.
- Read any plan-relevant repo docs by path.
- TDD: failing test first, then make it pass.
- If the existing shape doesn't accommodate the change, push back instead of bolting on — a refactor phase should have come first.
- When done: typecheck + every test it touched green. Do not commit. Do not update the plan.

#### verify

Spawn an auditor matching the variant after `verify ·`. Provider from `audit`. The roles reference's variant table tells the auditor what to load and what to output. Read-only — no edits.

#### gate

No agent. Yield to the user.

1. Mark this phase `[x]`.
2. Compose handoff: worktree path (if set), what to test (next phase's acceptance, or this phase's Notes), how to resume (`/epic <slug>` once satisfied, or edit the plan first).
3. Exit cleanly. Don't launch the next phase. Don't poll.

#### deliver

Inline — see Section 9.

### Verifying agent output

For `refactor` and `implement`:

1. Read the agent's final activity.
2. Confirm acceptance: typecheck + tests green, what was touched matches the phase.
3. Wrong → send a follow-up to the same agent. Don't launch a new one for course-corrections.
4. OK → archive.

For `verify`:

- Green → mark the audited phase `[x]`, advance.
- Issues → append findings to Notes. Do not mark the phase done. Either send the impl agent the findings as new acceptance, or surface to the user if ambiguous.

### When the user interjects

- Feedback on a running agent → forward to it.
- Plan change → edit the plan file (add/remove/reorder), tell them what changed, continue.
- "Stop" / "kill" → archive running agents, summarize state, wait.
- New question → answer briefly, continue.

The plan file lets a fresh orchestrator pick up if the user kills you and reinvokes — write everything important to Notes immediately.

---

## 9. Deliver

Read frontmatter to choose mode:

```
worktree: null   → Mode A: main commit
worktree: <path> → Mode B (PR) or Mode C (cherry-pick); ask if not specified
```

Never push to main directly. Never force-push without explicit permission. Never merge before CI is green. Archive worktrees via Paseo, never `git worktree remove`.

### Mode A — main commit

1. `git status` — confirm related changes.
2. `git diff` — review.
3. Draft a commit message: title <70 chars imperative; body 1–3 sentences why; match repo style (`git log --oneline -20`).
4. `git add <specific files>` — never `-A` or `.`.
5. `git commit -m "..."` (HEREDOC).
6. Update plan: `status: delivered`. Append a Notes line.
7. Tell user: hash + summary. Ask about push.

### Mode B — worktree → PR + merge

1. **Commit cleanly in the worktree.** One tidy commit per logical change. Match repo style.
2. **Rebase if behind main.** Spawn an agent that loads the rebase skill. Provider from `impl`. Tell it to rebase onto origin/main, resolve conflicts by intent (never blanket-accept one side), confirm typecheck and tests still pass, do not push.
3. **Push the branch** — `git -C <worktree> push -u origin <branch-from-frontmatter>`.
4. **Open the PR** — `gh pr create` with summary from plan Objective + Phases and test plan from acceptance lines. Capture URL → frontmatter `pr:`. Status → `pr-open`.
5. **Monitor CI.** Either watch directly (`gh pr checks <n> --watch`), or spawn a fix-build agent that loads the fix-build skill. Provider from `impl`. Tell it to drive the PR to green: when checks fail, read failure logs, fix, push, repeat. Don't merge — your call.
   When green: append Notes, frontmatter `status: ready-to-merge`.
6. **Merge** when green — ask the user (`AskUserQuestion`: squash / rebase / merge / wait). Read repo convention from recent merged PRs (`gh pr list --state merged -L 5 --json mergeCommit,title`).
   ```bash
   gh pr merge <n> --squash --delete-branch
   ```
7. **Archive the worktree** via Paseo. Frontmatter: `status: delivered`, `worktree: null`. Append a Notes line.

### Mode C — worktree → cherry-pick

1. Commit cleanly in the worktree (single clean commit per logical change).
2. From the main checkout (don't `cd`): `git cherry-pick <sha>`. For multiple: `git cherry-pick <oldest>..<newest>`.
3. Conflicts → stop, tell the user. Don't auto-resolve.
4. Archive the worktree via Paseo. Frontmatter: `status: delivered`, `worktree: null`. Ask about push.

---

## Resumability

The user can interrupt or kill at any phase. New invocation:

1. Find the plan by slug (or most recently updated).
2. Read frontmatter `status` and the first non-done phase.
3. Resume from the matching phase.

Mid-deliver resumption:

- `status: pr-open` + `pr: <url>` → resume CI monitoring.
- `status: ready-to-merge` → ask the user to merge again.
- `status: delivered` + `worktree: <path>` → worktree wasn't archived, do that.

## Failure modes

- Skipping capture-intent because grilling was skipped. The Requirements block is the floor; grilling extends it.
- Letting adversarial review erode requirements the user already locked. Reviewer sharpens the technical plan; it does not relitigate intent.
- Treating phases as a checklist to grind through. They're gates. Verify before advancing.
- Forgetting to set the agent's cwd to the worktree path in worktree mode.
- Re-explaining the plan to the user. They wrote it with you. Reference phases by number.
- Polling agents instead of waiting properly.
- Editing code yourself. You orchestrate. Agents implement.
- Marking `status: delivered` before the worktree is actually archived.
- Pushing to main directly.
