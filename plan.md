# Plan

## Context

Build a new Codex MCP provider side‑by‑side with the existing Codex SDK provider. The new provider lives in `packages/server/src/server/agent/providers/codex-mcp-agent.ts` and is selected via a new provider id (e.g. `codex-mcp`). All testing is **E2E only** (no mocks/fakes). Use `/Users/moboudra/dev/voice-dev/.tmp/happy-cli/src/codex/` as reference for MCP + elicitation.

## Tasks

- [x] **Test (E2E)**: Create the full failing test file for Codex MCP provider.

  - Add a single e2e test file that covers: basic flow, event mapping parity, persistence/resume, runtime info, permissions (approve/deny), abort.
  - Ensure it fails before implementation.
  - **Done (2025-12-24 17:57)**: Expanded Codex MCP e2e tests to cover basic response, permissions allow/deny, and abort flow; updated typings and helpers.

- [x] **Implement**: `codex-mcp-agent.ts` provider so tests pass.

  - MCP stdio client + session lifecycle.
  - `codex` / `codex-reply` calls.
  - `codex/event` mapping to AgentStreamEvent.
  - Elicitation → permission requests + responses.
  - Abort/close handling.
  - **Done (2025-12-24 18:12)**: Added Codex MCP provider with stdio client, event mapping, permissions, persistence, and abort handling.

- [x] **Test (E2E)**: Run tests and add follow-up tasks based on results.

  - If failures: add fix tasks immediately after this task.
  - If passes: add next audit/review task.
  - **Done (2025-12-24 18:14)**: Ran Vitest E2E suite (`agent-mcp.e2e.test.ts`, `model-catalog.e2e.test.ts`); all tests passed.

- [x] **Review**: Audit E2E coverage and environment requirements for Codex MCP provider.

  - **Done (2025-12-24 18:18)**: Audited Codex MCP E2E coverage and env requirements; identified missing thread/item event mapping coverage, permission abort path coverage, and codex CLI env docs.

- [x] **Test (E2E)**: Add coverage for thread/item events and non-command tool-call mapping (file_change, mcp_tool_call, web_search, todo_list).

  - **Done (2025-12-24 18:24)**: Added Codex MCP E2E coverage for thread/item mapping and non-command tool calls. Tests failed locally due to Codex CLI/model/permission behavior mismatches (see test output).

- [x] **Test (E2E)**: Add coverage for permission abort path (respondToPermission interrupt) and clarify read-only/untrusted gating behavior for Codex MCP.
  - **Done (2025-12-24 18:30)**: Added Codex MCP E2E tests for read-only/untrusted permission gating and interrupt-based permission abort handling; Vitest failed locally due to missing tool version for `vitest` in `.tool-versions`.

- [x] **Test / Review (E2E + Typecheck)**: Document Codex CLI/model/permission mismatches and run typecheck.

  - Capture exact failing scenarios, including CLI flags, sandbox/approval policy, and observed vs expected behavior.
  - Review code, really bad typing and code is generally hortible quality, write a report for follow up tasks, reduce casting to a minimum, strongly typing everywhere
  - Paste key error output snippets and summarize root causes.
  - Run server typecheck and record failures; add fix tasks for each category.
  - **Done (2025-12-24 18:35)**: Documented Codex CLI model/permission mismatches in `CODEX_MCP_MISMATCH_REPORT.md`; ran focused Vitest tests (runtime info + permission gating) and captured failures; ran server typecheck and recorded TS2339/TS6133 failures in `codex-mcp-agent.ts`.

- [x] **Fix**: Handle Codex CLI model availability mismatch (gpt-4.1 rejected for ChatGPT accounts) in Codex MCP tests/provider.
  - **Done (2025-12-24 18:40)**: Added model-rejection fallback for ChatGPT accounts, track runtime model from responses, and default to a placeholder when a configured model is rejected.

- [ ] **Fix**: Investigate Codex MCP permission elicitation behavior for `approval-policy=on-request` and `untrusted` (no permission_requested events).

- [ ] **Fix**: Resolve Codex MCP provider typecheck errors (`AgentPermissionResponse.message` usage, unused locals).

- [ ] **Refactor**: Reduce casting/`unknown` usage in Codex MCP provider per type/quality report.

- [ ] **Review**: Check implementation + edge cases.

  - If issues: add fix tasks + re-review.

- [ ] **Review**: Strong type/quality review of provider + tests.

  - Identify type safety issues, missing error handling, and brittle assumptions.
  - Add fix tasks and re-review.

- [ ] **Test (E2E)**: Final verification (full scenario matrix).

  - read-only + on-request
  - read-only + deny
  - workspace-write + untrusted
  - full-access

- [ ] **Plan**: Re-audit and add any follow-up tasks.
