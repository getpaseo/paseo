# Plan

## Context

Improvements to the new agent screen in the app.

## Tasks

- [x] **Iteration 1**: Remember the last used config in the new agent screen.

    - Restore the previous behavior where the config was persisted.
    - When user creates an agent, save the selected config (provider, model, mode, working directory, host).
    - On next visit to new agent screen, pre-populate with last used config.
    - **Done (2025-12-28 23:35)**: WHAT: `packages/app/src/app/agent/new.tsx:77-592` now builds initial values only from provided params and persists form preferences on create; `packages/app/src/hooks/use-agent-form-state.ts:309-356` adds explicit persistence helper. RESULT: new agent screen rehydrates last-used config and saves selections on create. EVIDENCE: Not run (not requested).

- [ ] **Iteration 2**: Show the selected permissions mode in the agent selector trigger.

    - The agent selector dropdown trigger currently shows provider and model (e.g., "Claude · auto").
    - It should also display the selected permissions mode (e.g., "Claude · auto · Plan").
    - Update the trigger label to include the mode.
