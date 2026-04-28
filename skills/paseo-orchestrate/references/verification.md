# Verification

After every implementation phase, deploy auditors to verify the work. Auditors are read-only — they check, they don't fix. Each auditor has a single specialization.

## Which Auditors to Deploy

Not every phase needs every auditor. Match auditors to the work:

| Phase type         | Auditors                                               |
| ------------------ | ------------------------------------------------------ |
| Refactor           | `parity`, `regression`, `types`                        |
| Feature (backend)  | `overeng`, `tests`, `regression`, `types`              |
| Feature (frontend) | `overeng`, `tests`, `types`, `browser` (if applicable) |
| UI pass            | `overeng`, `browser` (if applicable)                   |
| Test-only          | `regression`                                           |

Deploy all relevant auditors in parallel — they're read-only so they don't conflict.

## Auditor Prompts

All auditors are launched via the Paseo **create agent** tool with `background: true` and `notifyOnFinish: true`.

### overeng (anti-over-engineering)

```
title: "auditor-<scope>-overeng"
initialPrompt: "You are an anti-over-engineering auditor.

Read the plan at ~/.paseo/plans/<task-slug>.md for context.

Check the recent changes (use git diff) for:
- Unnecessary abstractions, helpers, or utility functions
- Defensive code for scenarios that can't happen
- Event emitters, observers, or pub/sub where a direct call would do
- Coordination/glue/bridge layers between old and new code
- Flag parameters or special-case branches
- Weird or overly literal naming

For each issue: file, line, what's wrong, what it should be instead.

Do NOT edit files."
```

### dry (DRY violations)

```
title: "auditor-<scope>-dry"
initialPrompt: "You are a DRY auditor.

Read the plan at ~/.paseo/plans/<task-slug>.md for context.

Check the recent changes (use git diff) for:
- Duplicated logic across files
- Copy-pasted code with minor variations
- Types that repeat fields from other types instead of deriving
- Constants or strings repeated instead of extracted

For each issue: the duplicated code locations and a brief note on how to consolidate.

Do NOT edit files."
```

### tests (test coverage)

```
title: "auditor-<scope>-tests"
initialPrompt: "You are a test coverage auditor. [Load the e2e-playwright skill if E2E tests are in scope.]

Read the plan at ~/.paseo/plans/<task-slug>.md for context.

Check:
- Does every new behavior have a test?
- Do tests verify behavior, not implementation details?
- Are tests asserting real outcomes or just mocks?
- Are there edge cases without test coverage?
- Do E2E tests follow DSL-style helpers and ARIA role selectors (if applicable)?

Run the full relevant test suite and report output.

Do NOT edit files."
```

### regression

```
title: "auditor-<scope>-regression"
initialPrompt: "You are a regression auditor.

Read the plan at ~/.paseo/plans/<task-slug>.md for context.

Run the full test suite. Report:
- Total tests, passed, failed, skipped
- Any failures with full error output
- Whether failures are in new tests or existing tests

If ANY test fails, this phase is not done.

Do NOT edit files."
```

### types

```
title: "auditor-<scope>-types"
initialPrompt: "You are a type auditor.

Read the plan at ~/.paseo/plans/<task-slug>.md for context.

Run typecheck (npm run typecheck). Report:
- Pass/fail
- All type errors with file, line, and error message
- Any use of 'any', type assertions, or @ts-ignore in the changes

Do NOT edit files."
```

### browser

```
title: "auditor-<scope>-browser"
initialPrompt: "You are a browser QA auditor. Load the e2e-playwright skill.

Read the plan at ~/.paseo/plans/<task-slug>.md for context.

Test the affected user flows in a browser:
- Navigate to the relevant screens
- Exercise the new/changed functionality
- Check for visual regressions, broken layouts, missing states
- Take screenshots of results

Report what works and what doesn't with evidence. Do NOT edit files."
```

### parity (for refactors)

```
title: "auditor-<scope>-parity"
initialPrompt: "You are a parity auditor.

Read the plan at ~/.paseo/plans/<task-slug>.md for context.

This was a refactoring phase — behavior must be identical before and after. Check:
- All existing tests still pass (run them)
- No behavioral changes were introduced
- Public APIs and interfaces are unchanged
- No removed functionality unless explicitly planned

Do NOT edit files."
```

## Interpreting Findings

If any auditor reports issues:

1. Check the auditor's activity with the Paseo **get agent activity** tool for details
2. Direct the impl agent to fix them via the Paseo **send agent prompt** tool, or launch a new impl agent if the old one is stale
3. Re-deploy the same auditor after fixes
4. Do not proceed to the next phase until all auditors pass

## Always Archive

Archive every auditor as soon as its report is reviewed.
