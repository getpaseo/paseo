# Quote copy QA

Context: [Discord product discussion](https://discord.com/channels/1481169421832814616/1567926967406301214). No GitHub issue.

## Real app verification

The checks were agent-driven against the running app, with its production Markdown renderer, styles and icons. Mock agents supplied synthetic messages through isolated daemons. Clipboard writes and reads used the real browser/Electron APIs.

- [Browser recording](browser.webm): hover and keyboard-focus reveal, compact visibility, outer quote Markdown and HTML, independent nested quote/code copying, and Mermaid source preserved after rendering and source-view toggling.
- [Browser screenshot](browser-copied.png) and [compact screenshot](browser-compact.png).
- [Actual Electron screenshot](electron-copied.png) and [clipboard/window results](electron-result.json): outer quote, nested quote and literal code copied correctly. The real Electron 44.2.0 window used production main/preload and remained unfocused.

The existing `plan-card-markdown.spec.ts` journey passed: **1 passed (14.9s)**. The real Electron probe passed: **1 passed (16.2s)**. The probe was temporary; it did not add another test suite to the repository. Its recording was not Electron-window evidence and is not included.

The browser journey failed before the Mermaid fix because copying the rendered diagram omitted its source fence. After the fix, the same journey verified that diagram and source views copy identical Markdown and HTML. The copy payload excludes the surrounding paragraphs and Copy/View source/Fullscreen labels.

## Commands and raw output

Browser command, run from `packages/app`:

```sh
E2E_RECORD_VIDEO=1 npx playwright test --project=browser \
  e2e/browser/plan-card-markdown.spec.ts -g "copies quote bodies"
```

The local run used a temporary config setting `executablePath` to system Chrome 157 because Playwright's bundled browser was missing. Video used the installed ffmpeg. No machine-specific test configuration was committed. [Raw browser output](browser.log) includes the actual config/output paths. [Raw Electron output](electron.log) records the separate `_electron.launch` probe.

The targeted selection/copy browser suite passed **65 tests**, including failure/retry, pending writes, current content and both Mermaid presentation states. The clipboard helper suite passed **12 tests**, including its boolean success result. Earlier native source checks passed **24 real-parser semantic round trips** and iOS simulator syntax checks. These source checks do not establish native app UI behavior.

`npm run format`, `npm run lint`, `npm run typecheck` and `npm run format:check` passed. [Raw check output](checks.log).

## Platform coverage and limits

| Platform                         | Coverage                                                                                                                                              |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Browser, Chrome 157              | Full real-app journey, real Markdown/HTML clipboard, wide/compact, Mermaid toggle and recording                                                       |
| macOS, Electron 44.2.0           | Actual window and production main/preload; outer/nested/code clipboard checks and screenshots. Mermaid and compact flow were not repeated in Electron |
| iOS                              | Source/parser/compiler checks only; no linked app build, device or UI run                                                                             |
| Android                          | Source and regression tests reviewed; no SDK/native build or test execution                                                                           |
| Windows/Linux desktop            | Not exercised                                                                                                                                         |
| Slack/Teams/GitHub paste targets | Not exercised; no destination-specific formatting guarantee                                                                                           |

Native changes need rebuilt clients. Quotes/code inside native lists and native Mermaid grouping retain their existing limitations. Native quote-copy accessibility text remains English, matching the existing native code-copy control.

Xcode and iOS simulators were available, but this checkout had no generated iOS/Android projects and no Android SDK. Native UI, accessibility, selection and large-font layout still need device QA. Temporary test daemons, Metro, probe files and Electron processes were cleaned up; the production daemon was not touched.
