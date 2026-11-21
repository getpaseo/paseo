#!/usr/bin/env npx tsx

import assert from "node:assert";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BUILTIN_PROVIDER_IDS } from "@getpaseo/protocol/provider-manifest";
import { hashDaemonPassword } from "@getpaseo/server/auth";
import { acquirePidLock, releasePidLock } from "../../server/src/server/pid-lock.js";
import { createTestPaseoDaemon } from "../../server/dist/server/server/test-utils/paseo-daemon.js";
import {
  terminalCleanupRecordPath,
  writeTerminalCleanupRecord,
  type TerminalCleanupUnresolved,
} from "../../server/src/terminal/terminal-worker-record.js";
import { runLocalPaseo } from "./helpers/local-cli.ts";
import { startTestDaemon } from "./helpers/test-daemon.ts";

console.log("=== Daemon Status Auth ===\n");

const fixtureRoot = await mkdtemp(join(tmpdir(), "paseo-cli-status-"));
const paseoHome = join(fixtureRoot, ".paseo");
const fixtureWorkDir = join(fixtureRoot, "work");
const previousHome = process.env.HOME;
const previousUserProfile = process.env.USERPROFILE;
let fixture: Awaited<ReturnType<typeof createTestPaseoDaemon>> | undefined;
const cliEntry = join(import.meta.dirname, "..", "dist", "index.js");

interface DiagnosticCliInput {
  args: string[];
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

interface DiagnosticCliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

// Execute argv directly: a Windows Node path must not pass through Bash string quoting.
function runDiagnosticCli(input: DiagnosticCliInput): Promise<DiagnosticCliResult> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [cliEntry, ...input.args],
      {
        cwd: fixtureWorkDir,
        env: {
          ...Object.fromEntries(
            Object.entries(process.env).filter(([key]) => !key.startsWith("PASEO_")),
          ),
          PASEO_HOME: paseoHome,
          ...input.env,
          HOME: fixtureRoot,
          USERPROFILE: fixtureRoot,
        },
        encoding: "utf8",
        timeout: input.timeoutMs ?? 30_000,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ exitCode: 0, stdout, stderr });
        } else if (!error.killed && typeof error.code === "number") {
          resolve({ exitCode: error.code, stdout, stderr });
        } else {
          reject(error);
        }
      },
    );
  });
}

