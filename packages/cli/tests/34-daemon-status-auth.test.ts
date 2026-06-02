#!/usr/bin/env npx tsx

import assert from "node:assert";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createTestPaseoDaemon } from "../../server/src/server/test-utils/paseo-daemon.ts";
import { runLocalPaseo } from "./helpers/local-cli.ts";

console.log("=== Daemon Status Auth ===\n");

const CORRECT_PASSWORD_HASH = "$2b$12$GMhF7pN4QnMlHOQXOqjd1OitKWPSmAO3FwB0PHzKtcZR/sAMryz76";

const daemon = await createTestPaseoDaemon({
  auth: { password: CORRECT_PASSWORD_HASH },
});

try {
  await writeFile(
    join(daemon.paseoHome, "paseo.pid"),
    `${JSON.stringify(
      {
        pid: process.pid,
        startedAt: new Date().toISOString(),
        hostname: "status-auth-test",
        uid: process.getuid?.(),
        listen: `0.0.0.0:${daemon.port}`,
      },
      null,
      2,
    )}\n`,
  );

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
    assert.strictEqual(status.runningAgents, null);
    assert.strictEqual(status.idleAgents, null);
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
    assert.strictEqual(status.runningAgents, 0);
    assert.strictEqual(status.idleAgents, 0);
    console.log("✓ password-authenticated status remains reachable\n");
  }
} finally {
  await daemon.close();
}

console.log("=== Daemon Status Auth Tests Passed ===");
