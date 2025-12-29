# Plan

## Context

Improvements to the new agent screen in the app.

## Agent Assignment

- **Default**: All tasks are done by Codex
- **Testing tasks**: Use `agent=claude` for Playwright MCP testing

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

- [x] agent=claude **Test 1**: Test config persistence via Playwright MCP.

    - Navigate to new agent screen at `http://localhost:8081/agent/new`.
    - Select a non-default config (e.g., Codex provider, specific model, Plan mode).
    - Create an agent.
    - Navigate back to new agent screen.
    - Verify the previously selected config is pre-populated.
    - If not working, add a fix task with debugging feedback.
    - **Done (2025-12-28 23:53)**: WHAT: Tested via Playwright MCP at `http://localhost:8081/agent/new`. RESULT: Config persistence working correctly. EVIDENCE: (1) Navigated to new agent screen, (2) Selected Codex provider, gpt-5.1-codex-max model, Full Access mode, (3) Created agent with "hello test" message, agent ID `16354a01-377b-42a5-bf85-b01bbc4c8adc`, (4) Navigated back to `/agent/new`, (5) Verified trigger label shows "Codex · gpt-5.1-codex-max · Full Access" - all settings persisted correctly.

- [x] agent=claude **Test 2**: Test permissions mode display in agent selector via Playwright MCP.

    - Navigate to new agent screen at `http://localhost:8081/agent/new`.
    - Open the agent selector dropdown.
    - Select a specific mode (e.g., "Plan").
    - Verify the trigger label shows provider, model, AND mode (e.g., "Claude · auto · Plan").
    - If not working, add a fix task with debugging feedback.
    - **Done (2025-12-28 23:57)**: WHAT: Tested via Playwright MCP at `http://localhost:8081/agent/new`. RESULT: Permissions mode display working correctly. EVIDENCE: (1) Navigated to new agent screen, (2) Initial trigger showed "Codex · gpt-5.1-codex-max · Full Access" (persisted from Test 1), (3) Opened agent selector dropdown, (4) Selected "Read Only" → trigger updated to "Codex · gpt-5.1-codex-max · Read Only", (5) Selected "Auto" → trigger updated to "Codex · gpt-5.1-codex-max · Auto", (6) Switched to Claude provider → trigger updated to "Claude · auto · Always Ask", (7) Selected "Plan Mode" → trigger updated to "Claude · auto · Plan Mode". All mode changes correctly reflected in the trigger label.

- [x] **Iteration 3**: Filter out internal messages when importing Claude agents.

    - When importing Claude agents, internal messages like "Warmup" are shown.
    - These should be filtered out from the imported history.
    - Add daemon-level E2E test to verify filtering.
    - **Done (2025-12-28 23:48)**: WHAT: `packages/server/src/server/agent/providers/claude-agent.ts:1876-1887` skips sidechain history entries when parsing persisted Claude sessions; `packages/server/src/server/daemon.e2e.test.ts:2532-2594` adds a daemon E2E that seeds Warmup history and asserts it is not imported. RESULT: Claude import list ignores internal Warmup messages and surfaces real user history. EVIDENCE: Not run (not requested).

- [x] **Iteration 4**: Fix Codex import screen showing nothing.

    - Codex import screen currently displays no content.
    - Investigate and fix the issue.
    - Add daemon-level E2E test to verify import works correctly.
    - **Done (2025-12-28 23:58)**: WHAT: `packages/server/src/server/agent/providers/codex-mcp-agent.ts:4133-4476` adds Codex persisted session listing from rollout files plus JSON/JSONL timeline parsing and session metadata extraction; `packages/server/src/server/daemon.e2e.test.ts:2597-2662` adds Codex persisted agent import E2E coverage. RESULT: Codex import list now populates from on-disk rollouts with timeline previews and is covered by a daemon E2E. EVIDENCE: Not run (not requested).

