#!/usr/bin/env npx tsx

import assert from "node:assert";
import { runPaseoCli, startTestDaemon } from "./helpers/test-daemon.ts";

console.log("=== Unknown Agent ID Tests ===\n");

const daemon = await startTestDaemon();

async function expectAgentNotFound(command: string[]) {
  const result = await runPaseoCli(daemon, [
    ...command,
    "does-not-exist",
    "--host",
    `127.0.0.1:${daemon.port}`,
    "--json",
  ]);
  assert.notStrictEqual(result.exitCode, 0, `${command.join(" ")} should fail`);
  const { error } = JSON.parse(result.stderr);
  assert.strictEqual(error.code, "AGENT_NOT_FOUND", result.stderr);
  assert.match(error.details, /paseo ls/);
}

try {
  {
    console.log("Test 1: delete reports AGENT_NOT_FOUND for an unknown ID");
    await expectAgentNotFound(["agent", "delete"]);
    console.log("✓ delete reports AGENT_NOT_FOUND\n");
  }

  {
    console.log("Test 2: stop reports AGENT_NOT_FOUND for an unknown ID");
    await expectAgentNotFound(["agent", "stop"]);
    console.log("✓ stop reports AGENT_NOT_FOUND\n");
  }
} finally {
  await daemon.stop();
}

console.log("=== All unknown agent ID tests passed ===");
