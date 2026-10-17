# Plugin attachment mentions QA

These artifacts use a synthetic installed plugin and an isolated daemon, with no real session
content or model API calls. The fixture and assertions are in
`packages/app/e2e/browser/composer-autocomplete.spec.ts` and
`packages/app/e2e/support/helpers/plugin-attachment-mentions.ts`.

## Interactive evidence

- [Wide browser recording](mentions-wide.webm)
- [Compact browser recording](mentions-compact.webm)
- [Source discovery](mention-sources-wide.png), [search results](mention-results-wide.png), and
  [selected snapshot](mention-attached-wide.png)
- [Compact discovery](mention-sources-compact.png), [results](mention-results-compact.png), and
  [selected snapshot](mention-attached-compact.png)
- [New Agent draft](mention-new-agent-draft.png)
- [Search error](mention-error.png)
- Review regressions: [pending file lookup](review-pending-lookup.webm),
  [no project selected](review-no-project.webm), and [failed file lookup](review-file-error.webm)

The recordings exercise the real composer: find a workspace file, discover `@sessions:`, accept
the source with Tab, search `budget`, accept the result with Tab, repeat the selection without
duplicating the pill, and send. Assertions check the exact outgoing text attachment and external
resource metadata, then read back the daemon's canonical user message. Discovery makes no plugin
RPC requests. Separate browser assertions cover empty/error states, recovery, a delayed stale
response, plugin disablement, a New Agent draft, and the existing slash-command caret behavior.

Review regression checks hold a real directory response and pause the browser clock before the
debounce. Enter and Tab keep the draft unchanged in both states, do not select a stale file, and
do not send a message; acceptance resumes after the current response is released. A plugin-only
fixture exercises source search without creating a project. A controlled file transport error
remains visible when no source matches, but does not hide a valid plugin source.

Tested: Chromium on macOS, at 1280 × 720 and 390 × 844 browser viewports. Compact browser coverage
does not establish native mobile behavior. Native iOS/Android, the Electron shell, Linux, Windows,
and real provider integrations were not exercised.

## Checks

Focused Vitest runs passed:

- `packages/app/src/plugins/evaluate.test.ts`: 51 tests.
- `packages/app/src/plugins/attachments/mentions.test.ts` and `model.test.ts`: 8 tests.
- SDK boundaries, client host helpers, server plugin internal seam, and prompt attachments:
  67 tests across 4 files.
- Existing file-mention parsing: 14 tests.
- Loading-state keyboard acceptance (`use-autocomplete.test.tsx`): 3 tests.

The review follow-up browser run passed all 9 selected scenarios. To reproduce the mention scenarios and
the existing slash-command smoke check together:

```sh
E2E_RECORD_VIDEO=1 npm run test:e2e --workspace=@getpaseo/app -- \
  e2e/browser/composer-autocomplete.spec.ts \
  --grep 'plugin attachment|uses the live cursor when accepting a slash command' --workers=1
```

The discovery browser test first failed against the original composer because `@sessions:` was
absent. During implementation, the file-to-source transition caught stale file suggestions being
accepted with Tab; the final wide and compact runs cover that transition. The evaluator tests
also first failed when the host discarded `mentionPrefix`.

This is agent-assisted implementation and automated browser QA. A human has not manually operated
these flows as part of this contribution.
