# Handoff execution routing

## Goal

Choose the executor model and thinking effort from the final structured plan. The choice must work
whether the plan came from the Workflow Router, the Workflow Planner, or an ordinary conversation.
Executor launch must not depend on saved agent profiles.

## Decision

Every Handoff classifies the final plan through one short, dedicated agent turn. The classifier uses
Codex `gpt-5.6-sol` with medium effort and receives the workspace intention, original request,
clarifications, exact plan, and the routing policy below. It returns strict JSON containing the
category, provider, model, effort, and a short reason.

The early Router recommendation is retained for traceability but is not authoritative. The final-plan
classification always decides the executor launch settings.

## Routing policy

| Category     | Work                                                                                           | Model          | Effort   |
| ------------ | ---------------------------------------------------------------------------------------------- | -------------- | -------- |
| `trivial`    | Documentation, copy, formatting, or an isolated mechanical edit                                | `gpt-5.6-luna` | `low`    |
| `bounded`    | A scoped bug fix or small feature with known patterns and targeted tests                       | `gpt-5.6-sol`  | `medium` |
| `diagnostic` | A difficult diagnosis or coordinated changes across several modules                            | `gpt-5.6-sol`  | `high`   |
| `complex`    | Architecture, concurrency, performance, or cross-package state changes                         | `gpt-6-astra`  | `high`   |
| `critical`   | Security, migrations, user data, production effects, irreversible actions, or high uncertainty | `gpt-6-astra`  | `xhigh`  |

Risk wins over apparent edit size. A small authentication or destructive change is `critical`.
Uncertainty raises the category; it never lowers it to save cost. The classifier may choose only a row
from this table.

## Flow

1. Handoff prepares and revalidates the exact actionable plan as it does today.
2. The workflow loads a previously persisted routing decision for this plan, if one exists.
3. Otherwise it creates one technical classifier agent in the same workspace with direct launch
   settings, sends the classification prompt, and waits for the completed turn.
4. The workflow validates the strict JSON and verifies that the provider exposes the selected model
   and effort.
5. It persists the decision before closing the source plan.
6. It creates the executor with the selected provider, model, effort, and automatic mode directly,
   sends the handoff once, and returns its agent ID.
7. The app opens the executor conversation. It never opens the classifier conversation. The workflow
   archives the classifier after reading its result.

The classifier agent uses a stable idempotency key derived from the workflow and plan call ID. The
executor keeps its existing stable handoff key. A retry after a disconnect resumes the existing
classifier or executor instead of sending either prompt twice.

## State and admission

Each recorded plan gains optional routing state: phase, classifier agent ID, and validated decision.
Optional state preserves existing plugin settings. Admission still verifies workspace ownership,
exact plan text, actionability, permission identity, and prior decisions before classification or
executor creation.

The server ignores model and effort strings supplied by the client. Only the persisted, server-validated
routing decision can configure an automatic executor.

## Failure behavior

An unavailable classifier model, unsupported selected combination, malformed result, timeout, or
definitive launch failure leaves the plan actionable and shows the error on the Handoff action. No
executor is launched and no silent fallback changes cost or capability. Retrying reuses any accepted
classifier request whose outcome is known or recoverable.

The classifier is a normal background agent because the current SDK already supports creating,
waiting for, and archiving agents. It may exist briefly in agent history, but the app never navigates
to it. A truly hidden inference job would require a new host protocol and is outside this change.

## UI

Handoff remains one action. While classification and launch run, the action is pending and duplicate
presses are disabled. Success opens the executor. Failure keeps the plan and renders a retryable error.
The previous profile dropdown is no longer part of the automatic path because routing produces direct
launch settings.

## Verification

- Unit-test every policy row, risk precedence, malformed JSON, and unsupported combinations.
- Test a Router workflow and a direct ordinary plan; both must use final-plan classification.
- Test double press, disconnect after classifier creation, reconnect after decision persistence, and
  executor prompt idempotency.
- Test visible pending and retryable failure states in the app.
- Run the changed targeted tests, dependent builds, typechecks, lint, and formatting.
- Verify the packaged desktop flow with `agent-browser` first; use the native fallback only when the
  custom `paseo://` surface is inaccessible to it.

## Limits

The initial policy supports the current Codex model family only. Add another provider by adding
validated policy rows after its models and effort options are available on the host. There is no policy
editor in this change; the table is versioned with the workflow plugin so routing behavior is
reviewable and testable.
