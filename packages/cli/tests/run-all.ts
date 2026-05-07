#!/usr/bin/env npx zx

/**
 * Test runner for Paseo CLI E2E tests
 *
 * Runs all test phases as separate subprocesses with a bounded worker pool
 * so independent tests run concurrently. Each test file already isolates
 * its own daemon (ephemeral port + tmp PASEO_HOME), so parallelism is safe.
 */

import { spawn } from "child_process";
import { $ } from "zx";
import { mkdtemp, readdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join, dirname, delimiter } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// npm workspace scripts only add the local node_modules/.bin to PATH; hoisted
// packages live in the root. Prepend it so `npx paseo` resolves locally.
const rootNodeModulesBin = join(__dirname, "..", "..", "..", "node_modules", ".bin");
const args = process.argv.slice(2);
const testEnvDefaults = {
  PASEO_LOCAL_SPEECH_AUTO_DOWNLOAD: process.env.PASEO_LOCAL_SPEECH_AUTO_DOWNLOAD ?? "0",
  PASEO_DICTATION_ENABLED: process.env.PASEO_DICTATION_ENABLED ?? "0",
  PASEO_VOICE_MODE_ENABLED: process.env.PASEO_VOICE_MODE_ENABLED ?? "0",
};

const DEFAULT_CONCURRENCY = 4;
const concurrencyEnv = process.env.PASEO_CLI_TEST_CONCURRENCY;
const parsedConcurrency = concurrencyEnv ? Number.parseInt(concurrencyEnv, 10) : NaN;
const concurrency =
  Number.isFinite(parsedConcurrency) && parsedConcurrency > 0
    ? parsedConcurrency
    : DEFAULT_CONCURRENCY;

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const shardTotal = parsePositiveInt(process.env.PASEO_CLI_TEST_SHARD_TOTAL, 1);
const shardIndexRaw = parsePositiveInt(process.env.PASEO_CLI_TEST_SHARD, 1);
if (shardIndexRaw < 1 || shardIndexRaw > shardTotal) {
  throw new Error(
    `PASEO_CLI_TEST_SHARD=${shardIndexRaw} out of range for SHARD_TOTAL=${shardTotal}`,
  );
}
const shardIndex = shardIndexRaw - 1;

let jsonOutputPath: string | null = null;
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--json-output") {
    const value = args[i + 1];
    if (!value) {
      throw new Error("--json-output requires a file path");
    }
    jsonOutputPath = value;
    i++;
    continue;
  }
}

$.verbose = false;

interface Failure {
  test: string;
  error: string;
}

async function runCommand(label: string, command: string): Promise<void> {
  console.log(`\n${"─".repeat(50)}`);
  console.log(`🔧 ${label}...`);
  console.log("─".repeat(50));

  const result = await $`bash -lc ${command}`.nothrow();
  if (result.exitCode !== 0) {
    const error = result.stderr || result.stdout || `Exit code: ${result.exitCode}`;
    console.error(`\n❌ ${label} failed`);
    console.error(error);
    throw new Error(error);
  }
}

async function writeJsonSummary({
  passed,
  failed,
  failures,
}: {
  passed: number;
  failed: number;
  failures: Failure[];
}) {
  if (!jsonOutputPath) {
    return;
  }

  await writeFile(
    jsonOutputPath,
    JSON.stringify(
      {
        suite: "cli-local",
        command: "npm run test:local --workspace=@getpaseo/cli",
        counts: {
          passed,
          failed,
          skipped: 0,
        },
        skippedTests: [],
        failures: failures.map(({ test, error }) => ({
          test,
          error: error.split("\n")[0] ?? "",
        })),
      },
      null,
      2,
    ) + "\n",
  );
}

console.log("🧪 Paseo CLI E2E Test Runner\n");
console.log("=".repeat(50));

// Discover all test files
const files = await readdir(__dirname);
const allTestFiles = files.filter((f) => f.match(/^\d{2}-.*\.test\.ts$/)).sort();

// Naive `index % shardTotal` round-robin clusters slow tests by accident
// because their numeric prefixes (05, 06, 11, 13, 14) align with the stride.
// Hand off the known long-pole tests round-robin first, then fill the
// remainder in the reverse direction so shards heavy on slow tests get
// fewer light tests. Update KNOWN_HEAVY_TESTS from the runner's "Slowest
// tests" report when timings shift materially.
const KNOWN_HEAVY_TESTS = new Set([
  "05-agent-run.test.ts",
  "06-agent-send.test.ts",
  "11-agent-wait.test.ts",
  "13-permit-allow-deny.test.ts",
  "14-worktree.test.ts",
]);
const heavyFiles = allTestFiles.filter((f) => KNOWN_HEAVY_TESTS.has(f));
const otherFiles = allTestFiles.filter((f) => !KNOWN_HEAVY_TESTS.has(f));
const shardBuckets: string[][] = Array.from({ length: shardTotal }, () => []);
heavyFiles.forEach((f, i) => {
  shardBuckets[i % shardTotal].push(f);
});
otherFiles.forEach((f, i) => {
  shardBuckets[shardTotal - 1 - (i % shardTotal)].push(f);
});
const testFiles = shardBuckets[shardIndex];

if (allTestFiles.length === 0) {
  console.log("❌ No test files found");
  await writeJsonSummary({ passed: 0, failed: 0, failures: [] });
  process.exit(1);
}

if (testFiles.length === 0) {
  console.log(`❌ No test files for shard ${shardIndex + 1}/${shardTotal}`);
  await writeJsonSummary({ passed: 0, failed: 0, failures: [] });
  process.exit(1);
}

