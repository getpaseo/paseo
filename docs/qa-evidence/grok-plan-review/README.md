# Grok plan review — QA evidence (2026-11-28)

## Status

The current layout uses directly visible Whole plan / Lines segments and a compact mobile action row. Browser verification and platform limits are recorded below.

## Scope and provenance

Real Grok CLI 1.0.92 ran through a custom ACP stdio provider with `options.supportsMcpServers: false`, using the default permission transport. The run used the local Grok login, which is not in the repository and is not published here. Machine paths and source excerpts from the private Grok source are excluded.

Desktop web (1440x1100) and mobile browser emulation were driven by an AI agent in the browser. The user reviewed the earlier desktop UI and reported that it looks okay. The user rejected the initial mobile proportions. No native iOS, Android, or Electron runtime verification was done. No production daemon on port 6767 was touched or restarted.

## Wire contract

The plan review uses `_x.ai/exit_plan_mode` with params `sessionId`, `toolCallId`, and nullable `planContent`. Responses are `approved`, `cancelled` (with feedback), or `abandoned`. The shape matches the older v45 native wire source. A current real round trip confirmed it.

## Real Grok checks

- An earlier real run created the README only after approval, with the expected content.
- A simulated permission-response transport failure kept the draft, and retry worked.
- Route, viewport, and reconnect changes kept the draft.
- Request changes returned a revised plan. The revision contained the `POINTER_RANGE_OK` marker and at least 56 lines ending in `LONG_PLAN_END`.

## UI checks

Desktop web, 1440x1100:

- A single mouse click selects one source line.
- A reverse drag from line 8 to line 4 selects lines 4 to 8 and focuses the composer.
- Comments and whole-plan feedback serialize the exact source quotes.
- Enter on a focused source row selects it.
- The current desktop recording shows a click, a drag from 4 to 6, a saved editable comment, and a long-plan scroll with the footer kept in view.
- Parent-verified at 1440 wide: the card and actions fit in one row.

Existing Grok timeline browser rows, parent-verified:

- Plan mode entered and exited rows show no path-only detail and are not expandable.
- An unrelated Edit README.txt disclosure opens. PLAN_REVIEW_APPROVED content stays rendered.
- The pending review state remains open.

Mobile browser emulation, current compact card:

- Parent-verified at 320 px wide: no horizontal overflow, and the request and approve actions are equal at 44 px.
- Parent-verified at 393x852 (iPhone 15 emulation): add and remove work, and target draft focus and the More menu work.
- Layout (accepted by the user): Whole plan and Lines X–Y are directly visible segments; switching preserves both drafts and focuses the input. The input and add icon span the full width, request and approve are equal-width actions, and More actions contains Abandon.
- Earlier mobile selection checks ran on the rejected layout and are not re-verified. They are: a swipe from scroll offset 0 to 235 kept the selection and did not focus the composer; tapping line 9, scrolling to the bottom, and tapping line 55 selected and focused.

This record makes no claim that any plan was approved on mobile.

## Automated checks

Raw output is in [validation.txt](validation.txt). Entries from before the mobile card refinement are superseded by the checks below.

- Final `npm run format` exited 0.
- Focused `src/tool-calls/presentation.test.ts`: 23 tests passed.
- Full `npm run typecheck` and `npm run lint` exited 0 after the timeline transition fix. Lint reported 0 warnings and 0 errors.
- Regression tests: an exact-match, completed, error-free `other`/`plain_text` metadata normalizer preserves other outputs and failures.
- Earlier (before the mobile card refinement): `model.test.ts`: 10 passed, 13 skipped.
- Earlier: `i18n/resources.test.ts`: 40 passed.
- Browser E2E `codex-plan-approval.spec.ts`: 1 passed. This predates the mobile card refinement; the generic path is unchanged.
- Red baseline on unmodified base `dbeb181f0`: `acp-agent.test.ts` failed with `TypeError: session.extMethod is not a function`. That is the method-not-found result for the missing extension bridge.

Reported by the worker, without a raw log in this folder:

- Focused ACP tests: 9 initial tests plus 5 new or related permission tests passed.
- Store tests: 5 passed.

No whole-suite runs were done.

## Repro

Use an empty scratch workspace and an isolated `PASEO_HOME`, not `~/.paseo`.

1. Configure an ACP provider in `$PASEO_HOME/config.json` as described in the [ACP provider instructions](../../custom-providers.md#acp-providers). Use `extends: "acp"`, a `label`, `command`, and `options.supportsMcpServers: false`. Set `command` to the actual installed Grok CLI ACP adapter command; this record does not supply one.
2. Start the checkout's dev daemon with that `PASEO_HOME`, and open the scratch workspace with the configured provider.
3. Ask Grok to call `enter_plan_mode`, write a plan file in the scratch workspace, read it back, then exit plan mode so the plan is shown for review.
4. Request changes, then approve or abandon. Only scratch files should change.

## Limits

- Native iOS, Android, and Electron runtime verification is not done.
- Mobile multi-line selection is not supported.
- The source list is not virtualized.
- The Codex browser E2E predates the mobile card refinement.
- The ACP and store test counts are from the worker report, not from raw logs.
- Current mobile checks are parent-verified and have no raw logs in this folder.

## Artifacts

- [Desktop interaction recording](desktop-interaction.webm) predates the accepted Whole plan / Lines segment targets, as applicable.
- [Desktop selected state](desktop-selected.png)
- [Desktop long plan end](desktop.png)
- [Revised mobile browser card](mobile-browser.png)
- [Raw command output](validation.txt)