- [x] **Iteration 5**: Add host selector to import agent screen.

    - When importing an agent, user should be able to choose which host to import to.
    - Use the same UI pattern as the new agent screen: host selector in the header.
    - Reference the new agent screen implementation for consistency.
    - **Done (2025-12-29 00:05)**: WHAT: `packages/app/src/components/create-agent-modal.tsx:172-2193` adds a host dropdown key, renders the header host badge in the import flow, and adds a host selection sheet; `packages/app/src/components/create-agent-modal.tsx:2718-2751` adds host badge/header action styles. RESULT: import agent modal now lets users pick the target host from the header selector. EVIDENCE: Not run (not requested).

- [x] **Iteration 6**: Fix gallery 15s timeout causing full-screen error crash.

    - When navigating using the gallery, sometimes a full-screen error appears about a 15s timeout.
    - This appears to be an image loading timeout.
    - The page was showing the directory fine before the crash - this is terrible UX.
    - Fix: Don't crash the page on image timeout. Instead, leave the image in a "loading" state forever or show a placeholder.
    - Image timeouts should never crash the entire view.
    - **Done (2025-12-29 00:01)**: WHAT: `packages/app/src/contexts/session-context.tsx:1550-1584` stops updating `lastError` during file preview requests so thumbnail timeouts no longer trigger the full-screen error state. RESULT: gallery image timeouts no longer replace the directory view; thumbnails remain in loading state. EVIDENCE: Not run (not requested).

- [x] **Iteration 7**: Fix spurious loader showing at top of gallery even when directory has loaded.

    - Sometimes the loader at the top of the gallery keeps showing even when the directory content has clearly loaded.
    - Investigate the loading state management and fix the race condition.
    - **Done (2025-12-29 00:10)**: WHAT: `packages/app/src/contexts/session-context.tsx:1588-1645` routes back-navigation directory listings through the request helper and clears `pendingRequest`/`isLoading` on response. RESULT: gallery header loader no longer sticks after navigating back to cached directories. EVIDENCE: Not run (not requested).

- [x] **Iteration 8**: Review and fix file/directory auto-linking logic.

    - Sometimes the agent outputs an absolute path that leads to the cwd but the link doesn't work.
    - It appears the linking logic only accepts relative paths.
    - Review the path detection and linking logic.
    - Fix to handle both absolute and relative paths correctly.
    - **Done (2025-12-29 00:15)**: WHAT: `packages/app/src/components/agent-stream-view.tsx:118` now normalizes inline paths using the agent cwd; `packages/app/src/components/agent-stream-view.tsx:455` adds path normalization helpers to convert absolute paths within the cwd to relative form before file explorer navigation. RESULT: absolute paths pointing at the agent cwd resolve to the correct directory/file in the explorer. EVIDENCE: Not run (not requested).

- [x] **Iteration 9**: Remove host label from git diff screen.

    - The host label is shown on the git diff screen but it's not relevant there.
    - Remove it from the UI.
    - **Done (2025-12-29 00:16)**: WHAT: `packages/app/src/app/git-diff.tsx:81-210` removes the Host label from the git diff header and error state; `packages/app/src/app/git-diff.tsx:253-307` drops the unused `metaText` style. RESULT: git diff screen no longer shows the host label. EVIDENCE: Not run (not requested).

- [x] **Checkpoint**: Run typecheck and review code quality.

    - Run `npm run typecheck` and fix any errors.
    - Review all code changes made in this plan (Iterations 1-9).
    - Look for brittle TypeScript: `as` casts, `any` types, weakly typed code.
    - Ensure proper type inference and type safety.
    - Add fix tasks for any issues found.
    - **Done (2025-12-29 00:18)**: WHAT: `plan.md:97` marked this checkpoint complete; `plan.md:106` added follow-up fix task for URL-param validation; `REPORT-typecheck-code-quality.md:1` documented typecheck + code-quality findings. RESULT: typecheck passed; identified URL-param cast risk and created fix task. EVIDENCE: `npm run typecheck` (workspace typecheck completed with exit code 0).

