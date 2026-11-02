# Terminal performance

How terminal output stays low-latency, what the invariants are, and how to measure before/after any change to the pipeline. Read this before touching anything under `packages/server/src/terminal/` or `packages/app/src/terminal/runtime/`.

## The pipeline

```
pty (node-pty, forked worker process)
  → headless xterm parse (worker, ANSI replay fidelity)
  → TerminalOutputCoalescer (worker, ≤1 socket frame per 5ms per terminal)
  → framed local socket → daemon main process
  → TerminalOutputCoalescer (per client stream, terminal-session-controller.ts)
  → binary ws frame (2-byte header + raw bytes)
  → client decode (daemon-client.ts) → stream router → emulator runtime
  → xterm.write (back-to-back; xterm batches internally)
```

Terminal frames share the daemon main event loop with all agent traffic. The `eventLoopDelay` block in the `ws_runtime_metrics` log line (every 30s in `daemon.log`) is the ground truth for "the daemon is busy" — p99/max there directly bound worst-case terminal frame delay.

## Invariants (the easy-to-break ones)

- **Replay is incremental across the daemon and SDK.** Capable clients request their configured history, bounded by [worker retention](terminal-worker.md#process-model). Older apps retain their own 200-row request. Explicit SDK history demand is unchanged against older ANSI hosts, which apply their existing 500-row ceiling. Begin resets once, chunks keep a streaming UTF-8 decoder/parser, and each renderer suppresses generated replies while parsing replay. Never concatenate capable replay chunks to feed the renderer.
- **Replay serialization reads xterm directly.** The [worker](terminal-worker.md#process-model) uses its existing buffer; text capture translates only the requested rows, and readiness scans row strings. Do not rebuild a full cell-object grid. Serialization still allocates a whole ANSI string and UTF-8 bytes before bounded delivery; chunking does not bound those allocations.
- **Coalescers are leading+trailing throttles.** The first chunk after an idle window flushes immediately (synchronously); only sustained bursts wait for the trailing timer. Reverting to trailing-only adds a full window (~5ms) to every keystroke echo.
- **Output coalescing happens in the worker, before IPC.** One socket frame per pty chunk was a main-loop flood under build output. Non-output messages (snapshotReady/titleChange/exit) must flush the coalescer first so ordering is preserved.
- **Replay delivery is isolated per viewer.** Live worker output never waits for app delivery. Each daemon stream owns its bounded live tail and revision deduplication; a slow or failed replay cannot pause another viewer of the same terminal.
- **Replay geometry belongs to the parser queue.** Native measurements and web fits must leave the captured dimensions intact through every chunk's commit. Apply the latest measured size after replay, before live bytes; clear, replacement and disposal must release that geometry ownership. A layout effect must not resize the renderer directly during replay.
- **Coalesced output carries the LAST chunk's revision.** Snapshot replay dedup (`replayTerminalOutputAfterSnapshot`) skips buffered output with `revision <= replayRevision`; a merged batch with a lower revision would be wrongly skipped (lost output).
- **The input-mode tracker runs once per process boundary, not per hop.** The worker commits its authoritative tracker with xterm parsing before publishing the corresponding revision; the daemon caches current modes from ordered worker events and adoption. A replay response carries capture-time modes for its viewer; it must not overwrite the shared cache after newer live output. Apply that viewer's preamble before its buffered live bytes. Do not reintroduce a per-chunk `feed()` on the daemon main loop.
- **Snapshot catch-up is backpressure-gated.** After more than 256 KiB of output, a stream catches up only when its transport reports more than 4 MiB queued, or exposes no backpressure reading. A draining client streams continuously. Pressure recovery sends at most 500 recent history rows plus the screen, preserving smaller explicit demands including zero; even a live-only subscription needs this resynchronization. It does not change the subscription's configured demand: later attach/reconnect restores still request the full configured history. The recent window avoids repeatedly serializing all retained history for a slow viewer.
- **Plugin daemon sessions report IPC queue bytes.** Their virtual socket increments `bufferedAmount` before `process.send` and decrements it only in the send callback. Text and binary frames share that ordered queue, so the normal snapshot catch-up and physical high-water gates remain valid for server-side plugin SDK traffic.
- **Client output writes are not serialized per frame.** The emulator runtime drains contiguous plain writes straight into xterm (which buffers internally). Only barrier ops (`clear`, `snapshot`, `suppressInput` writes) wait — behind a zero-length sentinel write — so resets can't interleave with in-flight output.
- **Find preserves the inspected xterm viewport, including at the live bottom.** Keep its output anchor inside the existing batched write path. Serializing output to preserve a search result would add terminal latency.
- **Retained terminal tabs in the focused workspace keep their streams.** Hidden mounted terminals continue applying output, so switching tabs does not resubscribe or request a fresh snapshot. The retained-panel LRU bounds the number of live streams; terminals in an unfocused workspace detach.
- **Terminal size has one daemon-owned claimant.** Focus and direct interaction send a `claim`; later geometry changes from that connection send `update`. A claim transfers ownership even when the dimensions are unchanged, while an update from any other connection is ignored. This lets an owning pane follow splits and keyboard insets without allowing an idle phone or browser to steal the PTY size.

## Measuring

- **Node-only benchmark (fast iteration, server pipeline):** `npx tsx scripts/benchmark-terminal-latency.ts`. Boots an isolated daemon (fresh `PASEO_HOME`, random port — never 6767), measures echo latency percentiles, burst jitter, and snapshot counts under ramped mock-agent load. Writes JSON to `/tmp/paseo-terminal-bench/`. Healthy numbers (2026-06): echo p50 ~2.3ms, p95 ~3.3ms, a 2MB burst fully streamed with `snap=0`.
- **Browser perf specs (user-perceived path):** gated behind `PASEO_TERMINAL_PERF_E2E=1` —
  `packages/app/e2e/browser/terminal-performance.spec.ts` and `packages/app/e2e/browser/terminal-keystroke-stress.spec.ts` (per-stage keydown→xterm-commit breakdown under mock-agent load). Healthy: keydown→commit p50 ~18ms under 600-key burst.
- **Production:** grep `daemon.log` for `ws_runtime_metrics` and read `eventLoopDelay` + `bufferedAmount`.
- **Git pressure:** the same log line includes `git.commands` (limiter occupancy, queue age,
  queue wait, execution time, failures, timeouts, and top operations),
  `git.workspaceService` (daemon-global Git observer ownership), and per-session workspace Git
  subscription totals under `runtime`. Queue wait and execution time are separate because the Git
  command timeout begins only after a command acquires a limiter slot.

## Known remaining contention (follow-up candidates)

- A single large `agent_stream` message (e.g. a 250KB diff payload) measurably delays terminal echo (~100ms-class dips) — cost is split between daemon serialization and app-side parse/render on the shared browser main thread. See [agent-stream-performance.md](agent-stream-performance.md) for that pipeline's own budgets.
- Relay-attached clients pay pure-JS tweetnacl encryption on the daemon main loop (`packages/relay/src/encrypted-channel.ts`). Negotiated binary application frames stay binary ciphertext and avoid base64 encode/decode; text and mixed-version traffic remain base64 WebSocket text frames.
- `sendToClient` re-stringifies session messages per socket; only matters for multi-socket connections.
