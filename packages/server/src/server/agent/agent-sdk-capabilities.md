# Agent SDK Capability Notes

## @openai/codex-sdk (0.58.0)

- Entry point is `Codex`/`Thread` (`node_modules/@openai/codex-sdk/dist/index.d.ts`). `Codex.startThread()` spawns the bundled `codex` CLI and returns a `Thread` handle that can issue `run()` or `runStreamed()` calls.
- `Thread.runStreamed()` yields JSONL events typed as `ThreadEvent` (agent messages, reasoning, file changes, MCP tool calls, command executions, web searches, todo lists). These map one-to-one with CLI telemetry, so we can stream reasoning, tool calls, and status without ACP.
- Session persistence is provided via `Codex.resumeThread(id)`; the CLI stores rollouts in `~/.codex/sessions` and resuming passes `resume <threadId>` to the CLI.
- Session configuration is passed via `ThreadOptions`: `model`, `sandboxMode` (`read-only|workspace-write|danger-full-access`), `approvalPolicy`, `modelReasoningEffort`, `networkAccessEnabled`, `webSearchEnabled`, `workingDirectory`, and `skipGitRepoCheck`.
- **Streams reasoning & tool activity**: `ThreadEvent` includes `item.started/updated/completed` with `reasoning` items, file changes, MCP tool calls, command execution events, etc. We get full turn telemetry similar to ACP.
- **Gaps**:
  - No public API to enumerate supported modes/models or switch modes mid-session; options are fixed per `Thread` instance.
  - MCP servers cannot be injected dynamically; MCP items appear in the stream, but the CLI discovers servers from `codex` config, not via SDK APIs.
  - Thread metadata (title, timestamps) isn’t exposed, so our persistence layer would still need to scrape Codex’s manifest if we want richer state.

## @anthropic-ai/claude-agent-sdk (0.1.37)

- Primary surface is the `query()` helper (`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`). It returns an `AsyncGenerator<SDKMessage>` so we get incremental updates (`SDKAssistantMessage`, `SDKPartialAssistantMessage`, `SDKSystemMessage`, `SDKToolProgressMessage`, etc.).
- Control plane APIs are built into the generator: `interrupt()`, `setPermissionMode()`, `setModel()`, `setMaxThinkingTokens()`, and query-time introspection helpers (`supportedCommands()`, `supportedModels()`, `mcpServerStatus()`, `accountInfo()`). Final `SDKResultMessage` entries contain usage/cost and `permission_denials` so we can mirror Claude’s session summary.
- Reasoning/tool output arrives in-band via `SDKAssistantMessage.message` (Anthropic streaming delta structure) and can include `tool_use` blocks; there’s also `SDKToolProgressMessage` updates and `SDKPartialAssistantMessage` typed separately for partial thoughts.
- Session lifecycle:
  - Create a session with `query({ prompt, options })`.
  - Resume via `options.resume` (session id) and optionally `forkSession` if we don’t want to mutate the original log.
  - Hooks (`hooks` option) let us observe `SessionStart`, `SessionEnd`, `PreToolUse`, etc., mirroring Claude Code’s plugin system.
- Configuration options include `agents`, `permissionMode`, `allowedTools`/`disallowedTools`, `systemPrompt`, `plugins`, and `mcpServers`. MCP servers can be stdio/SSE/HTTP or in-process (`createSdkMcpServer`).
- Tool gating is first-class: `canUseTool` callback receives tool invocations and can return allow/deny plus suggested permission persistence updates (`PermissionUpdate`).
- Partial reasoning is delivered via `SDKPartialAssistantMessage` while the final `SDKResultMessage` includes usage, total cost, and permission denials.
- **Gaps**:
  - Claude Agent SDK currently consumes prompts via `query()` calls rather than maintaining a long-lived object per session, so we need to wrap it ourselves to keep stateful handles.
  - While MCPs can be injected, there’s no baked-in manifest of sessions; persistence is up to us (the SDK exposes `session_id` on every message for us to store).
  - Slash command support exists via `supportedCommands()`, but there’s no concept of sandbox/approval tiers like Codex’s `sandboxMode`; we instead rely on `permissionMode` + permission rules.
