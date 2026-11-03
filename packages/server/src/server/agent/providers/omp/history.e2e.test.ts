import { measureMainThreadWork } from "../../../../test-utils/main-thread-work.js";
import { BUILTIN_PROVIDER_IDS } from "@getpaseo/protocol/provider-manifest";
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { expect, test } from "vitest";
import { createTestPaseoDaemon } from "../../../test-utils/paseo-daemon.js";
import { DaemonClient } from "../../../test-utils/daemon-client.js";
import { readActiveOmpEntryChain } from "./history.js";

test("replays selected OMP history without blocking the event loop", async () => {
  const directory = await mkdtemp(join(tmpdir(), "omp-history-budget-"));
  const sessionFile = join(directory, "session.jsonl");
  const started = performance.now();
  try {
    const daemon = await createTestPaseoDaemon({
      // This regression exercises file replay and daemon requests, not executable discovery.
      providerOverrides: Object.fromEntries(
        BUILTIN_PROVIDER_IDS.map((id) => [id, { enabled: false }]),
      ),
    });
    const client = new DaemonClient({
      url: `ws://127.0.0.1:${daemon.port}/ws`,
      appVersion: "0.13.2",
    });
    try {
      await client.connect();
      await client.fetchAgents({ subscribe: {} });
      await client.getDaemonStatus();
      const file = await open(sessionFile, "w");
      // Structured message blocks expose document-sized parsing at a modest byte size.
      // Replay an earlier active entry so inactive payload retention cannot drive the probe.
      const text = Array.from({ length: 64 }, () => ({ type: "text", text: "x" }));
      let bytes = 0;
      let count = 0;
      try {
        while (bytes < 28 * 1024 * 1024) {
          const line =
            JSON.stringify({
              type: "message",
              id: `row-${count}`,
              parentId: count ? `row-${count - 1}` : null,
              message: { role: "user", content: text },
            }) + "\n";
          bytes += Buffer.byteLength(line);
          await file.write(line);
          count++;
        }
      } finally {
        await file.close();
      }
      let repliesDuringReplay = 0;
      const { result: replayedEntries, blockingMs } = await measureMainThreadWork(
        "OMP history main-thread work",
        async () => {
          const replayState = { finished: false };
          const replay = readActiveOmpEntryChain(sessionFile, "row-0").finally(() => {
            replayState.finished = true;
          });
          // A real WebSocket RPC served by the isolated daemon on the same event loop.
          const requests = (async () => {
            while (!replayState.finished) {
              await client.getDaemonStatus();
              if (!replayState.finished) repliesDuringReplay++;
              await delay(10);
            }
          })();
          const [entries] = await Promise.all([replay, requests]);
          return entries;
        },
      );
      console.log(
        JSON.stringify({
          bytes,
          count,
          blockingMs,
          repliesDuringReplay,
          generationAndLoadMs: performance.now() - started,
        }),
      );
      expect(replayedEntries).toEqual([
        {
          type: "message",
          id: "row-0",
          parentId: null,
          message: { role: "user", content: text },
        },
      ]);
      expect(blockingMs).toBeLessThan(50);
      expect(repliesDuringReplay).toBeGreaterThan(0);
    } finally {
      await client.close().finally(() => daemon.close());
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 30000);
