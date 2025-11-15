# Guidelines

- Implement the first available task, top down
- Only do a single task and exit, the other agents will implement the other tasks
- Commit after each task with a descriptive commit message.
- Add context after each task completion, indented under the task, to help the reviewer understand the changes.

# Tasks

- [ ] Hydrated Claude tool calls still show the spinner forever after refreshing a chat; Claude CLI already persists the tool payloads under `~/.claude/projects/<conversation>`, but our hydrate path isn’t loading them. Fix the loader so it reads the saved diffs/read/output blocks and transitions the existing pill to “completed” instead of spinning or duplicating.
- [ ] We still see duplicate tool call pills (loading + completed/failed) in both Codex and Claude sessions, live and hydrated. Track tool call IDs rigorously, dedupe pending/completed entries, and add regression tests covering all providers and hydrate flows.
- [ ] Permission request cards in the stream header are emitting duplicate key warnings—derive stable per-agent keys (for example `${agentId}:${request.id}` with fallbacks) so React stops complaining.
- [ ] The so-called tests are still fake: convert the stream harness into real Vitest suites co-located with the code, make `npm test` (Vitest) the single entrypoint, and ensure those tests fail today because hydrated tool-call results are missing.
- [ ] Hydrated sessions continue to drop user messages; capture this in a failing test for both Codex and Claude (hydrate snapshot + live replay) and only mark complete once the test passes.
- [ ] Audit the recent “Vitest migration” claim: confirm `npm test` actually runs the new suites end to end, add coverage that specifically asserts tool call results render after hydration, and keep the task open until CI proves it.
- [x] AgentInput image picker crashes with "Attempting to launch an unregistered ActivityResultLauncher" when calling Expo ImagePicker; register the launcher properly (or switch to the new async hook) so picking images doesn’t throw and we can attach screenshots again.
  - Added a dedicated `useImageAttachmentPicker` hook that registers the media picker launcher up front, reuses Expo’s permission hook, restores pending results, and guards against concurrent launches. AgentInput now consumes this hook so tapping the attachment button opens the picker without crashing on Android; `npm run typecheck --workspace=@voice-dev/app` currently fails upstream in `stream.test.ts` before our change, noted in the summary.
- [ ] Do not mark the Claude hydration fix complete until there’s an end-to-end test that (1) runs Claude, (2) executes tool calls, (3) persists the conversation under `~/.claude/projects/...`, and (4) hydrates from disk verifying the tool call results render. No test, no checkbox.
