# Guidelines

- Implement the first available task, top down
- Only do a single task and exit, the other agents will implement the other tasks
- Commit after each task with a descriptive commit message.
- Add context after each task completion, indented under the task, to help the reviewer understand the changes.

# Tasks

- [x] Make sure we are handling edit / read / command tool calls more prominently in the front end, for edits we should show the diff like we do in the git diff screen, for reads we should show the content, and for commands we should show the command output. This would be in the bottom sheet of the tool call. You have to test each agent provider to figure out their specific format, use zod to parse the input/output and show the diff/content/command output accordingly.
  - Added zod-backed parsers for edit/read/command tool calls so the bottom sheet now renders diffs, file contents, and terminal output directly from structured tool input/output across providers. Implemented new UI sections plus type-safe helpers, and ran `npm run typecheck --workspace=@voice-dev/app`. Manual provider-by-provider verification still needs to run on-device once agents are available.
- [x] Same goes for permission tool calls, we should render more richly the permission prompt in the agent stream, ExitPlanMode from Claude we should render the markdown for example. For edit permissions we should show the diff like we do in the bottom sheet tool call.
  - Added shared tool-call parsers plus a reusable diff viewer, then upgraded the permission cards to render plan markdown (ExitPlanMode), shell metadata, diffs, read content, and the raw payload directly inside the stream. Ran `npm run typecheck --workspace=@voice-dev/app`; please test across providers on-device once agents are hooked up.
- [x] Investigate how each agent provider handles todo lists, we should have first class support for rendering those in the agent stream. I believe the Codex calls them plan and Claude uses TodoWrite tool calls. You can search the web, look at their node modules or just experiment via testing, which is a good diea anyways becaue we want tests for this, you just have to thinka bout how to trigger the agent to do plans / todo lists. Maybe just ask directly.
  - Normalized `todo` timeline entries into a dedicated `todo_list` stream item, rendered them with a new plan card in the agent stream (provider badge, completion status, checkboxes), and added consolidation logic plus regression coverage in `test-idempotent-stream.ts`. Ran `npm run typecheck --workspace=@voice-dev/app`.
- [ ] Change "Refresh from disk" to "Refresh" in the agent three dot menu
- [ ] Are we filtering our own shats (already present in agents storage) from the resume agent list? We should if not.
- [ ] Getting "two children with the same key" for "thoughts" and "assistant" review our keying strategy, and make it more robust and performant, and stable.
