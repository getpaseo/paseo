# Terminal performance

How terminal output stays low-latency, what the invariants are, and how to measure before/after any change to the pipeline. Read this before touching anything under `packages/server/src/terminal/` or `packages/app/src/terminal/runtime/`.

## The pipeline

```
pty (node-pty, forked worker process)
  → headless xterm parse (worker, snapshot fidelity)
  → TerminalOutputCoalescer (worker, ≤1 IPC message per 5ms per terminal)
  → process.send IPC → daemon main process
  → TerminalOutputCoalescer (per client stream, terminal-session-controller.ts)
  → binary ws frame (2-byte header + raw bytes)
  → client decode (daemon-client.ts) → stream router → emulator runtime
  → xterm.write (back-to-back; xterm batches internally)
```

Terminal frames share the daemon main event loop with all agent traffic. The `eventLoopDelay` block in the `ws_runtime_metrics` log line (every 30s in `daemon.log`) is the ground truth for "the daemon is busy" — p99/max there directly bound worst-case terminal frame delay.

## Invariants (the easy-to-break ones)

- **Coalescers are leading+trailing throttles.** The first chunk after an idle window flushes immediately (synchronously); only sustained bursts wait for the trailing timer. Reverting to trailing-only adds a full window (~5ms) to every keystroke echo.
- **Output coalescing happens in the worker, before IPC.** One `process.send` per pty chunk was a main-loop flood under build output. Non-output messages (snapshot/snapshotReady/titleChange/exit) must flush the coalescer first so ordering is preserved.
- **Coalesced output carries the LAST chunk's revision.** Snapshot replay dedup (`replayTerminalOutputAfterSnapshot`) skips buffered output with `revision <= replayRevision`; a merged batch with a lower revision would be wrongly skipped (lost output).
- **The input-mode tracker runs once per process boundary, not per hop.** The worker owns the authoritative tracker; the daemon caches the replay preamble from `getTerminalState` responses and `snapshotReady` messages. Do not reintroduce a per-chunk `feed()` on the daemon main loop.
- **Snapshot catch-up is backpressure-gated.** A stream falls back to a full snapshot only when `outputBytesSinceSnapshot > MAX_TERMINAL_OUTPUT_FRAME_BYTES` (256KB) **and** the client transport reports `bufferedAmount > MAX_CLIENT_BUFFERED_BYTES` (4MB). A client that keeps draining streams continuously, no matter how much output is produced. Before this gate existed, every 256KB of build output dropped a frame and forced a full JSON cell-grid snapshot (~200k objects across IPC) — the historical source of spiky lag and GC hitches.
- **Client output writes are not serialized per frame.** The emulator runtime drains contiguous plain writes straight into xterm (which buffers internally). Only barrier ops (`clear`, `snapshot`, `suppressInput` writes) wait — behind a zero-length sentinel write — so resets can't interleave with in-flight output.

## Measuring

- **Node-only benchmark (fast iteration, server pipeline):** `npx tsx scripts/benchmark-terminal-latency.ts`. Boots an isolated daemon (fresh `PASEO_HOME`, random port — never 6767), measures echo latency percentiles, burst jitter, and snapshot counts under ramped mock-agent load. Writes JSON to `/tmp/paseo-terminal-bench/`. Healthy numbers (2026-06): echo p50 ~2.3ms, p95 ~3.3ms, a 2MB burst fully streamed with `snap=0`.
- **Browser perf specs (user-perceived path):** gated behind `PASEO_TERMINAL_PERF_E2E=1` —
  `packages/app/e2e/terminal-performance.spec.ts` and `packages/app/e2e/terminal-keystroke-stress.spec.ts` (per-stage keydown→xterm-commit breakdown under mock-agent load). Healthy: keydown→commit p50 ~18ms under 600-key burst.
- **Production:** grep `daemon.log` for `ws_runtime_metrics` and read `eventLoopDelay` + `bufferedAmount`.

## Known remaining contention (follow-up candidates)

- A single large `agent_stream` message (e.g. a 250KB diff payload) measurably delays terminal echo (~100ms-class dips) — cost is split between daemon serialization and app-side parse/render on the shared browser main thread.
- Relay-attached clients pay pure-JS tweetnacl encryption + base64 per frame on the daemon main loop (`packages/relay/src/encrypted-channel.ts`).
- `sendToClient` re-stringifies session messages per socket; only matters for multi-socket connections.