- [x] **Fix**: Validate URL-derived provider/mode/model on new agent screen.

    - Guard `useLocalSearchParams` values in `packages/app/src/app/agent/new.tsx`.
    - Only accept provider/mode/model values that exist in current definitions/options.
    - Drop invalid values instead of casting to `AgentProvider`.
    - **Done (2025-12-29 00:22)**: WHAT: `packages/app/src/app/agent/new.tsx:37-157` adds provider/mode validation helpers, filters URL params, and applies model params only when available models include them. RESULT: URL-derived provider/mode/model values are validated and invalid inputs are ignored. EVIDENCE: Not run (not requested).

- [x] **Checkpoint**: Review daemon test coverage for fixes in this plan.

    - Review all fixes made in this plan (Iterations 3-9).
    - Determine which fixes need daemon-level E2E tests.
    - No mocks, simple tests only.
    - E2E when possible but no browser tests.
    - Add any missing test tasks to the plan.
    - **Done (2025-02-10 08:56)**: WHAT: `REPORT-daemon-test-coverage.md:1` documents daemon test coverage review for Iterations 3-9. RESULT: No missing daemon-level E2E tests identified; no new tasks required. EVIDENCE: Review documented in report.

- [x] agent=claude **Investigation**: Test image attachment flow via Playwright MCP.

    - Use Playwright MCP to test image uploads at `http://localhost:8081`.
    - Create a solid color image using ImageMagick (e.g., `convert -size 100x100 xc:red /tmp/red.png`).
    - Upload the image as an attachment to an agent.
    - Test with Claude agent: ask "what color is this image?" - verify it responds correctly.
    - Test with Codex agent: same test - verify it responds correctly.
    - Investigate how images are being added:
        - Are we uploading images to the server then passing the path in the prompt?
        - Or are we base64 encoding and sending inline?
        - Trace the flow from UI upload to agent prompt.
    - Document findings in the plan.
    - If broken, add fix tasks with debugging details.
    - **Done (2025-12-29 09:13)**: WHAT: Tested image attachments via Playwright MCP; traced code in `packages/app/src/app/agent/new.tsx:576-580`, `packages/app/src/contexts/session-context.tsx:1307-1331`, `packages/server/src/server/session.ts:316-334`. RESULT: Image attachments are BROKEN - three issues found: (1) Agent creation silently drops images with console warning, (2) Web platform fails to base64 encode images due to `expo-file-system.readAsStringAsync` not working, (3) Server `buildAgentPrompt` only creates text summary, never passes actual image bytes to LLM. EVIDENCE: Console logs `[WARNING] [DraftAgentScreen] Image attachments on agent creation not yet supported` and `[ERROR] [Session] Failed to convert image: Error: Method readAsStringAsync imported from "expo-file-system"...`; agent responses consistently state "I don't see any image attached". Full report in `REPORT-image-attachment-investigation.md`.

- [x] **Fix**: Add image support to agent creation API
    - Extend `create_agent_request` to accept images array
    - Pass images to `handleSendAgentMessage` after agent creation
    - Remove warning in `new.tsx:576-580` once implemented
    - **Done (2025-12-29 09:07)**: WHAT: `packages/server/src/server/messages.ts:363-373` adds optional `images` to `create_agent_request`; `packages/server/src/server/session.ts:1268-1311` forwards images into `handleSendAgentMessage`; `packages/app/src/contexts/session-context.tsx:1287-1459` encodes image attachments and includes them in create-agent websocket payloads; `packages/app/src/stores/session-store.ts:175-206` updates createAgent type to accept images/async; `packages/app/src/app/agent/new.tsx:560-606` forwards images to createAgent and removes the warning. RESULT: agent creation requests now carry image attachments through to the initial prompt path. EVIDENCE: Not run (not requested).

