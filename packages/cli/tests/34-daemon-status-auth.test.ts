#!/usr/bin/env npx tsx

import assert from "node:assert";
import { runLocalPaseo } from "./helpers/local-cli.ts";
import { startTestDaemon } from "./helpers/test-daemon.ts";

console.log("=== Daemon Status Auth ===\n");

const daemon = await startTestDaemon({
  env: { PASEO_PASSWORD: "shared-secret" },
});

try {
  {
    console.log("Test 1: status reports password requirement without marking daemon unreachable");
    const result = await runLocalPaseo(["daemon", "status", "--json"], {
      PASEO_HOME: daemon.paseoHome,
      PASEO_HOST: "",
      PASEO_PASSWORD: "",
    });

    assert.strictEqual(result.exitCode, 0, "status should still succeed");
    const status = JSON.parse(result.stdout);

    assert.strictEqual(status.localDaemon, "running");
    assert.strictEqual(status.connectedDaemon, "auth_required");
    assert(!("runningAgents" in status), "status should not fetch agent counts");
    assert(!("idleAgents" in status), "status should not fetch agent counts");
    assert.match(status.note, /requires a password/i);
    assert.doesNotMatch(status.note, /not reachable/i);
    console.log("✓ missing password reports auth_required\n");
  }

  {
    console.log("Test 2: status reports rejected supplied password separately");
    const result = await runLocalPaseo(["daemon", "status", "--json"], {
      PASEO_HOME: daemon.paseoHome,
      PASEO_HOST: "",
      PASEO_PASSWORD: "wrong-secret",
    });

    assert.strictEqual(result.exitCode, 0, "status should still succeed");
    const status = JSON.parse(result.stdout);

    assert.strictEqual(status.localDaemon, "running");
    assert.strictEqual(status.connectedDaemon, "auth_failed");
    assert.match(status.note, /password was rejected/i);
    assert.doesNotMatch(status.note, /not reachable/i);
    console.log("✓ wrong password reports auth_failed\n");
  }

  {
    console.log("Test 3: status reaches the same daemon when password is supplied");
    const result = await runLocalPaseo(["daemon", "status", "--json"], {
      PASEO_HOME: daemon.paseoHome,
      PASEO_HOST: "",
      PASEO_PASSWORD: "shared-secret",
    });

    assert.strictEqual(result.exitCode, 0, "status should succeed with password");
    const status = JSON.parse(result.stdout);

    assert.strictEqual(status.localDaemon, "running");
    assert.strictEqual(status.connectedDaemon, "reachable");
    assert(!("runningAgents" in status), "status should not fetch agent counts");
    assert(!("idleAgents" in status), "status should not fetch agent counts");
    console.log("✓ password-authenticated status remains reachable\n");
  }
} finally {
  await daemon.stop();
}

console.log("=== Daemon Status Auth Tests Passed ===");
