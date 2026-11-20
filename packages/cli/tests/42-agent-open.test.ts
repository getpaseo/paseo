#!/usr/bin/env npx tsx

import assert from "node:assert";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { runPaseoCli, startTestDaemon } from "./helpers/test-daemon.ts";

console.log("=== Agent Open Command Tests ===\n");

if (process.platform !== "linux") {
  console.log("Skipped: the fake Desktop app is a Linux AppImage path.");
  process.exit(0);
}

const daemon = await startTestDaemon();

// runPaseoCli sets HOME to the daemon's home, where the CLI looks for
// ~/Applications/Paseo.AppImage on Linux. The fake app records its launch.
const launchRecord = join(daemon.paseoHome, "desktop-launches.txt");
const fakeDesktop = join(daemon.paseoHome, "Applications", "Paseo.AppImage");
await mkdir(join(daemon.paseoHome, "Applications"), { recursive: true });
await writeFile(fakeDesktop, `#!/bin/sh\necho "$@" >> "${launchRecord}"\n`);
await chmod(fakeDesktop, 0o755);

try {
  {
    console.log("Test 1: an unknown agent ID fails without opening Desktop");
    const result = await runPaseoCli(daemon, [
      "agent",
      "open",
      "does-not-exist",
      "--host",
      `127.0.0.1:${daemon.port}`,
      "--json",
    ]);

    assert.notStrictEqual(result.exitCode, 0, "open should fail for an unknown agent");
    assert.match(JSON.parse(result.stderr).error.message, /Agent not found: does-not-exist/);
    // Give a wrongly spawned detached app time to write its record.
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.ok(
      !existsSync(launchRecord),
      `Desktop should not open, but was launched with: ${existsSync(launchRecord) ? await readFile(launchRecord, "utf8") : ""}`,
    );
    console.log("✓ unknown agent ID fails without opening Desktop\n");
  }
} finally {
  await daemon.stop();
}

console.log("=== All agent open tests passed ===");
