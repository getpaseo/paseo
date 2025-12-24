# Plan

## Context

We need a **new parallel Codex MCP provider** that lives side‑by‑side with the existing Codex SDK provider in `packages/server/src/server/agent/providers/codex-agent.ts`. The new provider should be implemented as `packages/server/src/server/agent/providers/codex-mcp-agent.ts` and selected via a new provider id (e.g. `codex-mcp`). It must use Codex MCP (elicitation-based permissions), not the SDK JSON stream. It must support the same capabilities (streaming events, permissions, session lifecycle, cancellation/abort, persistence metadata) without breaking the existing provider. Work must be TDD with full e2e verification against real Codex agents in multiple modes. **All tests must be end-to-end: no mocks, no fakes.**

Reference implementation: `/Users/moboudra/dev/voice-dev/.tmp/happy-cli` (see `src/codex/` for MCP + elicitation flow).

## Guiding Principles

- TDD: write failing tests first, then implement
- All tests must be e2e (no mocks/fakes)
- Keep providers parallel (no breaking changes to existing Codex SDK provider)
- Verify with real Codex MCP server runs in multiple modes
- Cover edge cases explicitly (permission requests, denial, abort, resume, teardown)

## Tasks

- [⏳] **Plan**: MCP provider behavior matrix and interface mapping.

  - Enumerate required behaviors: start session, continue session, stream events, permission request/response, abort, close.
  - Map each to MCP primitives: `codex` tool, `codex-reply` tool, `codex/event` notifications, elicitation handler.
  - Define the new provider file path: `packages/server/src/server/agent/providers/codex-mcp-agent.ts` and exported classes.
  - Define provider id (`codex-mcp`) and how it will be chosen vs existing `codex` provider.
  - Identify gaps vs `codex-agent.ts` (timeline event types, runtime model info, persistence handles).
  - Insert test tasks immediately after this task.

- [ ] **Plan**: E2E test plan (no mocks).

  - Define how tests start a real `codex mcp-server` (stdio transport) and verify teardown.
  - Define e2e fixtures (temp cwd, temp codex session dir, prompt script).
  - Define expected MCP events and permission elicitation behavior per mode.
  - Insert failing test tasks and review task immediately after this task.

- [ ] **Test (E2E)**: Create failing e2e tests for MCP provider basic flow.

  - Start provider with Codex MCP server and call `createSession`.
  - Send a prompt that writes a file and assert file exists after approval.
  - Assert timeline events include tool call + agent message.
  - Assert session metadata (sessionId/conversationId) is persisted.
  - Ensure tests fail before implementation.

- [ ] **Review**: Review failing e2e tests for coverage and correctness.

  - Check for gaps: permission denied path, abort path, missing event coverage.
  - Add fix tasks if test coverage is insufficient.

- [ ] **Test (E2E)**: Create failing e2e tests for permission handling.

  - read-only + approval on-request: expect elicitation request with command details.
  - deny approval: ensure command does not run; verify agent response indicates refusal.
  - approve once: ensure command runs and file is written.
  - Ensure tests fail before implementation.

- [ ] **Test (E2E)**: Create failing e2e tests for cancellation/abort.

  - Start a long-running command (sleep) and abort; verify turn ends and no output after abort.
  - Verify provider can accept a new prompt after abort.
  - Ensure tests fail before implementation.

- [ ] **Implement**: `codex-mcp-agent.ts` provider skeleton.

  - Implement MCP stdio client (modelcontextprotocol `StdioClientTransport`).
  - Implement start/continue session (`codex` / `codex-reply`).
  - Implement event stream subscription (`codex/event` notifications).
  - Map MCP events to existing AgentStreamEvent + timeline items.

- [ ] **Implement**: Permission elicitation integration.

  - Register `ElicitRequestSchema` handler and emit permission requests into AgentStreamEvent.
  - Maintain pending permission map (id → request) and implement `respondToPermission`.
  - Ensure permission decisions flow back to MCP handler.

- [ ] **Implement**: Runtime info + persistence metadata.

  - Capture runtime model from MCP events if available; fallback to configured model.
  - Provide `describePersistence()` with sessionId/conversationId and any MCP metadata.

- [ ] **Implement**: Abort/cancel and cleanup.

  - Abort in-flight turn via AbortController (or transport cancellation).
  - Reset pending permissions + event processors after abort.
  - Close: terminate MCP transport and child process reliably.

- [ ] **Test (E2E)**: Run MCP provider tests (basic flow + permissions + abort).

  - Verify all previously failing e2e tests now pass.
  - Add fix tasks + retest tasks immediately after if any fail.

- [ ] **Implement**: Provider registration/selection wiring.

  - Add `codex-mcp` to provider manifest and any UI or config selection path.
  - Ensure existing `codex` provider remains default/unchanged.

- [ ] **Test (E2E)**: Full scenario matrix with real Codex MCP server.

  - read-only + on-request (elicitation should fire).
  - read-only + deny (no file write).
  - workspace-write + untrusted (permission prompt present).
  - full-access (no prompt, command executes).
  - Verify file output and agent completion in each scenario.

- [ ] **Review**: Review implementation and edge case coverage.

  - Confirm event mapping parity vs `codex-agent.ts`.
  - Confirm permission request/response lifecycle is robust.
  - Add fix tasks and re-review if needed.

- [ ] **Test (E2E)**: Full server test suite relevant to agent providers.

  - Run focused tests and document results.
  - Add fix tasks if failures found.

- [ ] **Plan**: Re-audit and add follow-up tasks.

  - Verify all required scenarios covered.
  - Add any new tasks discovered during e2e runs.
