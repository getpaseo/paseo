#!/usr/bin/env npx tsx

import assert from "node:assert";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  getDaemonHost,
  normalizeDaemonHost,
  resolveDaemonTarget,
  resolveDefaultDaemonHosts,
} from "../src/utils/client.js";
import { resolveCliVersion } from "../src/version.js";

console.log("=== CLI IPC Target Helpers ===\n");

{
  console.log("Test 1: unix hosts resolve to ws+unix URLs");
  const target = resolveDaemonTarget("unix:///tmp/paseo.sock");
  assert.deepStrictEqual(target, {
    type: "ipc",
    url: "ws+unix:///tmp/paseo.sock:/ws",
    socketPath: "/tmp/paseo.sock",
  });
  console.log("✓ unix hosts resolve to ws+unix URLs\n");
}

{
  console.log("Test 2: pipe hosts preserve the Node socketPath transport form");
  const target = resolveDaemonTarget("pipe://\\\\.\\pipe\\paseo-managed-test");
  assert.deepStrictEqual(target, {
    type: "ipc",
    url: "ws://localhost/ws",
    socketPath: "\\\\.\\pipe\\paseo-managed-test",
  });
  console.log("✓ pipe hosts preserve Node socketPath transport form\n");
}

{
  console.log("Test 3: local unix socket paths normalize into IPC daemon targets");
  assert.strictEqual(normalizeDaemonHost("/tmp/paseo.sock"), "unix:///tmp/paseo.sock");
  console.log("✓ local unix socket paths normalize into IPC daemon targets\n");
}

{
  console.log("Test 3b: Windows absolute paths are NOT treated as unix sockets");
  assert.strictEqual(normalizeDaemonHost("C:\\Users\\foo\\.paseo\\paseo.sock"), null);
  assert.strictEqual(normalizeDaemonHost("D:\\project\\socket"), null);
  console.log("✓ Windows absolute paths are not treated as unix sockets\n");
}

{
  console.log("Test 4: default host resolution tries local IPC first, then localhost fallback");
  const paseoHome = mkdtempSync(path.join(os.tmpdir(), "paseo-client-targets-"));
  try {
    mkdirSync(paseoHome, { recursive: true });
    writeFileSync(
      path.join(paseoHome, "paseo.pid"),
      JSON.stringify({ pid: process.pid, listen: "/tmp/paseo-from-pid.sock" }),
    );
    assert.deepStrictEqual(resolveDefaultDaemonHosts({ PASEO_HOME: paseoHome }), [
      "unix:///tmp/paseo-from-pid.sock",
      "localhost:6767",
    ]);
    const previousHome = process.env.PASEO_HOME;
    const previousHost = process.env.PASEO_HOST;
    process.env.PASEO_HOME = paseoHome;
    delete process.env.PASEO_HOST;
    assert.strictEqual(getDaemonHost(), "unix:///tmp/paseo-from-pid.sock");
    if (previousHome === undefined) delete process.env.PASEO_HOME;
    else process.env.PASEO_HOME = previousHome;
    if (previousHost === undefined) delete process.env.PASEO_HOST;
    else process.env.PASEO_HOST = previousHost;
  } finally {
    rmSync(paseoHome, { recursive: true, force: true });
  }
  console.log("✓ default host resolution tries local IPC first, then localhost fallback\n");
}

{
  console.log("Test 5: configured TCP host is preserved before the localhost fallback");
  const paseoHome = mkdtempSync(path.join(os.tmpdir(), "paseo-client-targets-tcp-"));
  try {
    assert.deepStrictEqual(
      resolveDefaultDaemonHosts({
        PASEO_HOME: paseoHome,
        PASEO_LISTEN: "127.0.0.1:7777",
      }),
      ["127.0.0.1:7777", "localhost:6767"],
    );
  } finally {
    rmSync(paseoHome, { recursive: true, force: true });
  }
  console.log("✓ configured TCP host is preserved before the localhost fallback\n");
}

{
  console.log("Test 6: CLI app version resolves for daemon hello compatibility");
  assert.match(resolveCliVersion(), /^\d+\.\d+\.\d+/);
  console.log("✓ CLI app version resolves for daemon hello compatibility\n");
}

{
  console.log("Test 7: local IPC still takes priority over configured TCP hosts");
  const paseoHome = mkdtempSync(path.join(os.tmpdir(), "paseo-client-targets-order-"));
  try {
    mkdirSync(paseoHome, { recursive: true });
    writeFileSync(
      path.join(paseoHome, "paseo.pid"),
      JSON.stringify({ pid: process.pid, listen: "/tmp/paseo-priority.sock" }),
    );
    assert.deepStrictEqual(
      resolveDefaultDaemonHosts({
        PASEO_HOME: paseoHome,
        PASEO_LISTEN: "127.0.0.1:7777",
      }),
      ["unix:///tmp/paseo-priority.sock", "127.0.0.1:7777", "localhost:6767"],
    );
  } finally {
    rmSync(paseoHome, { recursive: true, force: true });
  }
  console.log("✓ local IPC still takes priority over configured TCP hosts\n");
}

console.log("=== All CLI IPC target tests passed ===");
