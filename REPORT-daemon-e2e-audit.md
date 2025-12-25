# Daemon E2E Test Coverage Audit

**Date**: 2025-12-25
**Test File**: `packages/server/src/server/daemon.e2e.test.ts`

## Test Run Summary

```
5 passed, 2 skipped in 40.8s
```

All active tests pass. The 2 skipped tests are Claude permission flow tests (documented issue with Claude SDK behavior in daemon context).

---

## Current Test Coverage

### Test: `creates agent and receives response`
- **Provider**: Codex
- **Coverage**:
  - `createAgent()` → creates agent, returns `AgentSnapshotPayload`
  - `sendMessage()` → sends text message to agent
  - `waitForAgentIdle()` → waits for agent to complete
  - Verifies `agent_state` message with `status: "idle"`
  - Verifies `agent_stream` events: `turn_started`, `turn_completed`, `timeline` (assistant_message)

### Test: `permission flow: Codex > approves permission and executes command`
- **Provider**: Codex
- **Coverage**:
  - `waitForPermission()` → receives `permission_requested` event
  - `respondToPermission()` → sends `allow` response
  - Verifies `permission_resolved` event with `behavior: "allow"`
  - Verifies timeline has `tool_call` with `status: "granted"`
  - Verifies file system side-effect (file created)

### Test: `permission flow: Codex > denies permission and prevents execution`
- **Provider**: Codex
- **Coverage**:
  - `waitForPermission()` → receives `permission_requested` event
  - `respondToPermission()` → sends `deny` response with message
  - Verifies `permission_resolved` event with `behavior: "deny"`
  - Verifies timeline has `tool_call` with `status: "denied"`
  - Verifies file system side-effect (file NOT created)

### Test: `persistence flow > persists and resumes Codex agent`
- **Provider**: Codex
- **Coverage**:
  - Agent creation and messaging
  - `deleteAgent()` → deletes active agent
  - Verifies `agent_deleted` event
  - `resumeAgent(handle)` → resumes from persistence handle
  - Verifies resumed agent can receive messages
  - Verifies conversation context preserved

### Test: `multi-agent orchestration > parent agent creates child via agent-control MCP`
- **Provider**: Codex (parent and child)
- **Coverage**:
  - Parent agent uses `agent-control` MCP to call `create_agent`
  - Verifies tool call in timeline: `tool: "create_agent"`, `server: "agent-control"`
  - Verifies both parent and child visible in `agent_state` messages
  - Verifies child agent ID extracted from tool output

### Skipped: `permission flow: Claude > approves/denies permission`
- **Reason**: Claude SDK doesn't request permissions in daemon context
- **Note**: Direct `claude-agent.test.ts` permission tests pass; issue is daemon-specific

---

## DaemonClient API Coverage

