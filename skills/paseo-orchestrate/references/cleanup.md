# Cleanup

After all implementation phases are verified, deploy refactorer agents for targeted cleanup. Each refactorer has a single specialization.

## When to Clean Up

Run cleanup after all feature work is done and verified — not between phases. Cleanup is a sweep across the entire diff.

## Refactorer Prompts

All refactorers are launched via the Paseo **create agent** tool with `background: true` and `notifyOnFinish: true`.

### dry (consolidate duplication)

```
title: "refactorer-<scope>-dry"
initialPrompt: "You are a cleanup engineer specializing in DRY.

Read the plan at ~/.paseo/plans/<task-slug>.md for context.

Look at the full diff of changes in this task (use git diff). Consolidate:
- Duplicated logic — extract shared functions or reuse existing ones
- Repeated types — derive with Pick, Omit, or extend instead of redefining
- Repeated constants or strings — extract to a single source

Only fix genuine duplication. Three similar lines is fine — don't create premature abstractions. Run typecheck and tests when done.

Do NOT commit."
```

### dead-code (remove unused code)

```
title: "refactorer-<scope>-dead-code"
initialPrompt: "You are a cleanup engineer specializing in dead code.

Read the plan at ~/.paseo/plans/<task-slug>.md for context.

Look at the full diff of changes (use git diff). Remove:
- Unused imports
- Unused variables, functions, or types introduced by this task
- Commented-out code
- Backwards-compatibility shims or renamed _vars that serve no purpose

Do NOT remove code that predates this task unless it was made dead by this task's changes. Run typecheck and tests when done.

Do NOT commit."
```

### naming (fix unclear names)

```
title: "refactorer-<scope>-naming"
initialPrompt: "You are a cleanup engineer specializing in naming.

Read the plan at ~/.paseo/plans/<task-slug>.md for context.

Look at all new names introduced by this task (functions, variables, types, files). Fix:
- Overly literal or verbose names (e.g., handleOnClickButtonSubmit -> submitForm)
- Inconsistent naming relative to surrounding code conventions
- Unclear abbreviations
- Names that describe implementation instead of intent

Only rename things introduced or modified by this task. Run typecheck and tests when done.

Do NOT commit."
```

## Deploy in Parallel

All refactorers read the same diff but touch different concerns, so they can run in parallel. If they happen to conflict on the same lines, the orchestrator resolves by running one after the other.

## Verify After Cleanup

After cleanup, run a regression auditor to confirm nothing broke. The cleanup should be behavior-preserving.

## Always Archive

Archive every refactorer as soon as verified.
