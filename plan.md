# Plan

## Context

Improvements to the new agent screen in the app.

## Tasks

- [x] **Iteration 1**: Remember the last used config in the new agent screen.

    - Restore the previous behavior where the config was persisted.
    - When user creates an agent, save the selected config (provider, model, mode, working directory, host).
    - On next visit to new agent screen, pre-populate with last used config.
    - **Done (2025-12-28 23:35)**: WHAT: `packages/app/src/app/agent/new.tsx:77-592` now builds initial values only from provided params and persists form preferences on create; `packages/app/src/hooks/use-agent-form-state.ts:309-356` adds explicit persistence helper. RESULT: new agent screen rehydrates last-used config and saves selections on create. EVIDENCE: Not run (not requested).

- [x] **Iteration 2**: Show the selected permissions mode in the agent selector trigger.

    - The agent selector dropdown trigger currently shows provider and model (e.g., "Claude · auto").
    - It should also display the selected permissions mode (e.g., "Claude · auto · Plan").
    - Update the trigger label to include the mode.
    - **Done (2025-12-28 23:37)**: WHAT: `packages/app/src/app/agent/new.tsx:634-643` adds computed labels for provider/mode and `packages/app/src/app/agent/new.tsx:729` appends the permissions mode in the agent trigger value. RESULT: agent selector trigger now shows provider, model, and permissions mode. EVIDENCE: Not run (not requested).

- [ ] agent=claude **Test 1**: Test config persistence via Playwright MCP.

    - Navigate to new agent screen at `http://localhost:8081/agent/new`.
    - Select a non-default config (e.g., Codex provider, specific model, Plan mode).
    - Create an agent.
    - Navigate back to new agent screen.
    - Verify the previously selected config is pre-populated.
    - If not working, add a fix task with debugging feedback.

- [ ] agent=claude **Test 2**: Test permissions mode display in agent selector via Playwright MCP.

    - Navigate to new agent screen at `http://localhost:8081/agent/new`.
    - Open the agent selector dropdown.
    - Select a specific mode (e.g., "Plan").
    - Verify the trigger label shows provider, model, AND mode (e.g., "Claude · auto · Plan").
    - If not working, add a fix task with debugging feedback.

- [ ] **Iteration 3**: Filter out internal messages when importing Claude agents.

    - When importing Claude agents, internal messages like "Warmup" are shown.
    - These should be filtered out from the imported history.
    - Add daemon-level E2E test to verify filtering.

- [ ] **Iteration 4**: Fix Codex import screen showing nothing.

    - Codex import screen currently displays no content.
    - Investigate and fix the issue.
    - Add daemon-level E2E test to verify import works correctly.
