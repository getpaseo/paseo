import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { copyFile, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { startGitCommandMetrics, stopGitCommandMetrics } from "../src/utils/run-git-command.js";
import { DaemonClient } from "../src/server/test-utils/daemon-client.js";
import { createTestPaseoDaemon } from "../src/server/test-utils/paseo-daemon.js";

type Scenario = "snapshotOnly" | "legacyPrFanout";

interface BenchmarkResult {
  scenario: Scenario;
  sourceHome: string;
  frozenHomeRoot: string;
  workspaceCount: number;
  elapsedMs: number;
  git: {
    total: number;
    failed: number;
    maxConcurrent: number;
    byCommand: Array<{ key: string; count: number }>;
    byCwd: Array<{ key: string; count: number }>;
  };
  process: {
    cpuUserMs: number;
    cpuSystemMs: number;
    rssDeltaMb: number;
    heapUsedDeltaMb: number;
  };
}

function parseArgs(): { sourceHome: string; frozenHomeRoot: string | null; scenario: Scenario } {
  let sourceHome = process.env.PASEO_BENCHMARK_SOURCE_HOME ?? path.join(os.homedir(), ".paseo");
  let frozenHomeRoot = process.env.PASEO_BENCHMARK_FROZEN_HOME_ROOT ?? null;
  let scenario = (process.env.PASEO_BENCHMARK_SCENARIO ?? "snapshotOnly") as Scenario;

  for (const arg of process.argv.slice(2)) {
    const [key, value] = arg.split("=", 2);
    if (key === "--source-home" && value) sourceHome = value;
    if (key === "--frozen-home-root" && value) frozenHomeRoot = value;
    if (key === "--scenario" && (value === "snapshotOnly" || value === "legacyPrFanout")) {
      scenario = value;
    }
  }

  return { sourceHome, frozenHomeRoot, scenario };
}

function copyJsonTree(sourceDir: string, targetDir: string): void {
  if (!existsSync(sourceDir)) {
    return;
  }
  mkdirSync(targetDir, { recursive: true });
  for (const entry of readdirSync(sourceDir)) {
    const sourcePath = path.join(sourceDir, entry);
    const targetPath = path.join(targetDir, entry);
    const stat = statSync(sourcePath);
    if (stat.isDirectory()) {
      copyJsonTree(sourcePath, targetPath);
      continue;
    }
    if (stat.isFile() && entry.endsWith(".json")) {
      mkdirSync(path.dirname(targetPath), { recursive: true });
      copyFileSync(sourcePath, targetPath);
    }
  }
}

async function freezeHome(sourceHome: string, requestedRoot: string | null): Promise<string> {
  const frozenHomeRoot = requestedRoot ?? mkdtempSync(path.join(os.tmpdir(), "paseo-real-home-"));
  if (process.env.PASEO_BENCHMARK_REUSE_FROZEN_HOME === "1") {
    return frozenHomeRoot;
  }
  const frozenHome = path.join(frozenHomeRoot, ".paseo");
  rmSync(frozenHome, { recursive: true, force: true });
  mkdirSync(frozenHome, { recursive: true });

  copyJsonTree(path.join(sourceHome, "agents"), path.join(frozenHome, "agents"));
  copyJsonTree(path.join(sourceHome, "projects"), path.join(frozenHome, "projects"));

  const configPath = path.join(sourceHome, "config.json");
  if (existsSync(configPath)) {
    await copyFile(configPath, path.join(frozenHome, "config.json"));
  }

  return frozenHomeRoot;
}

function topCounts(items: string[], limit = 20): Array<{ key: string; count: number }> {
  const counts = new Map<string, number>();
  for (const item of items) {
    counts.set(item, (counts.get(item) ?? 0) + 1);
  }
  return Array.from(counts, ([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
    .slice(0, limit);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  let timeout: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>((resolve) => {
        timeout = setTimeout(() => resolve(undefined), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

async function main(): Promise<void> {
  const { sourceHome, frozenHomeRoot: requestedFrozenRoot, scenario } = parseArgs();
  const frozenHomeRoot = await freezeHome(sourceHome, requestedFrozenRoot);
  const cpuBefore = process.cpuUsage();
  const memoryBefore = process.memoryUsage();
  const startedAt = performance.now();
  const daemon = await createTestPaseoDaemon({ paseoHomeRoot: frozenHomeRoot, cleanup: false });
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.1.90",
  });

  let metrics = stopGitCommandMetrics();
  try {
    startGitCommandMetrics();
    await client.connect();
    const seen = new Set<string>();
    client.on("checkout_status_update", (message) => seen.add(message.payload.cwd));
    const workspaces = await client.fetchWorkspaces({
      subscribe: { subscriptionId: `startup-git-${scenario}` },
      sort: [{ key: "activity_at", direction: "desc" }],
      page: { limit: 200 },
    });
    await client.fetchAgents({
      scope: "active",
      subscribe: { subscriptionId: `startup-agents-${scenario}` },
      page: { limit: 200 },
    });

    const workspaceCwds = workspaces.entries
      .map((entry) => entry.workspaceDirectory)
      .filter((cwd): cwd is string => Boolean(cwd));

    if (scenario === "legacyPrFanout") {
      await Promise.all(workspaceCwds.map((cwd) => client.checkoutPrStatus(cwd).catch(() => null)));
    }

    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && workspaceCwds.some((cwd) => !seen.has(cwd))) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await new Promise((resolve) => setTimeout(resolve, 500));

    metrics = stopGitCommandMetrics();
    const elapsedMs = Math.round(performance.now() - startedAt);
    const cpu = process.cpuUsage(cpuBefore);
    const memoryAfter = process.memoryUsage();
    const result: BenchmarkResult = {
      scenario,
      sourceHome,
      frozenHomeRoot,
      workspaceCount: workspaceCwds.length,
      elapsedMs,
      git: {
        total: metrics.total,
        failed: metrics.failed,
        maxConcurrent: metrics.maxConcurrent,
        byCommand: topCounts(metrics.commands.map((command) => command.args.join(" "))),
        byCwd: topCounts(metrics.commands.map((command) => command.cwd)),
      },
      process: {
        cpuUserMs: Math.round(cpu.user / 1000),
        cpuSystemMs: Math.round(cpu.system / 1000),
        rssDeltaMb: Number(((memoryAfter.rss - memoryBefore.rss) / 1024 / 1024).toFixed(1)),
        heapUsedDeltaMb: Number(
          ((memoryAfter.heapUsed - memoryBefore.heapUsed) / 1024 / 1024).toFixed(1),
        ),
      },
    };
    console.log(`REAL_HOME_STARTUP_GIT_BENCHMARK ${JSON.stringify(result)}`);
  } finally {
    if (metrics.total === 0) {
      stopGitCommandMetrics();
    }
    await withTimeout(
      client.close().catch(() => undefined),
      1_000,
    );
    await withTimeout(
      daemon.close().catch(() => undefined),
      3_000,
    );
    if (!requestedFrozenRoot) {
      await rm(frozenHomeRoot, { recursive: true, force: true });
    } else {
      await mkdir(frozenHomeRoot, { recursive: true });
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
