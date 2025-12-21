# Plan

## Context

Voice-controlled terminal assistant using OpenAI's Realtime API. Monorepo with Express backend and Expo cross-platform app.

**Focus**: Agent model info tracking. Two distinct concepts:
1. **Configured model**: What the user requested (default or specific model)
2. **Runtime model**: What the agent is actually using (from the agent process itself)

Hard requirement: We must get the actual runtime model, not just echo back the requested config.

## Environment

- **Expo app**: Running in tmux session `moboudra:mobile` - check logs with `tmux capture-pane -t moboudra:mobile -p`
- **Server**: Running in tmux session `moboudra:server` - check logs with `tmux capture-pane -t moboudra:server -p`
- **Web testing**: Use Playwright MCP at `http://localhost:8081`

## Guiding Principles

- Keep changes minimal and focused
- Run typecheck after every change
- Don't break existing functionality
- Test in the running app when possible

## Autonomous Loop Requirements (CRITICAL)

- **Always add follow-up tasks.** Every task type must add new tasks to keep the loop running:
  - **Plan** tasks → add implementation tasks, test tasks, and another Plan task to re-audit later
  - **Implement** tasks → just implement, test task should already be in the plan
  - **Test** tasks → if issues found, add fix tasks + re-test task; if passing, document and continue
  - **Fix** tasks → add re-test task to verify the fix
  - **Review** tasks → add fix tasks for issues + another review task after fixes
- **Insert tasks at the right position.** New tasks go immediately after the current task, not at the end.
- **Never leave the plan empty.** If you're the last task, add a checkpoint or review task.

## Testing Requirements (CRITICAL)

- **Nothing is done until tested.** Every implementation task must be followed by a testing task using Playwright MCP.
- **Test tasks verify specific behaviors.** Not "test the feature" but "verify X does Y when Z".
- **Test failures spawn fix tasks.** If a test finds issues, add fix tasks immediately after.
- **Fix tasks get their own test tasks.** After a fix task, add a re-test task to verify the fix.
- **Loop until it works.** The cycle is: implement → test → fix → re-test → ... until verified working.
- **Testers own the plan.** Test tasks can and should add new tasks (fixes, re-tests) to keep the loop going.
- **Never claim done without verification.** If you can't test it with Playwright MCP, you can't mark it complete.

## Tasks

- [x] **Plan**: Audit current model info implementation and expand this plan.

  - Find where model config is set when creating agents.
  - Find where runtime model info is fetched/displayed.
  - Document how each provider (Claude SDK, Codex SDK) exposes actual model info.
  - Check if we're currently showing requested model vs actual runtime model.
  - Add implementation tasks based on findings.
  - Add test tasks as needed.
  - Add another **Plan** task at an appropriate position to re-audit after some progress.
  - **Done (2025-12-21 12:45)**: Completed full audit. See findings below.

### Audit Findings: Model Info Implementation

**Current Architecture (Working Well)**:
- Model config is set via `AgentSessionConfig.model` in `agent-sdk-types.ts:148-164`
- Runtime info uses `AgentRuntimeInfo` type with `model` field in `agent-sdk-types.ts:126-132`
- UI correctly uses `extractAgentModel()` which reads `runtimeInfo.model` (not config)
- Displayed in agent screen header at line 555 of `[agentId].tsx`

**Claude SDK**:
- `claude-agent.ts:423-435` - `getRuntimeInfo()` returns `this.lastOptionsModel`
- Model comes from Claude SDK options passed during agent creation
- Currently echoes back the configured model (not truly "runtime detected")

**Codex SDK**:
- `codex-agent.ts:407-426` - `getRuntimeInfo()` reads actual runtime model
- `codex-agent.ts:1229-1261` - Parses rollout file for `turn_context.payload.model`
- This IS the actual runtime model (correctly implemented)
- Falls back to config model if rollout not available yet

**Gap Identified**:
- Claude agents: Model info is the configured model, not detected from Claude SDK
- Codex agents: Model info IS detected from runtime (via rollout file) ✓
- Claude SDK may expose actual model in response metadata - needs investigation

**Data Flow**:
1. Config: `config.model` → agent creation
2. Runtime: `agent.session.getRuntimeInfo()` called after stream/turn completion
3. Storage: `runtimeInfo` persisted in agent registry
4. Client: Receives via WebSocket, displayed via `extractAgentModel()`

---

- [x] **Investigate**: Check if Claude SDK exposes actual model in response/stream metadata.
  - Look at `@anthropic-ai/claude-agent-sdk` types for model info in responses
  - Check if `query()` returns model information
  - Document findings for implementation task
  - **Done (2025-12-21 13:15)**: YES, the Claude SDK exposes actual model info in TWO places:
    1. `SDKSystemMessage` (subtype: "init") has `model: string` field (sdk.d.ts:334)
    2. `SDKResultMessage` has `modelUsage: { [modelName: string]: ModelUsage }` (sdk.d.ts:299-300)
    - Current implementation ignores both - only uses `config.model` (claude-agent.ts:712)
    - Fix: Update `handleSystemMessage()` to capture `message.model` as `lastOptionsModel`
    - Alternatively: Extract model name from `modelUsage` keys in `SDKResultMessage`

