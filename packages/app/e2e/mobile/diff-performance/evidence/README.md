# Diff performance verification — 2026-09-09

Android 15/API 35 x86_64 emulator, Hermes, React Native 0.81.5 development build.
Baseline: `fdf3b4b47`; the baseline Metro's affected source files matched that commit.
Both builds used the same emulator, viewport, font, and unwrapped unified presentation.

| Measured work                                      |         Before |          After |
| -------------------------------------------------- | -------------: | -------------: |
| Publish an unchanged snapshot into the query cache | 2,825–3,555 ms |       79–96 ms |
| Build the document on mount                        | 3,480–3,768 ms | 1,290–1,383 ms |
| Prepare native text on mount                       | 1,600–1,731 ms |       37–40 ms |
| Register native scroll worklets                    | 2,469–2,693 ms |   0.41–0.52 ms |
| Longest observed timer gap during mount            | 7,639–8,309 ms | 1,425–1,501 ms |
| Rows prepared for text on mount                    |         14,679 |            140 |

The reopen measurements include three unchanged publications per build across two opens
(one open also received a subscription update). Neither after-open rebuilt the model or
native text. Changed-file identity and unchanged-file model reuse are covered by the query
router and workspace-cache regression tests.

## Workload and measurement limits

The original live workspace continued changing during implementation and reached the
daemon's oversized-diff guard. For repeatability, these measurements replay its same four
generated JavaScript file bodies: 58,716 diff rows, 23.66 million serialized characters.
The original diagnosis also included 17 smaller files; those are excluded from this replay.
The fixture manifest and per-invocation timings are in [android-timings.json](android-timings.json).

The app stayed connected to the live development daemon. Diagnostic wrappers replaced the
target subscription response/update body at the client transport entry, preserving the real
subscription routing. Timers surrounded JSON parsing, query publication, model building,
native text preparation, and worklet registration. A 16 ms timer measured event-loop gaps.
Mount samples start with an unbuilt renderer; a cached response could already exist.

This measures client processing, not a network-transfer or backend speedup. Diagnostic replay
can also parse the current live response before substituting the fixture. The phase timings
separate the substituted snapshot from that extra parse; timer gaps include all observed work.
Parent and child durations overlap and must not be added. Absolute development-build timings
are noisy on a shared host. JSON parsing still takes hundreds of milliseconds, and the remaining
model build is synchronous.

## Behavior and resource checks

- Android: opened/reopened the Changes sidebar, scrolled hundreds of lines down and back,
  scrolled horizontally, and closed the sidebar. [Recording](android-scroll.mp4), [screenshot](android.png).
  These follow-up rendering checks published the same frozen fixture directly into the client
  cache when the live subscription was pending; their timings are not part of the comparison.
- Native layout retained at most 143 cells and 143 paragraphs over these scroll windows;
  removing the diff unmounted its text layout and disposed every owned paragraph. Counts are in
  [native-resources.json](native-resources.json). This checks native resource ownership, not
  whole-app heap eviction or process RSS.
- Browser: both commit-history tests passed, including layout changes and closing/reopening
  a commit diff. Continuous-scroll pixel signatures matched stable renders, horizontal offsets
  remained independent, and repeated post-GC heap samples plateaued.
- A diagnostic continuation exercised all three presentations with pixel, geometry, and heap
  assertions: [unified](web-unified.png), [wrapped](web-wrapped.png), [split](web-split.png).
  Only the existing timing/commit assertions became soft assertions in the temporary copy;
  the repository's test and thresholds are unchanged. The diagnostic run reached all three
  presentations, then timed out during final trace/cleanup and reported an isolated-daemon
  project leak. It is not reported as a passing test.
- 116 targeted unit tests passed; full typecheck, lint, and format passed.
- iOS and Electron were not exercised in this Linux session.

## Existing browser stress-test failure

The opt-in `diff-performance.spec.ts` exceeds its 65 ms median-frame budget on both builds
at 6× CPU throttling: baseline warm cycles 83.2/84.8 ms, changed build 89.2/81.3 ms.
Both perform 237 React commits (budget 30). Pixel equality and heap plateau assertions pass.
See [before](browser-before.json) and [after](browser-after.json). These results do not establish
a browser scrolling speedup. Repeated browser scroll-state renders remain separate follow-up work.

Commands used:

```sh
PASEO_DIFF_PERF_E2E=1 E2E_RECORD_VIDEO=1 npm exec --workspace=@getpaseo/app -- playwright test --project=browser e2e/browser/diff-performance.spec.ts e2e/browser/commit-diff-panel.spec.ts -g 'bounded canvases|commit history'
npm run typecheck
npm run lint
npm run format
```

Raw traces, diagnostic scripts, failing-first test output, and full captures are retained locally
under `~/.paseo/diagnostics/mobile-diff-2026-09-09/`. No diagnostic instrumentation, replay payload,
protocol changes, or scheduler changes are part of the implementation.
