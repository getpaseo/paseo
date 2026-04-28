# Implementation Phase

Deploy impl agents to execute the plan phase by phase. Each phase is independently verifiable.

## TDD — Not Optional

Every impl agent works TDD:

1. Write a failing test that defines the expected behavior
2. Make it pass
3. Refactor if needed
4. All tests green — not just new ones, the full relevant suite

If an impl agent finds a broken test, it fixes it. No "pre-existing failures." No exceptions.

## Phase Sequencing

Execute phases sequentially from the plan. Refactoring phases first, then feature phases, then UI passes.

After each phase:

1. Verify (see verification.md)
2. Fix any issues found
3. Re-verify
4. Only then proceed to the next phase

## Launching Impl Agents

Use the Paseo **create agent** tool with `background: true` and `notifyOnFinish: true`. **If in worktree mode, always set `cwd` to the worktree path.**

### How to describe the work

**Describe the problem, not the solution.** Your prompt should tell the agent:

- What's wrong or what needs to be built (the goal)
- How it currently fails (error output, test output, user-visible behavior)
- The acceptance criteria (what "done" looks like)

**Do NOT tell the agent:**

- Which specific lines to change
- What code to write
- Which functions to call or which patterns to use

The agent reads the plan and the code. It will figure out the implementation. If you're writing specific line numbers or code snippets in the prompt, you're micromanaging and it will backfire — the agent takes you literally and skips its own judgment.

Bad: "In `new-workspace.spec.ts` at line 164, change the tab assertion from `getByText('New Agent')` to `getByTestId(/workspace-tab-agent_/)`"

Good: "The new-workspace E2E test is failing. The test creates a workspace via empty submit, but then the tab assertion fails because it looks for text 'New Agent' which doesn't match the actual tab label. Here's the error output: [paste error]. Fix the test and run it to confirm it passes."

### Prompt template

```
title: "impl-<scope>-<phase>"
agentType: <resolved from providers.impl>
model: <resolved from providers.impl>
cwd: <worktree-path if worktree mode, omit otherwise>
background: true
notifyOnFinish: true
initialPrompt: "You are an implementation engineer. [Load the e2e-playwright skill if frontend/E2E work.]

Read the plan at ~/.paseo/plans/<task-slug>.md to understand the objective and your specific phase.

Do not bolt new code on top of existing code. If the existing code isn't shaped to accommodate your work, reshape it first. The goal is code that looks like this feature always existed.

Work TDD: write a failing test first, then make it pass. All tests must be green when done — not just your new ones, the full relevant suite. If you find a broken test, fix it.

<describe the problem and acceptance criteria — NOT the solution>

When done: run typecheck AND run any tests you modified or that cover your changes. Both must pass. Do NOT commit."
```

## UI Passes

UI/styling work uses a different provider (from `providers.ui` in preferences). The orchestrator launches UI agents after the functionality is verified:

```
title: "impl-<scope>-ui"
agentType: <resolved from providers.ui>
model: <resolved from providers.ui>
cwd: <worktree-path if worktree mode, omit otherwise>
background: true
notifyOnFinish: true
initialPrompt: "You are a UI engineer. [Load the e2e-playwright skill.]

Read the plan at ~/.paseo/plans/<task-slug>.md for context.

The functionality is implemented. Your job is the styling pass:
- Study existing components and styles in nearby screens
- Follow existing conventions exactly — no new patterns
- Keep design minimal and consistent with the rest of the app
- Think carefully about spacing, alignment, and visual hierarchy

<describe the specific UI work>

Run typecheck when done. Do NOT commit."
```

## Handling Blockers

If an impl agent reports a blocker:

- Do NOT ask the user (in either mode)
- Spin up a researcher to investigate
- Spin up an impl agent to fix it
- The scope of work is unlimited — touching other files, packages, or systems is fine

## Always Archive

Archive every impl agent as soon as its phase is verified.
