#!/usr/bin/env node
/**
 * Probe an ACP agent's stdio handshake without starting Paseo.
 *
 * A provider can look "installed" to Paseo (`daemon status` reports
 * `available: true`) and still never answer the ACP `initialize` request. When
 * that happens the daemon logs a 120s timeout ("pending: initialize") and the
 * provider shows an error in the app, but the underlying CLI may print nothing
 * useful. This script sends the same request the daemon sends and reports what
 * the process actually did.
 *
 * Usage:
 *   node scripts/acp-handshake-probe.mjs -- mcode acp
 *   node scripts/acp-handshake-probe.mjs --timeout 20000 -- "C:\path\to\agent.cmd" acp
 *
 * Exit codes:
 *   0  the agent answered `initialize`
 *   1  the agent exited, printed only stderr, or never answered before the timeout
 *   2  bad arguments
 */

import { spawn } from "node:child_process";

const DEFAULT_TIMEOUT_MS = 15_000;

function parseArgs(argv) {
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  const rest = [];
  let sawSeparator = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      sawSeparator = true;
      continue;
    }
    if (!sawSeparator && arg === "--timeout") {
      timeoutMs = Number(argv[index + 1]);
      index += 1;
      continue;
    }
    rest.push(arg);
  }

  if (rest.length === 0 || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return null;
  }
  return { command: rest[0], args: rest.slice(1), timeoutMs };
}

function summarize(text, limit = 800) {
  const trimmed = text.trim();
  if (trimmed.length === 0) return "<empty>";
  return trimmed.length > limit ? `${trimmed.slice(0, limit)}...` : trimmed;
}

const parsed = parseArgs(process.argv.slice(2));
if (!parsed) {
  console.error(
    "Usage: node scripts/acp-handshake-probe.mjs [--timeout <ms>] -- <command> [args...]",
  );
  process.exit(2);
}

const { command, args, timeoutMs } = parsed;
// Windows ships agent launchers as .cmd/.bat shims; those need a shell to run.
const needsShell = process.platform === "win32" && /\.(cmd|bat)$/i.test(command);

function quoteForShell(value) {
  return /[\s"]/.test(value) ? `"${value.replaceAll('"', '\\"')}"` : value;
}

// With `shell: true` Node warns when an args array is passed alongside it, so
// hand the shell a single command line instead.
const child = needsShell
  ? spawn([command, ...args].map(quoteForShell).join(" "), {
      stdio: ["pipe", "pipe", "pipe"],
      shell: true,
      windowsHide: true,
    })
  : spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

let stdout = "";
let stderr = "";
let settled = false;

function report(outcome) {
  if (settled) return;
  settled = true;
  console.log(`command: ${command} ${args.join(" ")}`);
  console.log(`outcome: ${outcome}`);
  console.log(`stdout: ${summarize(stdout)}`);
  console.log(`stderr: ${summarize(stderr)}`);
  child.kill();
  process.exit(outcome === "answered initialize" ? 0 : 1);
}

child.stdout.on("data", (chunk) => {
  stdout += chunk.toString();
  if (stdout.includes('"jsonrpc"')) {
    report("answered initialize");
  }
});

child.stderr.on("data", (chunk) => {
  stderr += chunk.toString();
});

child.once("error", (error) => {
  stderr += String(error);
  report("failed to spawn");
});

child.once("exit", (code, signal) => {
  report(
    `exited before answering (code ${code ?? "unknown"}${signal ? `, signal ${signal}` : ""})`,
  );
});

child.stdin.write(
  `${JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: 1, clientCapabilities: {} },
  })}\n`,
);

setTimeout(() => {
  report(`no answer within ${timeoutMs}ms`);
}, timeoutMs);
