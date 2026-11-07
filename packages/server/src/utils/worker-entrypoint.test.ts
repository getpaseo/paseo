import { once } from "node:events";
import { Worker } from "node:worker_threads";
import { describe, expect, test } from "vitest";

import { expandTilde } from "./path.js";
import { resolveWorkerEntrypoint } from "./worker-entrypoint.js";

describe("worker entrypoint", () => {
  test("starts a compiled worker from its own URL", () => {
    const entry = resolveWorkerEntrypoint(
      new URL("file:///app/dist/server/server/plugins/compiler-worker.js"),
    );

    expect({ ...entry, entrypoint: String(entry.entrypoint) }).toEqual({
      entrypoint: "file:///app/dist/server/server/plugins/compiler-worker.js",
      eval: false,
    });
  });

  test("runs a TypeScript worker, with its .js imports, through tsx", async () => {
    const entry = resolveWorkerEntrypoint(
      new URL("./test-fixtures/expand-tilde-worker.ts", import.meta.url),
    );
    const worker = new Worker(entry.entrypoint, {
      eval: entry.eval,
      execArgv: [],
      workerData: "~/project",
    });

    const [expanded] = await once(worker, "message");

    expect(expanded).toBe(expandTilde("~/project"));
  });
});
