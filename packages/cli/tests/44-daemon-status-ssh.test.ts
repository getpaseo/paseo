#!/usr/bin/env npx tsx

import assert from "node:assert";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { runLocalPaseo } from "./helpers/local-cli.ts";
import { startTestDaemon } from "./helpers/test-daemon.ts";

console.log("=== Daemon Status over SSH ===\n");

// The stub stands in for OpenSSH; Windows cannot run it as `ssh` from PATH.
if (process.platform === "win32") {
  console.log("Skipped on Windows\n");
  process.exit(0);
}

const SSH_SETUP_MS = 2500;
const root = await mkdtemp(join(tmpdir(), "paseo-status-ssh-"));
let daemon: Awaited<ReturnType<typeof startTestDaemon>> | undefined;

try {
  daemon = await startTestDaemon();
  // Opens the -W stream only after the delay a real SSH handshake takes.
  await writeFile(
    join(root, "ssh"),
    `#!${process.execPath}
const net = require("node:net");
const args = process.argv.slice(2);
const [host, port] = args[args.indexOf("-W") + 1].split(":");
setTimeout(() => {
  const socket = net.connect(Number(port), host);
  process.stdin.pipe(socket);
  socket.pipe(process.stdout);
  socket.on("close", () => process.exit(0));
}, ${SSH_SETUP_MS});
`,
    { mode: 0o700 },
  );

  console.log("Test 1: status reaches a daemon whose SSH stream takes 2.5s to open");
  const result = await runLocalPaseo(
    ["daemon", "status", "--host", `ssh://build-box?daemonPort=${daemon.port}`, "--json"],
    { PATH: `${root}${delimiter}${process.env.PATH ?? ""}` },
  );

  assert.strictEqual(result.exitCode, 0, result.stderr);
  const status = JSON.parse(result.stdout);
  assert.strictEqual(status.connectedDaemon, "reachable", JSON.stringify(status));
  assert.strictEqual(typeof status.serverId, "string");
  console.log("✓ status waits for the SSH stream like other commands\n");
} finally {
  await daemon?.stop();
  await rm(root, { recursive: true, force: true });
}

console.log("=== Daemon Status over SSH Tests Passed ===");
