#!/usr/bin/env npx tsx

import assert from "node:assert";
import { runLocalPaseo } from "./helpers/local-cli.ts";
import { startTestDaemon } from "./helpers/test-daemon.ts";

console.log("=== Daemon Auth Command Errors ===\n");

const daemon = await startTestDaemon({
  env: { PASEO_PASSWORD: "shared-secret" },
});

async function lsError(password: string) {
  const result = await runLocalPaseo(["ls", "--json"], {
    PASEO_HOME: daemon.paseoHome,
    PASEO_HOST: "",
    PASEO_PASSWORD: password,
  });
  assert.notStrictEqual(result.exitCode, 0, "ls should fail without a valid password");
  return JSON.parse(result.stderr).error as {
    code: string;
    message: string;
    details: string;
  };
}

try {
  {
    console.log("Test 1: missing password asks for PASEO_PASSWORD, not a daemon start");
    const error = await lsError("");
    assert.strictEqual(error.code, "AUTH_REQUIRED");
    assert.match(error.message, /Password required/);
    assert.match(error.details, /PASEO_PASSWORD/);
    assert.doesNotMatch(error.details, /daemon start/);
    console.log("✓ missing password points at PASEO_PASSWORD\n");
  }

  {
    console.log("Test 2: wrong password asks for PASEO_PASSWORD, not a daemon start");
    const error = await lsError("wrong-secret");
    assert.strictEqual(error.code, "AUTH_FAILED");
    assert.match(error.message, /Incorrect password/);
    assert.match(error.details, /PASEO_PASSWORD/);
    assert.doesNotMatch(error.details, /daemon start/);
    console.log("✓ wrong password points at PASEO_PASSWORD\n");
  }
} finally {
  await daemon.stop();
}

console.log("=== Daemon Auth Command Errors Tests Passed ===");
