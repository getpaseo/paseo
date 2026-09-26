#!/usr/bin/env npx tsx

import assert from "node:assert";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    assert.match(status.note, /Password required/i);
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
    assert.match(status.note, /Incorrect password/i);
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

// POSIX executable probing executes --version; Windows resolves executables differently.
if (process.platform !== "win32") {
  const root = await mkdtemp(join(tmpdir(), "paseo status slow provider "));
  const home = join(root, "daemon");
  const workDir = join(root, "work");
  const provider = join(root, "slow-provider");
  const marker = join(root, "availability.log");
  let slowDaemon: Awaited<ReturnType<typeof startTestDaemon>> | undefined;
  try {
    await mkdir(home);
    await mkdir(workDir);
    await writeFile(
      provider,
      `#!${process.execPath}
import('node:fs').then(({appendFileSync}) => {
  appendFileSync(${JSON.stringify(marker)}, JSON.stringify(process.argv.slice(2)) + "\\n");
  setTimeout(() => console.log('provider 1.0.0'), 1800);
});
`,
      { mode: 0o700 },
    );
    await writeFile(
      join(home, "config.json"),
      JSON.stringify({
        version: 1,
        agents: { providers: { claude: { command: { mode: "replace", argv: [provider] } } } },
      }),
    );
    slowDaemon = await startTestDaemon({
      paseoHome: home,
      workDir,
      env: { PASEO_PASSWORD: "shared-secret" },
    });
    console.log("Test 4: local status separates authenticated reachability from slow details");
    const local = await runLocalPaseo(["daemon", "status", "--home", home, "--json"], {
      PASEO_PASSWORD: "shared-secret",
    });
    assert.strictEqual(local.exitCode, 0, local.stderr);
    const status = JSON.parse(local.stdout);
    assert.strictEqual(status.localDaemon, "running");
    assert.strictEqual(status.connectedDaemon, "reachable", JSON.stringify(status));
    assert.strictEqual(typeof status.serverId, "string");
    assert.match(status.note, /DAEMON_REQUEST_TIMEOUT/);
    assert.match(status.note, /Status details unavailable/);
    assert(!("workerPid" in status), "must not invent worker facts");
    assert(!("providers" in status), "must not invent provider facts");
    assert.match(
      await readFile(marker, "utf8"),
      /\["--version"\]/,
      "the public provider executable was actually probed",
    );
    console.log("✓ local authenticated connection remains reachable when details time out\n");

    console.log("Test 5: explicit endpoint status remains an error when details time out");
    const remote = await runLocalPaseo(
      ["daemon", "status", "--host", `127.0.0.1:${slowDaemon.port}`, "--json"],
      { PASEO_PASSWORD: "shared-secret" },
    );
    assert.notStrictEqual(remote.exitCode, 0);
    const { error } = JSON.parse(remote.stderr);
    assert.strictEqual(error.code, "DAEMON_REQUEST_TIMEOUT");
    assert.match(error.message, /Status details unavailable/);
    assert.strictEqual(error.details.connectedDaemon, "reachable");
    assert.strictEqual(error.details.serverId, status.serverId);
    assert(!("home" in error.details), "endpoint observation must not invent local ownership");
    assert(!("workerPid" in error.details));
    assert(!("providers" in error.details));
    console.log("✓ failed remote query retains its error and authenticated connection fact\n");
  } finally {
    await slowDaemon?.stop();
    await rm(root, { recursive: true, force: true });
  }
}

console.log("=== Daemon Status Auth Tests Passed ===");
