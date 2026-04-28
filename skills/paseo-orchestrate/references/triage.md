# Triage

Triage is fast and cheap. The orchestrator does it itself — no agents. The goal is to assess complexity order, which determines how many agents to deploy at each phase.

## How to Assess

1. Read the task description
2. Grep the codebase for relevant files, types, and functions
3. Identify how many packages/modules are touched
4. Identify whether it's a new feature, refactor, bug fix, or architectural change
5. Assign a complexity order

State the order and briefly why: "Order 3 — touches server session management and the app's git status display across two packages."

## Complexity Orders

### Order 1 — Single file, single concern

A contained change: fix a bug in one function, add a field to one type, update one component.

| Phase     | Agents                        |
| --------- | ----------------------------- |
| Research  | 1 researcher                  |
| Planning  | 0 — orchestrator plans inline |
| Implement | 1 impl                        |
| Verify    | 1-2 auditors                  |
| Cleanup   | 0-1 refactorer                |

### Order 2 — Single module, few files

A feature or fix within one package that touches 3-8 files. Might involve new types, new tests, a few component changes.

| Phase     | Agents           |
| --------- | ---------------- |
| Research  | 2 researchers    |
| Planning  | 1 planner        |
| Implement | 1 impl per phase |
| Verify    | 2-3 auditors     |
| Cleanup   | 1 refactorer     |

### Order 3 — Cross-module, multiple packages

A feature that spans packages (e.g., server + app, or CLI + server). Multiple concerns, multiple file groups, likely needs interface changes between layers.

| Phase     | Agents                                                                  |
| --------- | ----------------------------------------------------------------------- |
| Research  | 3-4 researchers (one per area: backend, frontend, tests, external docs) |
| Planning  | 2 planners + 1 plan-reviewer                                            |
| Implement | 1-2 impl agents per phase                                               |
| Verify    | 3-4 auditors (overeng, tests, regression, types)                        |
| Cleanup   | 1-2 refactorers                                                         |

### Order 4 — Architectural, system-wide

A new subsystem, major refactor, or change that touches most of the codebase. New abstractions, new patterns, potentially breaking changes that need migration.

| Phase     | Agents                                              |
| --------- | --------------------------------------------------- |
| Research  | 5+ researchers across all relevant areas            |
| Planning  | 2+ planners (one per major area) + 2 plan-reviewers |
| Implement | 2+ impl agents per phase, sequenced carefully       |
| Verify    | Full auditor suite per phase                        |
| Cleanup   | 2+ refactorers with different specializations       |
