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

console.log("=== CLI IPC Target Helpers ===\n");

{
  console.log("Test 1: unix hosts resolve to ws+unix URLs");
  const target = resolveDaemonTarget("unix:///tmp/hubcode.sock");
  assert.deepStrictEqual(target, {
    type: "ipc",
    url: "ws+unix:///tmp/hubcode.sock:/ws",
    socketPath: "/tmp/hubcode.sock",
  });
  console.log("✓ unix hosts resolve to ws+unix URLs\n");
}

{
  console.log("Test 2: pipe hosts preserve the Node socketPath transport form");
  const target = resolveDaemonTarget("pipe://\\\\.\\pipe\\hubcode-managed-test");
  assert.deepStrictEqual(target, {
    type: "ipc",
    url: "ws://localhost/ws",
    socketPath: "\\\\.\\pipe\\hubcode-managed-test",
  });
  console.log("✓ pipe hosts preserve Node socketPath transport form\n");
}

{
  console.log("Test 3: local unix socket paths normalize into IPC daemon targets");
  assert.strictEqual(normalizeDaemonHost("/tmp/hubcode.sock"), "unix:///tmp/hubcode.sock");
  console.log("✓ local unix socket paths normalize into IPC daemon targets\n");
}

{
  console.log("Test 3b: Windows absolute paths are NOT treated as unix sockets");
  assert.strictEqual(normalizeDaemonHost("C:\\Users\\foo\\.hubcode\\hubcode.sock"), null);
  assert.strictEqual(normalizeDaemonHost("D:\\project\\socket"), null);
  console.log("✓ Windows absolute paths are not treated as unix sockets\n");
}

{
  console.log("Test 4: default host resolution tries local IPC first, then localhost fallback");
  const hubcodeHome = mkdtempSync(path.join(os.tmpdir(), "hubcode-client-targets-"));
  try {
    mkdirSync(hubcodeHome, { recursive: true });
    writeFileSync(
      path.join(hubcodeHome, "hubcode.pid"),
      JSON.stringify({ pid: process.pid, listen: "/tmp/hubcode-from-pid.sock" }),
    );
    assert.deepStrictEqual(resolveDefaultDaemonHosts({ HUBCODE_HOME: hubcodeHome }), [
      "unix:///tmp/hubcode-from-pid.sock",
      "localhost:6767",
    ]);
    const previousHome = process.env.HUBCODE_HOME;
    const previousHost = process.env.HUBCODE_HOST;
    process.env.HUBCODE_HOME = hubcodeHome;
    delete process.env.HUBCODE_HOST;
    assert.strictEqual(getDaemonHost(), "unix:///tmp/hubcode-from-pid.sock");
    if (previousHome === undefined) delete process.env.HUBCODE_HOME;
    else process.env.HUBCODE_HOME = previousHome;
    if (previousHost === undefined) delete process.env.HUBCODE_HOST;
    else process.env.HUBCODE_HOST = previousHost;
  } finally {
    rmSync(hubcodeHome, { recursive: true, force: true });
  }
  console.log("✓ default host resolution tries local IPC first, then localhost fallback\n");
}

{
  console.log("Test 5: configured TCP host is preserved before the localhost fallback");
  const hubcodeHome = mkdtempSync(path.join(os.tmpdir(), "hubcode-client-targets-tcp-"));
  try {
    assert.deepStrictEqual(
      resolveDefaultDaemonHosts({
        HUBCODE_HOME: hubcodeHome,
        HUBCODE_LISTEN: "127.0.0.1:7777",
      }),
      ["127.0.0.1:7777", "localhost:6767"],
    );
  } finally {
    rmSync(hubcodeHome, { recursive: true, force: true });
  }
  console.log("✓ configured TCP host is preserved before the localhost fallback\n");
}

{
  console.log("Test 6: local IPC still takes priority over configured TCP hosts");
  const hubcodeHome = mkdtempSync(path.join(os.tmpdir(), "hubcode-client-targets-order-"));
  try {
    mkdirSync(hubcodeHome, { recursive: true });
    writeFileSync(
      path.join(hubcodeHome, "hubcode.pid"),
      JSON.stringify({ pid: process.pid, listen: "/tmp/hubcode-priority.sock" }),
    );
    assert.deepStrictEqual(
      resolveDefaultDaemonHosts({
        HUBCODE_HOME: hubcodeHome,
        HUBCODE_LISTEN: "127.0.0.1:7777",
      }),
      ["unix:///tmp/hubcode-priority.sock", "127.0.0.1:7777", "localhost:6767"],
    );
  } finally {
    rmSync(hubcodeHome, { recursive: true, force: true });
  }
  console.log("✓ local IPC still takes priority over configured TCP hosts\n");
}

console.log("=== All CLI IPC target tests passed ===");
