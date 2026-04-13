# Research Phase

Deploy researchers to gather information before planning. The number and focus of researchers scales with complexity order (see triage.md).

## Researcher Deployment

Each researcher gets a narrow mandate. Examples:

- **Codebase area:** "Read all files in `packages/server/src/server/session/`. Map the types, interfaces, and data flow. Report what you find."
- **Test coverage:** "Read all test files related to X. What's tested? What's not? What patterns do the tests follow?"
- **External docs:** "Search the Expo docs for Y. Find the recommended approach. Report back."
- **Reference implementation:** "Read the cmux project at ~/dev/cmux. How does it handle Z? Report the pattern."
- **Web research:** "Search for how other projects solve X. Find 2-3 reference implementations. Summarize the approaches."
- **Scripts/probing:** "Write and run a small script to test whether X behaves as expected. Report the results."

## Launching Researchers

Use the Paseo **create agent** tool with `background: true` and `notifyOnFinish: true`:

```
title: "researcher-<scope>"
agentType: <resolved from providers.research>
model: <resolved from providers.research>
background: true
notifyOnFinish: true
initialPrompt: "You are a researcher.

Read the plan at ~/.paseo/plans/<task-slug>.md for the objective.

<specific research mandate>

Include in your findings: relevant files, types, interfaces, patterns, gotchas, and anything surprising. Do NOT suggest solutions or edit files."
```

## Collecting Findings

Wait for all researchers to complete (you'll be notified). Use the Paseo **get agent activity** tool to read their findings. Synthesize into a research summary that feeds the planning phase.

If a researcher's findings raise new questions (in default mode), go back and ask the user before proceeding to planning.

## Always Archive

Archive every researcher as soon as its findings are collected.
