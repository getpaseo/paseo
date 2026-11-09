# SC-4609 evidence

`mockup-*.png` are design illustrations with synthetic data, watermarked **Design mockup - not a production screenshot**. They explain current interaction and proposed task/plugin-ticket placement. They are not full-application test evidence. In particular, the example tracker is not a bundled integration, and the mockup's task header is richer than the initial implementation.

`browser-harness-kept-panel.png` is an actual Chromium component-test capture. The test host is deliberately unstyled; it is not a production screenshot.

## Reproduction

Run from the repository root:

```sh
npm run build:client
npm exec --workspace=@getpaseo/app -- vitest run src/composer/tracks-panel.browser.test.tsx --project browser --bail=1
npm exec --workspace=@getpaseo/app -- vitest run src/components/task-list-row.test.tsx src/i18n/locales.test.ts --project unit --bail=1
npm run typecheck --workspace=@getpaseo/app
npm run lint
```

Observed: 12 Chromium tests and 18 unit tests passed; app typecheck passed; lint reported zero warnings/errors.

## Claude Desktop comparison

The [official Desktop documentation](https://code.claude.com/docs/en/desktop), consulted 2026-11-04, describes session details cards beside chat and a Background tasks pane for subagents, shell commands and workflows. These are separate from a provider's TaskCreate checklist. The page does not establish an equivalent checklist or ticket form fixed above the composer. This proposal borrows the separation of live state from chat history, not a claimed pixel-identical Desktop feature. No live Claude Desktop capture was obtained.

## Unverified

Complete app layout, actual plugin form submission, long-transcript last-message clearance, native keyboard and safe areas, Electron and native devices. Selection is client-local, not durable storage. Do not treat these images or focused tests as proof of those behaviors.