- [x] **Implement**: Capture actual model from Claude SDK init message.
  - In `handleSystemMessage()`, set `this.lastOptionsModel = message.model`
  - This gives us the actual model the SDK selected (not just our config)
  - Simpler than parsing modelUsage, same result
  - **Done (2025-12-21 13:25)**: Updated `handleSystemMessage()` in `claude-agent.ts:868-882` to capture `message.model` from the SDK init message and invalidate cached runtime info. Typecheck passes.

- [x] **Test**: Verify current Codex runtime model detection works.
  - Create a Codex agent with default model
  - Wait for first turn to complete
  - Verify the model displayed matches actual runtime model (e.g., `gpt-4.1`)
  - Check that it's not just echoing configured model
  - If issues found: add fix tasks immediately after this task, then add re-test task after fixes.
  - **Done (2025-12-21 13:35)**: PASSED. Created Codex agent with "Automatic" model config. After first turn, UI correctly displays `gpt-5.1-codex-max` (actual runtime model from rollout file), not "Automatic". Runtime model detection working correctly.

- [x] **Test**: Verify Claude agent model display behavior.
  - Create a Claude agent with default model
  - Wait for first turn to complete
  - Check what model is displayed
  - Document whether it's configured or runtime model
  - If issues found: add fix tasks immediately after this task, then add re-test task after fixes.
  - **Done (2025-12-21 13:50)**: FAILED. Created Claude agent with "Automatic" model config. Agent self-reported running on `claude-opus-4-1-20250805` (Opus 4.1), but UI shows **Model: Unknown** in agent info menu. The implementation to capture model from SDK init message is not working - model is not being propagated to the UI.

- [x] **Fix**: Debug and fix Claude agent model capture from SDK init message.
  - Check server logs to see if `handleSystemMessage()` is receiving the init message with model
  - Verify `this.lastOptionsModel` is being set correctly
  - Check if `getRuntimeInfo()` is being called after stream completion
  - Ensure runtime info is being persisted and sent to client via WebSocket
  - The model should show `claude-opus-4-1-20250805` instead of "Unknown"
  - **Done (2025-12-21 14:10)**: Found and fixed the bug. The issue was in `agent-manager.ts:refreshRuntimeInfo()` - it updated `agent.runtimeInfo` but never called `emitState(agent)` to notify clients. Fixed by adding change detection and emitting state when runtimeInfo changes. Also added debug logging to `handleSystemMessage()` to confirm model capture from SDK init message. Typecheck passes.

- [ ] **Test**: Re-verify Claude agent model display after fix.
  - Create a new Claude agent with default model
  - Wait for first turn to complete
  - Verify model displays correctly (not "Unknown")
  - Should show actual runtime model like `claude-opus-4-1-20250805`

- [ ] **Plan**: Re-audit after investigation and initial tests complete.
  - Review test results
  - Determine if Claude SDK exposes runtime model info
  - Add implementation tasks if improvements needed
  - Add fix tasks if tests reveal issues

- [ ] **Plan**: Fix agent git diff not loading.

  - Investigate why git diff is not loading in agent view.
  - Find where git diff is fetched and rendered.
  - Identify the root cause of the loading failure.
  - Add implementation/fix tasks based on findings.
  - Add test task to verify git diff loads correctly via Playwright MCP.
  - Add another **Plan** task to re-audit after fix if needed.

- [ ] **Plan**: Design and implement agent parent/child hierarchy.

  - Add `parentId` field to agents.
  - Agents created via MCP should auto-set parentId to the calling agent.
  - Homepage should only show top-level agents (no parentId).
  - Agent screen three-dot menu should show sub-agents of that agent.
  - Sub-agents should be navigable from the menu.
  - Ensure back button works properly when navigating agent hierarchy.
  - Add implementation tasks based on findings.
  - Add another **Plan** task at an appropriate position to re-audit after some progress.

- [ ] **Plan**: Tool call details in bottom sheet on mobile.

  - Currently tool calls in agent stream expand inline which is awkward on mobile.
  - Tool call tap should open details in a bottom sheet instead.
  - Review current tool call rendering in agent stream.
  - Design bottom sheet component for tool call details.
  - Add implementation tasks based on findings.
  - Add test tasks to verify on mobile web via Playwright MCP.
  - Add another **Plan** task at an appropriate position to re-audit after some progress.

- [ ] agent=codex **Review**: Code quality and types review.

  - Review all changed files for code quality issues.
  - Check TypeScript types are correct and complete.
  - Look for any type errors or unsafe casts.
  - Check for proper error handling.
  - Add fix tasks for any issues found.
  - Add another `agent=codex **Review**` task after fix tasks to verify fixes.
