# Refactor Validation and Test Suite Audit

Date: 2025-12-25

## Part 1: Refactor Quality Checks

Command:

```
rg -n "as \{|as Record|Record<string, unknown>" packages/server/src/server/agent/
```

Matches found (exact file:line):

- packages/server/src/server/agent/agent-mcp.e2e.test.ts:13
- packages/server/src/server/agent/agent-mcp.e2e.test.ts:14
- packages/server/src/server/agent/agent-mcp.e2e.test.ts:18
- packages/server/src/server/agent/agent-mcp.e2e.test.ts:62
- packages/server/src/server/agent/agent-mcp.e2e.test.ts:71
- packages/server/src/server/agent/model-catalog.ts:180
- packages/server/src/server/agent/activity-curator.ts:72
- packages/server/src/server/agent/activity-curator.ts:73
- packages/server/src/server/agent/activity-curator.ts:85
- packages/server/src/server/agent/activity-curator.ts:86
- packages/server/src/server/agent/agent-projections.ts:186
- packages/server/src/server/agent/agent-projections.ts:187
- packages/server/src/server/agent/stt-openai.ts:127
- packages/server/src/server/agent/providers/claude-agent.test.ts:99
- packages/server/src/server/agent/providers/claude-agent.test.ts:109
- packages/server/src/server/agent/providers/claude-agent.test.ts:110
- packages/server/src/server/agent/providers/claude-agent.test.ts:456
- packages/server/src/server/agent/providers/claude-agent.test.ts:463
- packages/server/src/server/agent/providers/claude-agent.test.ts:1279
- packages/server/src/server/agent/providers/claude-agent.ts:159
- packages/server/src/server/agent/providers/claude-agent.ts:164
- packages/server/src/server/agent/providers/claude-agent.ts:784
- packages/server/src/server/agent/providers/claude-agent.ts:785
- packages/server/src/server/agent/providers/claude-agent.ts:874
- packages/server/src/server/agent/providers/claude-agent.ts:1120
- packages/server/src/server/agent/providers/claude-agent.ts:1138
- packages/server/src/server/agent/providers/claude-agent.ts:1162
- packages/server/src/server/agent/providers/claude-agent.ts:1163
- packages/server/src/server/agent/providers/claude-agent.ts:1249
- packages/server/src/server/agent/providers/claude-agent.ts:1343
- packages/server/src/server/agent/providers/claude-agent.ts:1347
- packages/server/src/server/agent/providers/claude-agent.ts:1350
- packages/server/src/server/agent/providers/claude-agent.ts:1364
- packages/server/src/server/agent/providers/claude-agent.ts:1375
- packages/server/src/server/agent/providers/claude-agent.ts:1392
- packages/server/src/server/agent/providers/codex-agent.test.ts:190
- packages/server/src/server/agent/providers/codex-agent.test.ts:337
- packages/server/src/server/agent/providers/codex-agent.test.ts:980
- packages/server/src/server/agent/providers/codex-agent.test.ts:1043
- packages/server/src/server/agent/providers/codex-agent.test.ts:1054
- packages/server/src/server/agent/providers/codex-agent.test.ts:1065
- packages/server/src/server/agent/providers/codex-agent.ts:136
- packages/server/src/server/agent/providers/codex-agent.ts:143
- packages/server/src/server/agent/providers/codex-agent.ts:167
- packages/server/src/server/agent/providers/codex-agent.ts:234
- packages/server/src/server/agent/providers/codex-agent.ts:250
- packages/server/src/server/agent/providers/codex-agent.ts:886
- packages/server/src/server/agent/providers/codex-agent.ts:1092
- packages/server/src/server/agent/providers/codex-agent.ts:1093
- packages/server/src/server/agent/providers/codex-agent.ts:1171
- packages/server/src/server/agent/providers/codex-agent.ts:1237
- packages/server/src/server/agent/providers/codex-agent.ts:1244
- packages/server/src/server/agent/providers/codex-agent.ts:1452
- packages/server/src/server/agent/providers/codex-agent.ts:1454
- packages/server/src/server/agent/providers/codex-agent.ts:1456
- packages/server/src/server/agent/providers/codex-agent.ts:1481
- packages/server/src/server/agent/providers/codex-agent.ts:1483
- packages/server/src/server/agent/providers/codex-agent.ts:1495
- packages/server/src/server/agent/providers/codex-agent.ts:1503
- packages/server/src/server/agent/providers/codex-agent.ts:1794
- packages/server/src/server/agent/providers/codex-agent.ts:1963
- packages/server/src/server/agent/providers/codex-agent.ts:2045
- packages/server/src/server/agent/providers/codex-agent.ts:2053
- packages/server/src/server/agent/providers/codex-agent.ts:2143
- packages/server/src/server/agent/providers/codex-agent.ts:2155
- packages/server/src/server/agent/providers/codex-agent.ts:2156
- packages/server/src/server/agent/providers/codex-agent.ts:2204
- packages/server/src/server/agent/providers/codex-agent.ts:2222
- packages/server/src/server/agent/providers/codex-agent.ts:2233
- packages/server/src/server/agent/providers/codex-agent.ts:2238
- packages/server/src/server/agent/providers/codex-agent.ts:2239

