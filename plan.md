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

- [ ] **Review**: Audit E2E coverage and environment requirements for Codex MCP provider.

- [ ] **Review**: Check implementation + edge cases.

  - If issues: add fix tasks + re-review.

- [ ] **Test (E2E)**: Final verification (full scenario matrix).

  - read-only + on-request
  - read-only + deny
  - workspace-write + untrusted
  - full-access

- [ ] **Plan**: Re-audit and add any follow-up tasks.