console.log(
  `Shard ${shardIndex + 1}/${shardTotal}: ${testFiles.length} of ${allTestFiles.length} test file(s):\n`,
);
for (const file of testFiles) {
  console.log(`  - ${file}`);
}
console.log();

let passed = 0;
let failed = 0;
const failures: Failure[] = [];

await runCommand("Building relay", "npm run build --workspace=@getpaseo/relay");
await runCommand("Building server", "npm run build --workspace=@getpaseo/server");
await runCommand("Building CLI", "npm run build --workspace=@getpaseo/cli");

type TestOutcome =
  | { status: "passed"; durationMs: number }
  | { status: "failed"; durationMs: number; failure: Failure };

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

async function runSingleTest(testFile: string): Promise<TestOutcome> {
  const testPath = join(__dirname, testFile);
  const testName = testFile.replace(/\.test\.ts$/, "");
  const startedAt = Date.now();
  const npmCache = await mkdtemp(join(tmpdir(), "paseo-cli-test-npm-cache-"));

  try {
    return await new Promise<TestOutcome>((resolve) => {
      const proc = spawn("npx", ["tsx", testPath], {
        env: {
          ...process.env,
          PATH: [rootNodeModulesBin, process.env.PATH].filter(Boolean).join(delimiter),
          npm_config_cache: npmCache,
          PASEO_LOCAL_SPEECH_AUTO_DOWNLOAD: testEnvDefaults.PASEO_LOCAL_SPEECH_AUTO_DOWNLOAD,
          PASEO_DICTATION_ENABLED: testEnvDefaults.PASEO_DICTATION_ENABLED,
          PASEO_VOICE_MODE_ENABLED: testEnvDefaults.PASEO_VOICE_MODE_ENABLED,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      proc.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      proc.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      proc.on("error", (err) => {
        const durationMs = Date.now() - startedAt;
        const message = err instanceof Error ? err.message : String(err);
        flushTestBlock(testName, durationMs, false, stdout, stderr || message);
        resolve({
          status: "failed",
          durationMs,
          failure: { test: testName, error: message },
        });
      });

      proc.on("exit", (code) => {
        const durationMs = Date.now() - startedAt;
        const exitCode = code ?? 1;
        if (exitCode === 0) {
          flushTestBlock(testName, durationMs, true, stdout, stderr);
          resolve({ status: "passed", durationMs });
          return;
        }
        flushTestBlock(testName, durationMs, false, stdout, stderr);
        resolve({
          status: "failed",
          durationMs,
          failure: { test: testName, error: stderr || `Exit code: ${exitCode}` },
        });
      });
    });
  } finally {
    await rm(npmCache, { recursive: true, force: true });
  }
}

function flushTestBlock(
  testName: string,
  durationMs: number,
  success: boolean,
  stdout: string,
  stderr: string,
): void {
  const icon = success ? "✅" : "❌";
  const status = success ? "PASSED" : "FAILED";
  const lines: string[] = [];
  lines.push("─".repeat(50));
  lines.push(`📋 ${testName} (${formatDuration(durationMs)})`);
  lines.push("─".repeat(50));
  if (stdout) lines.push(stdout.trimEnd());
  if (!success && stderr) {
    lines.push("stderr:");
    lines.push(stderr.trimEnd());
  }
  lines.push(`${icon} ${testName} ${status}`);
  process.stdout.write(`${lines.join("\n")}\n\n`);
}

console.log(
  `\nRunning tests with concurrency=${concurrency}, shard=${shardIndex + 1}/${shardTotal}\n`,
);

const totalStart = Date.now();
const queue = [...testFiles];
const timings: { test: string; durationMs: number; status: "passed" | "failed" }[] = [];

async function worker(): Promise<void> {
  while (queue.length > 0) {
    const testFile = queue.shift();
    if (!testFile) return;
    const outcome = await runSingleTest(testFile);
    const test = testFile.replace(/\.test\.ts$/, "");
    timings.push({ test, durationMs: outcome.durationMs, status: outcome.status });
    if (outcome.status === "passed") {
      passed++;
    } else {
      failed++;
      failures.push(outcome.failure);
    }
  }
}

const workerCount = Math.min(concurrency, testFiles.length);
await Promise.all(Array.from({ length: workerCount }, () => worker()));

const totalDurationMs = Date.now() - totalStart;

// Summary
console.log("\n" + "=".repeat(50));
console.log("📊 Test Results");
console.log("=".repeat(50));
console.log(`  ✅ Passed: ${passed}`);
console.log(`  ❌ Failed: ${failed}`);
console.log(`  📝 Total:  ${passed + failed}`);
console.log(`  ⏱  Wall:   ${formatDuration(totalDurationMs)} (concurrency=${concurrency})`);

const slowest = [...timings].sort((a, b) => b.durationMs - a.durationMs).slice(0, 5);
if (slowest.length > 0) {
  console.log("\n🐢 Slowest tests:");
  for (const t of slowest) {
    console.log(`  - ${t.test} (${formatDuration(t.durationMs)})`);
  }
}

if (failures.length > 0) {
  console.log("\n❌ Failed tests:");
  for (const { test, error } of failures) {
    console.log(`  - ${test}`);
    if (error) {
      console.log(`    ${error.split("\n")[0]}`);
    }
  }
}

console.log();

await writeJsonSummary({ passed, failed, failures });

process.exit(failed > 0 ? 1 : 0);
