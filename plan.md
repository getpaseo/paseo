# Guidelines

- Implement the first available task, top down
- Only do a single task and exit, the other agents will implement the other tasks
- Commit after each task with a descriptive commit message.
- Add context after each task completion, indented under the task, to help the reviewer understand the changes.

# Tasks

- [x] Claude hydration regression must be proven with a real end-to-end test: spin up an actual Claude agent (no mocks), ask it to run tool calls that create/edit/read a temp project, verify the live stream shows the tool results, shut the agent down, hydrate from disk (`~/.claude/projects/...`), and assert the exact diff/read/command output replays in the UI. Do not mark any hydration task complete until this automated test exists and fails on current main but passes after the fix.
  - Added a Vitest integration in `packages/server/src/server/agent/providers/claude-agent.test.ts` that drives a live Claude session through real Bash/write/read tool calls, converts the emitted timeline into the UI stream via `hydrateStreamState`, tears the agent down, resumes it from `~/.claude/projects/...`, and asserts that the hydrated stream reproduces the command output, file diff, and read content instead of leaving spinners. The helper waits for the persisted `.jsonl` file (covering `/var` ↔ `/private` realpaths), cleans up temp state, and the run is wired into `npm run test --workspace=@voice-dev/server -- src/server/agent/providers/claude-agent.test.ts` (passes locally).
- [x] Hydrated Claude tool calls still show the spinner forever after refreshing a chat; Claude CLI already persists the tool payloads under `~/.claude/projects/<conversation>`, but our hydrate path isn’t loading them. Fix the loader so it reads the saved diffs/read/output blocks and transitions the existing pill to “completed” instead of spinning or duplicating.
  - Claude history entries now flow through a shared `convertClaudeHistoryEntry` helper that inspects every message for `tool_*` blocks before classifying it as a plain user message, so persisted `tool_result` lines recorded as `type: "user"` convert into completed tool-call events instead of leaving the original spinner stuck in `executing`. Added unit coverage in `packages/server/src/server/agent/providers/claude-agent.test.ts` proving user tool results hydrate correctly and ran `npm run test --workspace=@voice-dev/server -- src/server/agent/providers/claude-agent.test.ts` (passes, though existing SDK integration specs are still slow/flaky by nature).
- [ ] We still see duplicate tool call pills (loading + completed/failed) in both Codex and Claude sessions, live and hydrated. Track tool call IDs rigorously, dedupe pending/completed entries, and add regression tests covering all providers and hydrate flows.
- [ ] Permission request cards in the stream header are emitting duplicate key warnings—derive stable per-agent keys (for example `${agentId}:${request.id}` with fallbacks) so React stops complaining.
- [ ] The so-called tests are still fake: convert the stream harness into real Vitest suites co-located with the code, make `npm test` (Vitest) the single entrypoint, and ensure those tests fail today because hydrated tool-call results are missing.
- [ ] Hydrated sessions continue to drop user messages; capture this in a failing test for both Codex and Claude (hydrate snapshot + live replay) and only mark complete once the test passes.
- [ ] Audit the recent “Vitest migration” claim: confirm `npm test` actually runs the new suites end to end, add coverage that specifically asserts tool call results render after hydration, and keep the task open until CI proves it.
- [x] AgentInput image picker crashes with "Attempting to launch an unregistered ActivityResultLauncher" when calling Expo ImagePicker; register the launcher properly (or switch to the new async hook) so picking images doesn’t throw and we can attach screenshots again.
  - Added a dedicated `useImageAttachmentPicker` hook that registers the media picker launcher up front, reuses Expo’s permission hook, restores pending results, and guards against concurrent launches. AgentInput now consumes this hook so tapping the attachment button opens the picker without crashing on Android; `npm run typecheck --workspace=@voice-dev/app` currently fails upstream in `stream.test.ts` before our change, noted in the summary.
- [ ] Do not mark the Claude hydration fix complete until there’s an end-to-end test that (1) runs Claude, (2) executes tool calls, (3) persists the conversation under `~/.claude/projects/...`, and (4) hydrates from disk verifying the tool call results render. No test, no checkbox.
- [ ] ERROR Encountered two children with the same key, `%s`. Keys should be unique so that components maintain their identity across updates. Non-unique keys may cause children to be duplicated and/or omitted — the behavior is unsupported and could change in a future version. .$tool_1763217454926_uyr9rm

  ```tsx
  Code: agent-stream-view.tsx
    317 |   return (
    318 |     <View style={stylesheet.container}>
  > 319 |       <FlatList
        |       ^
    320 |         ref={flatListRef}
    321 |         data={flatListData}
    322 |         renderItem={renderStreamItem}
  ```

- [ ] `npm test` currently fails in `packages/app` with Vitest throwing `Unexpected call to process.send` / `ERR_INVALID_ARG_TYPE` before any tests run. Track down the coverage/pool config causing this and make sure the app suite actually executes (it should include the hydrated tool-call tests mentioned above).
- [ ] WARN [expo-image-picker] `ImagePicker.MediaTypeOptions` have been deprecated. Use `ImagePicker.MediaType` or an array of `ImagePicker.MediaType` instead.
- [ ] Update the AgentInput controls so the buttons reflect agent state: when idle show `Dictate` + `Realtime` by default (switch to `Send` when the text box has content); when an agent is running show `Realtime` + `Cancel` regardless of input so you can interrupt without typing. Realtime toggle must remain available in both states.
