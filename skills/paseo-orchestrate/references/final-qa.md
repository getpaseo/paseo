# Final QA

After all phases are implemented, verified, and cleaned up, run one final pass across the entire change.

## Steps

### 1. Re-read the plan

```bash
cat ~/.paseo/plans/<task-slug>.md
```

Re-ground yourself in the acceptance criteria. This is what you're checking against.

### 2. Run typecheck yourself

```bash
npm run typecheck
```

Must pass. No exceptions.

### 3. Run the full test suite yourself

Run all relevant tests. Must be 100% green. No skipped tests, no "known failures."

### 4. Final review agent

One agent reviews the entire diff against the acceptance criteria. Launch via the Paseo **create agent** tool with `background: true` and `notifyOnFinish: true`:

```
title: "qa-<scope>-review"
initialPrompt: "You are a final reviewer.

Read the plan at ~/.paseo/plans/<task-slug>.md for the objective and acceptance criteria.

Review the entire git diff for this task. For each acceptance criterion, report:
- YES — met, with evidence (file, line, test that proves it)
- NO — not met, with explanation of what's missing

Do NOT edit files."
```

### 5. Final anti-over-engineering agent

```
title: "qa-<scope>-overeng"
initialPrompt: "You are a final quality auditor.

Read the plan at ~/.paseo/plans/<task-slug>.md for context.

Audit the entire git diff for this task:
- Unnecessary abstractions or helpers
- Code that's clever instead of clear
- Missing error handling at system boundaries
- Excessive error handling for internal code
- Any code that doesn't serve the acceptance criteria

Do NOT edit files."
```

### 6. Browser QA (if applicable)

If the task involves UI changes, deploy a browser QA agent:

```
title: "qa-<scope>-browser"
initialPrompt: "You are a QA engineer. Load the e2e-playwright skill.

Read the plan at ~/.paseo/plans/<task-slug>.md for context.

Test all affected user flows end-to-end in the browser. For each flow:
- What you tested
- What you expected
- What actually happened
- Screenshot evidence

Do NOT edit files."
```

## If Issues Are Found

If any final QA agent reports issues:

1. Launch an impl or refactorer agent to fix them
2. Re-run the specific QA check that failed
3. Repeat until all checks pass

Do not deliver with any failing checks.

## Always Archive

Archive all QA agents once their reports are reviewed.