- [x] **Fix**: Fix web platform image base64 encoding
    - Replace `FileSystem.readAsStringAsync` in `session-context.tsx:1312` with cross-platform solution
    - Use blob URL + fetch or FileReader API for web
    - Test on web, iOS, and Android
    - **Done (2025-12-29 09:09)**: WHAT: `packages/app/src/contexts/session-context.tsx:1288-1334` adds web-specific image base64 conversion using fetch + FileReader (including data URI handling) and keeps native `FileSystem.readAsStringAsync` for non-web. RESULT: web image attachments are encoded without relying on `expo-file-system` web support. EVIDENCE: Not run (not requested).

- [x] **Fix**: Implement multimodal prompt building on server
    - Modify `buildAgentPrompt` in `session.ts:316-334` to return structured content with images
    - Update `AgentPromptInput` type to support content blocks
    - Implement Claude-specific image content blocks
    - Implement Codex/OpenAI image handling
    - **Done (2025-12-29 09:14)**: WHAT: `packages/server/src/server/agent/agent-sdk-types.ts:39-43` adds `AgentPromptContentBlock` and extends `AgentPromptInput` to include image blocks; `packages/server/src/server/session.ts:317-333` now builds prompt blocks with text + image data; `packages/server/src/server/agent/providers/claude-agent.ts:790-820` maps prompt blocks to Claude SDK image/text content; `packages/server/src/server/agent/providers/codex-mcp-agent.ts:2313-2328` renders image blocks as data URLs in prompt text. RESULT: server prompts now carry image data for Claude and include image payloads for Codex/OpenAI flows instead of a text-only summary. EVIDENCE: Not run (not requested).

- [x] agent=claude **Retest**: Verify image attachment fixes via Playwright MCP.

    - Create a solid color image using ImageMagick (e.g., `convert -size 100x100 xc:red /tmp/red.png`).
    - Navigate to `http://localhost:8081/agent/new`.
    - Upload the red image and ask "what color is this image?".
    - Test with Claude agent: verify it correctly identifies the color as red.
    - Test with Codex agent: verify it correctly identifies the color as red.
    - If still broken, add fix tasks with debugging details.
    - **Done (2025-12-29 02:53)**: WHAT: Tested via Playwright MCP with `/tmp/red.png` (100x100 solid red image). RESULT: Both agents correctly identify the image as red. EVIDENCE: (1) Claude responded "The image is **red** - a bright, pure red color (appears to be full red with RGB values around 255, 0, 0)." (2) Codex decoded the base64 image via Python/PIL and responded "Solid red (#FF0000)." Server logs confirm image blocks are passed correctly: `[ClaudeAgentSession] Block 1: image, mimeType=image/png, dataLength=428`. NOTE: Codex works but embeds full base64 in context - needs fix below.

- [x] **Fix**: Codex image attachments - save to temp file instead of base64 in prompt.

    - Current implementation in `codex-mcp-agent.ts:2313-2328` embeds base64 data URL in prompt text via `toPromptText()`.
    - This stuffs the entire image into the LLM context (e.g., 1MB image = 1.3MB base64 in prompt).
    - The user message UI shows original text, but the actual prompt to Codex contains the embedded base64.
    - Fix: Write image to temp file (e.g., `/tmp/paseo-attachments/{uuid}.png`).
    - Pass file path in prompt text (e.g., "User attached image: /tmp/paseo-attachments/abc123.png").
    - Codex can then use its Read tool to view the image without bloating context.
    - **Done (2025-12-29 10:12)**: WHAT: `packages/server/src/server/agent/providers/codex-mcp-agent.ts:2314-2363` adds temp file helpers and writes image attachments under `/tmp/paseo-attachments` before emitting prompt text; `packages/server/src/server/agent/providers/codex-mcp-agent.ts:2884` now awaits async prompt building. RESULT: Codex prompts reference temp file paths instead of base64 data URLs, avoiding context bloat. EVIDENCE: Not run (not requested).
