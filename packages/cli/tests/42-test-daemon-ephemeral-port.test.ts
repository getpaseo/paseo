#!/usr/bin/env npx tsx

import assert from "node:assert/strict";
import { startTestDaemon, runPaseoCli } from "./helpers/test-daemon.ts";

// Port zero leaves allocation to the listening daemon, with no reserve/release gap.
const daemon = await startTestDaemon({ port: 0 });
try {
  assert(daemon.port > 0, "the helper returns the port the daemon actually bound");
  assert.equal(daemon.wsUrl, `ws://127.0.0.1:${daemon.port}`);
  const result = await runPaseoCli(daemon, ["agent", "ls", "--host", daemon.wsUrl, "--json"]);
  assert.equal(result.exitCode, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), []);
} finally {
  await daemon.stop();
}