const providers = Object.fromEntries(
  BUILTIN_PROVIDER_IDS.map((provider) => [
    provider,
    {
      enabled: false,
      command: { mode: "replace", argv: [join(paseoHome, "missing-provider")] },
    },
  ]),
);
try {
  process.env.HOME = fixtureRoot;
  process.env.USERPROFILE = fixtureRoot;
  await mkdir(paseoHome);
  await mkdir(fixtureWorkDir);
  const password = hashDaemonPassword("shared-secret");
  await writeFile(
    join(paseoHome, "config.json"),
    JSON.stringify({
      version: 1,
      daemon: {
        listen: "127.0.0.1:0",
        auth: { password },
        relay: { enabled: false },
        usage: { enabled: false },
      },
      agents: { providers },
      features: {
        dictation: { enabled: false },
        voiceMode: { enabled: false },
      },
    }),
  );
  const disabledSpeech = { provider: "local", explicit: false, enabled: false } as const;
  fixture = await createTestPaseoDaemon({
    paseoHomeRoot: fixtureRoot,
    staticDir: fixtureWorkDir,
    cleanup: false,
    auth: { password },
    providerOverrides: providers,
    mcpEnabled: false,
    speech: {
      providers: {
        dictationStt: disabledSpeech,
        voiceTurnDetection: disabledSpeech,
        voiceStt: disabledSpeech,
        voiceTts: disabledSpeech,
      },
    },
  });
  const daemon = fixture;
  await acquirePidLock(paseoHome, `127.0.0.1:${daemon.port}`);
  {
    console.log("Test 1: local status uses the daemon's local credential");
    const result = await runDiagnosticCli({
      args: ["daemon", "status", "--json"],
      env: { PASEO_PASSWORD: "" },
    });

    assert.strictEqual(result.exitCode, 0, "status should still succeed");
    const status = JSON.parse(result.stdout);

    assert.strictEqual(status.localDaemon, "running");
    assert.strictEqual(status.connectedDaemon, "reachable");
    assert(!("runningAgents" in status), "status should not fetch agent counts");
    assert(!("idleAgents" in status), "status should not fetch agent counts");
    assert.doesNotMatch(status.note ?? "", /Password required|not reachable/i);
    console.log("✓ missing password uses local credential\n");
  }

  {
    console.log("Test 2: status reports rejected supplied password separately");
    const result = await runDiagnosticCli({
      args: ["daemon", "status", "--json"],
      env: { PASEO_PASSWORD: "wrong-secret" },
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
    const result = await runDiagnosticCli({
      args: ["daemon", "status", "--json"],
      env: { PASEO_PASSWORD: "shared-secret" },
    });

    assert.strictEqual(result.exitCode, 0, "status should succeed with password");
    const status = JSON.parse(result.stdout);

    assert.strictEqual(status.localDaemon, "running");
    assert.strictEqual(status.connectedDaemon, "reachable");
    assert(!("runningAgents" in status), "status should not fetch agent counts");
    assert(!("idleAgents" in status), "status should not fetch agent counts");
    console.log("✓ password-authenticated status remains reachable\n");
  }

  await test("daemon status exposes unresolved terminal cleanup in JSON and human output", async () => {
    const recordId = "cli-status-cleanup";
    const cleanupPath = terminalCleanupRecordPath(daemon.paseoHome, recordId);
    const unresolved = [
      {
        pid: 2_147_483_647,
        role: "terminal program",
        reason: "still alive",
        detail: "fixture cleanup could not confirm termination",
      },
    ] satisfies TerminalCleanupUnresolved[];
    const env = {
      PASEO_HOME: daemon.paseoHome,
      PASEO_HOST: "",
      PASEO_PASSWORD: "shared-secret",
    };
    // Status only reads this earlier-boot record; any cleanup retires it without signaling PIDs.
    try {
      await writeTerminalCleanupRecord(daemon.paseoHome, {
        recordId,
        pid: 2_147_483_646,
        bootId: null,
        createdAt: "1970-01-01T00:00:00.000Z",
        protocolVersion: 1,
        paseoVersion: "0.0.0-test",
        socketPath: join(daemon.paseoHome, "cli-status-cleanup.sock"),
        secret: "cli-status-cleanup-secret",
        terminals: [{ id: "cli-status-terminal", pid: 2_147_483_647, startedAt: null }],
        closing: { unresolved },
      });
      const json = await runDiagnosticCli({ args: ["daemon", "status", "--json"], env });
      const human = await runDiagnosticCli({
        args: ["daemon", "status", "--host", `127.0.0.1:${daemon.port}`, "--no-color"],
        env,
      });
      assert.strictEqual(json.exitCode, 0, json.stderr);
      assert.strictEqual(human.exitCode, 0, human.stderr);
      assert.strictEqual(json.stderr, "");
      assert.strictEqual(human.stderr, "");
      assert.doesNotMatch(json.stdout + human.stdout, /shared-secret|cli-status-cleanup-secret/);
      const status = JSON.parse(json.stdout);
      assert.strictEqual(status.connectedDaemon, "reachable", json.stdout);
      assert.strictEqual(status.note, undefined, json.stdout);
      assert.deepStrictEqual(status.terminalCleanupUnconfirmed, unresolved, json.stdout);
      const cleanupLine = human.stdout
        .split(/\r?\n/)
        .find((line) => line.startsWith("terminalCleanupUnconfirmed: "));
      assert.strictEqual(cleanupLine, `terminalCleanupUnconfirmed: ${JSON.stringify(unresolved)}`);
    } finally {
      await rm(cleanupPath, { force: true });
    }
  });
} finally {
  try {
    await fixture?.close();
  } finally {
    await releasePidLock(paseoHome);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    await rm(fixtureRoot, { recursive: true, force: true });
  }
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

console.log("=== Daemon Status Auth Checks Finished ===");