Command:

```
rg -n "\?\?" packages/server/src/server/agent/providers/codex-mcp-agent.ts
```

Result: no matches.

Zod schema coverage check:
- `CodexEventSchema` is a union of typed event schemas in `packages/server/src/server/agent/providers/codex-mcp-agent.ts:1401`.
- Additional schema definitions exist for thread items, command exec, patch apply, read file, MCP tool call, web search, todos, and errors.
- No unparsed event handling found outside the schema boundary in this file (based on scan of schema definitions and event parsing).

## Part 2: Test Run (Full Suite)

Command:

```
npm run test --workspace=@paseo/server 2>&1 | tee test-output.txt
```

Outcome: test run did not complete. After Codex SDK tests, an MCP server error was emitted and the run stalled; interrupted manually.

Failure and skip observed before interruption:
- Failed: `CodexAgentClient (SDK integration) > hydrates persisted shell_command tool calls with completed status` (expected undefined to be truthy).
- Skipped: `CodexAgentClient (SDK integration) > emits permission requests and resolves them when approvals are handled (awaiting Codex support)`.

Error emitted during run:

```
2025-12-25T03:41:54.472453Z ERROR codex_mcp_server::message_processor: <- error: JSONRPCError { error: JSONRPCErrorError { code: -32603, data: None, message: "[\n  {\n    \"code\": \"custom\",\n    \"message\": \"permission call_id provided multiple times (codex_call_id, codex_mcp_tool_call_id, codex_event_id)\",\n    \"path\": []\n  }\n]" }, id: Integer(0), jsonrpc: "2.0" }
```

Grepping for skips/todo:

```
grep -E "skip|Skip|SKIP|todo|TODO" test-output.txt
```

Result:
- `src/server/agent/providers/codex-agent.test.ts (15 tests | 1 failed | 1 skipped)`

## Part 3: Test Results

- Full suite did not finish due to the MCP server error above; remaining tests did not run.
- At least 1 failure and 1 skip occurred before interruption.

## Part 4: Typecheck

Command:

```
npm run typecheck --workspace=@paseo/server
```

Errors:
- `packages/server/src/server/agent/providers/codex-mcp-agent.ts:348:6` TS6196: `PatchChangeDetails` declared but never used.
- `packages/server/src/server/agent/providers/codex-mcp-agent.ts:1674:19` TS2339: `model` does not exist on type `{ prompt: string; cwd: string; "approval-policy": string; sandbox: string; config: AgentMetadata | undefined; }`.
- `packages/server/src/server/agent/providers/codex-mcp-agent.ts:2945:7` TS2322: `AgentProvider` is not assignable to type `"codex-mcp"`.
- `packages/server/src/server/agent/providers/codex-mcp-agent.ts:2959:11` TS2322: type `{ provider: AgentProvider; ...; agentControlMcp?: unknown }` is not assignable to `AgentSessionConfig` because `agentControlMcp` is `unknown`.
- `packages/server/src/server/agent/providers/codex-mcp-agent.ts:2970:7` TS2322: `AgentProvider` is not assignable to type `"codex-mcp"`.
