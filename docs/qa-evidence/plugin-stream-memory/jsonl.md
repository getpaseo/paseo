# Large JSONL allocation regression

Pi image-bearing tool results and `agent_end` events can be multi-megabyte ordinary JSONL frames. Searching the entire concatenated prefix for a newline on every stdout chunk repeatedly flattens that prefix. The decoder now scans each incoming chunk and joins the line once, without changing ordinary JSONL or V2 chunk semantics.

The regression in the existing `jsonl-frame-decoder.test.ts` suite runs the real decoder in a fresh Node process with allocation sampling (including collected objects). A 4 MiB image plus Chinese/emoji, delivered in 16 KiB chunks, allocated **1,103,204,912 bytes before**, exceeding the 50,332,716 byte budget. Afterward the standalone fixture allocated **25,270,264 bytes**. Retained heap alone would miss this temporary allocation problem. The six decoder tests also cover Unicode across fragments, empty writes, split CRLF, multiple and unfinished lines, invalid-line recovery, and fragmented V2 reassembly.

## Same-runtime comparison

Same installed Electron Helper, separate process per run, three repeats of each case. Before imports the currently installed pre-fix decoder; after imports the built PR decoder. Both receive the same synthetic image-bearing `agent_end` line, 26,151,450 image characters, in 64 KiB pieces, yielding between writes. No model requests, production inspector, forced production GC, or daemon restarts. Payloads are synthetic; no session content or image data is included.

Median of three runs (raw runs: [jsonl-comparison.json](jsonl-comparison.json)):

| Payload text  | Before allocated MiB | After allocated MiB | Peak heap increase MiB before → after | Elapsed ms before → after |
| ------------- | -------------------: | ------------------: | ------------------------------------: | ------------------------: |
| ASCII         |              5062.64 |               75.32 |                        222.78 → 25.11 |            741.70 → 23.97 |
| Chinese/emoji |             10099.89 |              125.11 |                        434.52 → 50.24 |           1437.73 → 45.90 |

Allocation is the sampling estimate of **cumulative allocations**, including collected objects, not simultaneously live heap. Isolated peak heap increase is relative to the process baseline, sampled between writes. It does not reproduce the exact 1.6 GiB production peak or prove its complete attribution. Results depend on GC and runtime. This is an allocation reduction per frame, not a MiB/hour result.

## Reproduce

From the repository root after `npm run build:server`:

```sh
cd packages/server
npx vitest run src/server/agent/providers/jsonl-frame-decoder.test.ts --bail=1
cd ../..
node --expose-gc docs/qa-evidence/plugin-stream-memory/jsonl-benchmark.mjs "file://$PWD/packages/server/dist/server/server/agent/providers/jsonl-frame-decoder.js"
```

Run the same benchmark against a pre-fix build in a fresh process to compare. `WIDE_TEXT=0` selects ASCII, `FRAME_CHARS` and `CHUNK_CHARS` override workload sizes; `PROFILE_OUT` saves an allocation sampling profile. The committed output was measured with Electron's embedded Node (see runtime versions in the JSON). `jsonl-red.txt` and `jsonl-green.txt` record the failing and passing source tests. `jsonl-build.txt`, `jsonl-typecheck.txt`, `jsonl-lint.txt`, and `jsonl-format.txt` retain actual check output.

macOS Apple Silicon was measured locally. Windows/Linux runtime coverage depends on official CI for this commit. There are no client UI, wire schema, pagination, history truncation, or restart-recovery changes in this addition.