| Method | Tested | Notes |
|--------|--------|-------|
| `connect()` | ✅ | Used in beforeEach via `createDaemonTestContext()` |
| `close()` | ✅ | Used in afterEach via `cleanup()` |
| `createAgent()` | ✅ | All tests |
| `deleteAgent()` | ✅ | Persistence test |
| `listAgents()` | ❌ | Not explicitly tested |
| `listPersistedAgents()` | ❌ | Not tested (Codex doesn't implement it) |
| `resumeAgent()` | ✅ | Persistence test |
| `sendMessage()` | ✅ | All tests |
| `cancelAgent()` | ❌ | Not tested |
| `setAgentMode()` | ❌ | Not tested |
| `respondToPermission()` | ✅ | Permission tests |
| `waitForAgentIdle()` | ✅ | All tests |
| `waitForPermission()` | ✅ | Permission tests |
| `on()` (event subscription) | ❌ | Not tested directly |
| `getMessageQueue()` | ✅ | Used for assertions |
| `clearMessageQueue()` | ✅ | Used to isolate test phases |

---

## Message Protocol Coverage

### Inbound Messages (Client → Daemon)

| Message Type | Tested |
|--------------|--------|
| `create_agent_request` | ✅ |
| `delete_agent_request` | ✅ |
| `send_agent_message` | ✅ |
| `agent_permission_response` | ✅ |
| `resume_agent_request` | ✅ |
| `cancel_agent_request` | ❌ |
| `set_agent_mode` | ❌ |
| `list_persisted_agents_request` | ❌ |
| `refresh_agent_request` | ❌ |
| `initialize_agent_request` | ❌ |
| `git_diff_request` | ❌ |
| `file_explorer_request` | ❌ |
| `git_repo_info_request` | ❌ |
| `clear_agent_attention` | ❌ |
| `list_provider_models_request` | ❌ |

### Outbound Messages (Daemon → Client)

| Message Type | Tested |
|--------------|--------|
| `agent_state` | ✅ |
| `agent_stream` | ✅ (partial - timeline, turn events, permissions) |
| `session_state` | ❌ (received but not explicitly verified) |
| `agent_deleted` | ✅ |
| `agent_permission_request` | ✅ |
| `agent_permission_resolved` | ✅ |
| `list_persisted_agents_response` | ❌ |
| `status` | ❌ |
| `activity_log` | ❌ |
| `assistant_chunk` | ❌ |
| `audio_output` | ❌ (realtime mode) |
| `transcription_result` | ❌ (realtime mode) |
| `artifact` | ❌ |
| `conversation_loaded` | ❌ |
| `git_diff_response` | ❌ |
| `file_explorer_response` | ❌ |
| `git_repo_info_response` | ❌ |
| `list_provider_models_response` | ❌ |

---

## Agent Provider Coverage

| Provider | Basic Flow | Permissions | Persistence | Multi-agent |
|----------|------------|-------------|-------------|-------------|
| Codex | ✅ | ✅ | ✅ | ✅ |
| Claude | ❌ | ⏸️ (skipped) | ❌ | ❌ |

---

## Coverage Gaps & Recommendations

### Priority 1: High Value / Low Effort

1. **`cancelAgent()` test**
   - Cancel an agent mid-execution
   - Verify agent stops and reaches idle/error state
   - Currently untested DaemonClient method

2. **`setAgentMode()` test**
   - Create agent in one mode, switch to another
   - Verify mode change reflected in agent state
   - Currently untested DaemonClient method

3. **`listAgents()` test**
   - Connect client, call listAgents()
   - Verify session_state returns current agents
   - Currently the method exists but is never called in tests

### Priority 2: Provider Parity

4. **Claude basic flow test**
   - Currently no passing Claude tests
   - Add simple "creates agent and receives response" for Claude
   - Investigate why Claude permissions behave differently in daemon

5. **Claude persistence test**
   - Resume Claude agent from persistence handle
   - Verify conversation context preserved

### Priority 3: Edge Cases

6. **Error handling test**
   - Agent encounters error during execution
   - Verify error state, `lastError` field populated
   - Verify recovery (can send new message after error)

7. **Connection handling test**
   - Reconnect after disconnect
   - Multiple simultaneous clients
   - Rate limiting/timeout behavior

8. **Message ordering test**
   - Send multiple messages rapidly
   - Verify ordering preserved
   - Verify no race conditions

### Priority 4: Feature Coverage (Lower Priority)

9. **Image attachment test**
   - `sendMessage()` with images option
   - Requires multimodal agent support

10. **Git integration tests**
    - `git_diff_request/response`
    - `git_repo_info_request/response`
    - Requires git repository setup

11. **File explorer tests**
    - `file_explorer_request/response`
    - Navigate filesystem via daemon

---

## Summary

**Current coverage**: Core happy-path scenarios for Codex agents (create, message, permission, persistence, multi-agent).

**Gaps**:
- No Claude provider tests pass (permissions issue)
- Several DaemonClient methods untested (`cancelAgent`, `setAgentMode`, `listAgents`)
- No error/edge case testing
- No tests for auxiliary features (git, file explorer, models)

**Recommendation**: Focus on Priority 1 & 2 items before expanding to edge cases. The Claude permission investigation should be a separate task as it involves SDK behavior analysis.
