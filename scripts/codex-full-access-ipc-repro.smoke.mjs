#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

function run(cmd, args, { cwd, timeoutMs }) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const stdoutChunks = [];
    const stderrChunks = [];

    child.stdout.on("data", (d) => stdoutChunks.push(d));
    child.stderr.on("data", (d) => stderrChunks.push(d));

    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
    }, timeoutMs);

    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      resolve({
        code: code ?? (signal ? 1 : 0),
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
      });
    });
  });
}

function requireMatch(haystack, regex, label) {
  const match = haystack.match(regex);
  if (!match) {
    throw new Error(`Missing ${label}: ${regex}\n--- output ---\n${haystack}`);
  }
  return match;
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function main() {
  const direct = await run(process.execPath, ["scripts/repro-ipc-listen.js"], {
    cwd: repoRoot,
    timeoutMs: 10_000,
  });
  if (direct.code !== 0) {
    throw new Error(
      `Direct repro failed (exit ${direct.code})\n${direct.stdout}\n${direct.stderr}`,
    );
  }
  requireMatch(direct.stdout + direct.stderr, /\bLISTENING\b/, "LISTENING");

  const prompt =
    "Run exactly this shell command and then stop:\n" +
    "bash -lc 'node scripts/repro-ipc-listen.js; echo EXIT_CODE:$?'\n" +
    "Reply with only the raw command stdout/stderr (no extra text).";

  const codex = await run(
    "codex",
    [
      "-a",
      "never",
      "exec",
      "--dangerously-bypass-approvals-and-sandbox",
      "--color",
      "never",
      "-C",
      repoRoot,
      prompt,
    ],
    { cwd: repoRoot, timeoutMs: 180_000 },
  );

  const combined = codex.stdout + codex.stderr;
  requireMatch(combined, /\bsandbox:\s*danger-full-access\b/, "sandbox header");
  requireMatch(combined, /\bLISTENING\b/, "LISTENING");
  requireMatch(combined, /\bEXIT_CODE:0\b/, "EXIT_CODE:0");

  process.stdout.write("OK codex full-access IPC repro\n");
}

main().catch((error) => {
  const message = error && error.stack ? error.stack : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
