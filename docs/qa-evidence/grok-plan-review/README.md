# Grok plan review — QA evidence (2026-11-28)

## Status

Plan review uses directly visible Whole plan and Lines segments, with a compact mobile action row. The merged branch passed the browser and static checks below. At 1440, 393, and 320 px, feedback shows an explanation beside the disabled approval action; clearing the draft restores approval. No horizontal overflow was observed.

## Scope and provenance

Real Grok CLI 1.0.92 ran through a custom ACP stdio provider with `options.supportsMcpServers: false` and the default permission transport. It used a local Grok login, which is not in the repository and is not published here. Machine paths and excerpts from the private Grok source are excluded.

Desktop (1440x1100) and mobile browser emulation were driven by an AI agent in the browser. The user reviewed earlier desktop screenshots and a hands-on trial and found the desktop UI acceptable. The user rejected the initial mobile proportions and accepted the latest compact layout with directly visible segments. No production daemon on port 6767 was touched or restarted.

## Wire contract

Plan review uses `_x.ai/exit_plan_mode` with params `sessionId`, `toolCallId`, and nullable `planContent`. Responses are `approved`, `cancelled` (with feedback), or `abandoned`. The shape matches the older v45 native wire source, and a current real round trip confirmed it.

## Real Grok checks

- An earlier real run created the README only after approval, with the expected content.
- A simulated permission-response transport failure kept the draft, and retry worked.
- Route, viewport, and reconnect changes kept the draft.
- Request changes returned a revised plan containing the `POINTER_RANGE_OK` marker and at least 56 lines ending in `LONG_PLAN_END`.

## Desktop UI

- A single click selects one source line. A reverse drag from line 8 to line 4 selects lines 4 to 8 and focuses the composer.
- Enter on a focused source row selects it.
- Comments and whole-plan feedback serialize the exact source quotes.
- At 1440 px wide, the card and actions fit on one row.
- The [desktop interaction recording](desktop-interaction.webm) shows a click, a drag from 4 to 6, a saved editable comment, and a long-plan scroll with the footer kept in view. It was recorded before the final segment layout.

## Timeline rows

- Plan mode entered and exited rows show no path-only detail, are not expandable, and stay compact.
- An unrelated Edit README.txt disclosure opens, and `PLAN_REVIEW_APPROVED` content stays rendered.
- After integration with upstream `59377767c`, both real revision-result disclosures still open with their quoted lines and feedback. General feedback, the unrelated edit disclosure, and the pending review remain available.
- Completed `Plan: Exit` results display as `Plan Exit` and start collapsed. Clicking expands the real revision output, including quoted lines and feedback; clicking again collapses it. Cancellation, revision, abandonment, running, and failed results keep their output and errors. The title-only normalization keeps these results distinct from a successful `Plan mode exited` status.

## Mobile browser emulation

Current compact card:

- At 320 px wide there is no horizontal overflow, and request and approve are equal at 44 px.
- At 393x852 (iPhone 15 emulation), add and remove work, and target draft focus and the More menu work.
- Whole plan and Lines X–Y are directly visible segments. Switching keeps both drafts and focuses the input. The input and add icon span the full width, request and approve are equal-width actions, and More actions contains Abandon.
- The [revised mobile card](mobile-browser.png) shows this layout.
- A hidden line draft keeps approval disabled and shows the [approval hint](approval-hint.png). Clearing feedback removes the hint and enables approval; checked at 1440, 393, and 320 px.

Selection checks from before the layout change were not re-run. A swipe from scroll offset 0 to 235 kept the selection without focusing the composer. Tapping line 9, scrolling to the bottom, and tapping line 55 selected and focused.

This record makes no claim that any plan was approved on mobile.

## Automated checks

Raw output is in [validation.txt](validation.txt). Entries from before the mobile card refinement are superseded by the checks below.

- On the branch after integrating upstream `59377767c`, `npm run format`, `npm run typecheck`, and `npm run lint` exited 0. Lint reported 0 warnings and 0 errors.
- Focused `src/tool-calls/presentation.test.ts`: 27 tests passed. The branch had 29 before upstream replaced two message-presentation cases.
- Regression cases cover the exact-match, completed, error-free `other`/`plain_text` metadata normalizer, which must preserve other outputs and failures.
- Final follow-up: `npm run format`, `npm run typecheck`, and `npm run lint` exited 0; `i18n/resources.test.ts` passed all 40 tests.
- Before the mobile card refinement: `model.test.ts` 10 passed, 13 skipped.
- Browser E2E `codex-plan-approval.spec.ts`: 1 passed. It predates the mobile card refinement; the generic path is unchanged.
- Red baseline on unmodified base `dbeb181f0`: the new ACP extension test failed with `TypeError: session.extMethod is not a function`, which reflects the missing extension bridge.
- ACP tests (including the permission bridge) and store tests passed. These results are recorded separately; no raw log for them is in this folder.

## Repro

Use an empty scratch workspace and an isolated `PASEO_HOME`, not `~/.paseo`.

1. Configure an ACP provider in `$PASEO_HOME/config.json` as described in the [ACP provider instructions](../../custom-providers.md#acp-providers). Use `extends: "acp"`, a `label`, `command`, and `options.supportsMcpServers: false`. Set `command` to the installed Grok CLI ACP adapter command; this record does not supply one.
2. Start the checkout's dev daemon with that `PASEO_HOME`, and open the scratch workspace with the configured provider.
3. Ask Grok to call `enter_plan_mode`, write a plan file in the scratch workspace, read it back, then exit plan mode so the plan is shown for review.
4. Request changes, then approve or abandon. Only scratch files should change.

## Limits

- Native iOS, Android, and Electron runtime checks were not done.
- Mobile selection is single-line only; multi-line selection is not supported.
- The source list is not virtualized.
- Mobile checks were agent-driven. They have screenshots but no raw logs in this folder.
- No whole-suite runs were done.

## Artifacts

These artifacts stay on this PR branch.

- [Desktop interaction recording](desktop-interaction.webm)
- [Desktop selected state](desktop-selected.png)
- [Desktop long plan end](desktop.png)
- [Revised mobile browser card](mobile-browser.png)
- [Plan Exit expanded revision result](plan-exit-expanded.png)
- [Approval hint at 320 px](approval-hint.png)
- [Raw command output](validation.txt)
