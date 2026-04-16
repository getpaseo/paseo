# Roles

Every agent launched by the orchestrator has exactly one role. The role determines what the agent does, whether it can edit files, and how it's named.

## Naming Convention

`<role>-<scope>[-<specialization>]` in kebab-case.

- `<role>` — one of the roles below
- `<scope>` — what area of the codebase or task (e.g., `server-session`, `app-checkout`, `auth-refactor`)
- `<specialization>` — optional narrowing (e.g., `overeng`, `dry`, `tests`)

Examples: `researcher-server-session`, `planner-background-fetch`, `impl-checkout-phase1`, `auditor-checkout-overeng`, `refactorer-checkout-dry`

## Role Definitions

### researcher

Gathers information. Can explore the codebase, read files, trace dependencies, search the web, read docs, check other projects for reference implementations, run scripts to test hypotheses, read tests, run tests.

- **Edits files:** No
- **Prompt emphasis:** "Report what you find. Do not suggest solutions. Do not edit files."

### planner

Synthesizes research findings into a phased implementation plan. Identifies what existing code needs to be reshaped, defines interfaces and types, sequences phases.

- **Edits files:** No
- **Prompt emphasis:** "Think refactor-first. Design the target shape, not the steps."

### plan-reviewer

Adversarially challenges a plan. Looks for: bolted-on code vs natural fit, missing edge cases, over-engineering, under-specification, wrong phase ordering, scope creep.

- **Edits files:** No
- **Prompt emphasis:** "Challenge the plan. Find what's wrong, missing, or over-engineered. Do not suggest an alternative plan — identify problems."

### impl

Writes code. Works TDD: failing test first, then make it pass. Runs typecheck and all modified/related tests when done.

- **Edits files:** Yes
- **Prompt emphasis:** "Work TDD. Do not bolt new code on top — reshape existing code so the feature slots in naturally. Run typecheck AND run any tests you modified or that cover your changes when done. Both must pass. Do NOT commit."

### tester

Writes or fixes tests specifically. Used when test work is substantial enough to warrant a dedicated agent separate from impl.

- **Edits files:** Yes
- **Prompt emphasis:** "Write tests that verify behavior, not implementation details. Run every test you modified and confirm it passes. A test change without running the test is not done."

### auditor

Read-only verification. Each auditor has a specialization — it checks exactly one thing.

- **Edits files:** No
- **Specializations:**
  - `overeng` — unnecessary abstractions, helpers, defensive code, coordination/glue layers
  - `dry` — duplicated logic, copy-pasted code
  - `tests` — test coverage gaps, test quality, tests that assert mocks instead of behavior
  - `regression` — runs full test suite, checks for breakage
  - `types` — runs typecheck, checks type hygiene
  - `browser` — QA with browser (Maestro or Playwright)
  - `parity` — for refactors, verifies behavior is identical before/after
- **Prompt emphasis:** "Check [specialization]. Report YES/NO with evidence. Do NOT edit files."

### refactorer

Targeted cleanup. Each refactorer has a specialization.

- **Edits files:** Yes
- **Specializations:**
  - `dry` — consolidate duplicated logic
  - `dead-code` — remove unused code, unused imports, unused types
  - `naming` — fix unclear or unconventional names
- **Prompt emphasis:** "Fix [specialization] only. Do not refactor anything else. Run typecheck and tests when done. Do NOT commit."

### qa

End-to-end quality assurance. Can use browser automation, run the app, test user flows.

- **Edits files:** No
- **Prompt emphasis:** "Test the actual user experience. Report what works and what doesn't with evidence (screenshots, logs, error messages)."
