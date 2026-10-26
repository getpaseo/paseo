#!/usr/bin/env npx tsx

/**
 * Follow commands stop when nobody reads their output
 *
 * `paseo agent logs --follow` and `paseo agent attach` stream until they are
 * stopped. A program that closes its end of their stdout, as `| head` or a
 * launcher that discards output does, stops them the same way Ctrl+C does.
 */

import assert from "node:assert";
import { connectToDaemon } from "../src/utils/client.ts";
import { runPaseoCli, startTestDaemon } from "./helpers/test-daemon.ts";

console.log("=== Follow Commands With Closed Stdout Tests ===\n");

const daemon = await startTestDaemon();
const host = `127.0.0.1:${daemon.port}`;

try {
  // An agent created without a prompt stays idle, so no provider is called.
  const client = await connectToDaemon({ target: { kind: "endpoint", host } });
  const agent = await client.createAgent({
    provider: "claude",
    cwd: daemon.workDir,
    title: "closed stdout",
  });
  await client.close();

  for (const args of [
    ["agent", "logs", agent.id, "--follow"],
    ["agent", "attach", agent.id],
  ]) {
    const label = `paseo ${args.slice(0, 2).join(" ")}`;
    console.log(`Test: ${label} exits when its stdout reader is gone`);
    const result = await runPaseoCli(daemon, [...args, "--host", host], {
      closedStdout: true,
      timeout: 20_000,
    });

    assert.strictEqual(result.stderr, "", `${label} should exit quietly`);
    assert.strictEqual(result.exitCode, 0, `${label} should exit with code 0`);
    console.log(`✓ ${label} exits when its stdout reader is gone\n`);
  }
} finally {
  await daemon.stop();
}

console.log("=== All follow commands with closed stdout tests passed ===");
