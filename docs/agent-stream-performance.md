# Agent stream performance

How assistant text gets from a provider to the screen, and why it is paced on the way. Read this before changing `packages/server/src/server/agent/agent-stream-coalescer.ts`, the reducer queue in `packages/app/src/timeline/session-stream-reducers.ts`, or the reveal in `packages/app/src/hooks/use-revealed-text.ts`.

For terminal output, which is a separate pipeline with separate budgets, see [terminal-performance.md](terminal-performance.md).

## The pipeline

```
provider deltas (every provider streams incrementally)
  → AgentStreamCoalescer (daemon, leading + trailing, ≤1 message per 60ms per agent)
  → recordTimeline: one canonical row per flushed item
  → agent_stream ws message
  → reducer queue (app, one commit per frame) → session store
  → source-item plugin transforms → native Markdown blocks / tool grouping
  → paced reveal (app, per displayed item) → paint
```

Every provider delivers incremental text, so there is no provider that needs special handling: Claude via `includePartialMessages`, Codex via `agent_message_delta`, ACP agents via `agent_message_chunk`, Pi and OMP via `text_delta`.

## Why the reveal is paced

Arrival is lumpy and there is no fixing that at the source. A 60ms coalescing window carries however many characters the model produced in those 60ms, which swings by an order of magnitude within a single turn. Painting each delta as it lands makes the size of those lumps visible, and that is what reads as jagged.

So arrival sets a _target_ and the reveal rate is derived from the backlog instead. A burst shortens the interval within the word cadence. A late frame releases one word, without spending missed frames as credit to show a group at once. Shrinking the coalescing window does not fix this — it makes the lumps smaller and more frequent, at the cost of message rate on a daemon loop that already contends with terminal frames and per-message relay encryption.

## Invariants

- **The coalescer is leading + trailing.** The first delta after an idle window flushes synchronously; only the rest of the burst waits for the trailing timer. Reverting to trailing-only adds a full window to the first character of every turn. Same shape and the same reason as `TerminalOutputCoalescer`.
- **The leading flush adds a canonical row, and that is fine.** A burst's first chunk lands as its own timeline row. `mergeAssistantChunks` / `mergeReasoningChunks` in `timeline-projection.ts` join contiguous same-turn rows, and clients read the projected timeline, so history is unaffected. Tests that assert on raw rows have to account for the extra row; tests that assert on what a client sees do not.
- **The store holds the full text; only the rendered slice is paced.** Copy, selection, the chat outline, and scroll geometry all read the same string the user can see. Pacing the store instead would leave the bottom anchor chasing a content height that is ahead of the reveal.
- **Markdown blocks belong to presentation.** `agent-stream/presentation.ts` retains completed native
  blocks and parses only the growing last block during append. Splitting in the reducer discards
  paragraph separators and exposes fragments to plugin callbacks, which need the whole source text.
- **First sight of a text is revealed whole.** Only growth is paced. This is what makes history hydration, timeline replay, a virtualized row remounting on scroll, and an already-finished message all render complete on first paint without a special case for each.
- **Completion releases an unfinished word.** Every platform drains queued words through the same pacing when the provider finishes; the last word also finishes fading.
- **The reducer queue commits on a frame, with a timer as the ceiling.** A frame callback never fires in a hidden tab, so a timer races it and wins when nothing is painting — the store has to keep advancing either way.
- **A history row re-renders only when its item or layout item identity changes.** The inverted
  FlatList hands every mounted cell a new `index` and `ref` whenever a row is prepended, so without a
  memo boundary each coalesced tick re-rendered every mounted row (about 50 on a phone, 100–250 ms of
  JS per tick). `layoutStream` keeps a layout item's identity when nothing about it changed,
  `useRevisedHistoryRows` hands a fresh item identity to rows whose tool-call group, expanded state,
  or breakpoint changed, and `HistoryStreamRow` memoizes on both. Every viewport runs its history
  through that hook; the web viewport once skipped it and history hosts of a live tool group went
  stale. A new field on `StreamLayoutItem` must be added to `areLayoutItemsEquivalent`, or sharing
  silently stops.

## Measuring

Word reveal lives in `packages/app/src/word-stream`. Native attribution and pinned
upstream revisions are in `packages/app/modules/paseo-word-stream/UPSTREAM.md`.

Judge the visible front across word boundaries at the recording's native frame
rate. No character should become more opaque than text before it in reading
order, and the front should not visibly change speed at word boundaries.
Sampling at 100 ms hid the previous defect: later letters appeared before earlier
letters, leaving holes that read as flashing words during playback.

Exercise provisional Markdown and recycled views when checking fade-once behavior.
A table forming or inline formatting closing can change the rendered structure
without making previously visible text new again.

On native, text and its fade metadata must become visible together. An earlier
implementation sent metadata asynchronously and flashed new text fully opaque
for one frame before dimming it. Preserve native layout, selection, and inline
styles, and keep animation ticks off the JS thread. Do not remove the animation
host's layout box with `display: contents`: RN forcibly flattens it and removes
the native animation owner. iOS table cells receive pacing without opacity
animation; include that limit in platform QA reports.

Compare release APKs on the same Android device with the mock `bursty-stream`
provider, identical prompts, fresh conversations, and equal sampling windows.
Collect `agent-device perf frames` and `perf memory sample`; keep screen recording
out of the timed runs. Software-rendered emulator results are comparative
evidence, not physical-device frame-rate guarantees. Native instrumentation
tests in the module check pixels, append/replacement behavior, and cleanup.

- **Smoothness (user-perceived):** `packages/app/e2e/browser/agent-stream-smoothness.spec.ts`, gated behind `PASEO_AGENT_STREAM_PERF_E2E=1`. Drives the mock provider's `bursty-stream` model and reports coefficient of variation of characters painted per frame (smoothness) plus p95 gap between visible updates (stalls). Both numbers are needed: a stalled stream is perfectly smooth.
- **Reproducing bursty arrival:** the `bursty-stream` model in `mock-load-test-agent.ts` emits uneven runs of tokens separated by idle gaps. Burst sizes come from a seeded generator, so a run repeats exactly.
- **Rate policy in isolation:** `packages/app/src/word-stream/internal/model.test.ts` checks the shared word scheduler without a renderer.
- **Fade behavior:** `word-stream-fade.spec.ts` checks web direction, layout stability, selection, and tail cleanup. Native tests in `modules/paseo-word-stream` drive the host view React mounts with the same range props the bridge sends, advance frame time through the host's injected frame clock, and check rendered pixels and animation completion on Android and iOS.

Historical character-reveal baseline (2026-08, Expo web against a local dev daemon, real Claude Haiku agent, ~8.5s samples during active streaming). The paint-on-arrival column disabled the former reveal horizon:

|                                  | paint on arrival | paced |
| -------------------------------- | ---------------- | ----- |
| frames that advanced the text    | 6%               | 87%   |
| chars-per-frame CV               | 4.11             | 1.86  |
| gap between visible updates, p50 | 317ms            | 17ms  |
| gap between visible updates, p95 | 383ms            | 17ms  |

Total characters painted is roughly the same either way — the reveal changes when they land, not how many arrive.

Measure the **total** length across every `assistant-message` element, not the last one. A turn emits many assistant messages, so the tail element keeps changing identity and its length is not monotonic; sampling only the tail reads those handovers as resets and reports almost no growth. `sampleStreamFrames` does this correctly.
