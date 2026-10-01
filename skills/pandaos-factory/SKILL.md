---
name: pandaos-factory
description: Run and track software-factory work in a PandaOS team using the company's workflow pack, acceptance evidence, and a decision trail. Use for factory pipelines and tracked team delivery.
---

# PandaOS factory work

Adapted from the working practices in [Poteto mode](https://github.com/cursor/plugins/blob/main/pstack/skills/poteto-mode/SKILL.md). This skill uses PandaOS's existing runtime. It does not require Cursor, pstack's other skills, or a second workflow engine.

## Start from the company contract

Read the repository's instructions and `.pandaos/project.json` when present. The selected workflow pack owns roles, phases, integrations, and acceptance policy. Keep company-specific rules out of the generic runtime. Do not substitute the basic software pack for the selected company's workflow.

Before starting work, state the observable outcome and evidence that will establish completion. Break a larger goal into independently verifiable items with acceptance criteria, dependencies, and file conflicts. Small tasks can stay in one agent.

A boss starts work with `team_start` and records the returned team ID. Team workers finish with `team_report`; they do not start another scheduler or spawn workers themselves. Report extra work through `needs` so the dispatcher retains ownership.

## Track the same run

Use the daemon's team state and event log. Do not create another task database or infer a completed phase from an idle agent.

```bash
pandaos team ls --json
pandaos team inspect <team-id> --json
pandaos team events <team-id> --after <commit> --json
pandaos team message <team-id> "Clarified acceptance criterion"
```

Use the same `--host` for all commands when targeting another daemon. `inspect` returns the snapshot's commit cursor. `events --after` reads once; prefer completion notifications over polling. The MCP equivalents for a boss are `team_status` and `team_message`.

## Leave evidence and a decision trail

Keep each item small enough to verify before continuing. Fix the shared cause rather than duplicating patches across callers. Reuse existing tools and patterns before adding another abstraction.

Do not add explanatory code comments. Remove them from code you edit and put necessary rationale in the report or owning documentation. Preserve required license notices and tool directives.

Attach the tested commit, runnable checks, screenshots for UI scenarios, and artifact references to `team_report`. Connect every acceptance criterion to its evidence. If a reviewer edits code, verify the resulting commit again before acceptance. A green check on an earlier commit does not verify the final change.

Put consequential choices and their reasons in the report summary. Label conclusions as verified, inferred, or unconfirmed. Record corrections in the company's existing logbook when one is configured. Do not silently edit workflow rules or verification checks to make an item pass.

Company approval gates still apply. Neither this skill nor a successful agent report authorizes a merge, deployment, or expansion of credentials.
