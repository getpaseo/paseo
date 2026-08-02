import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import parcelWatcher from "@parcel/watcher";
import type pino from "pino";
import {
  getCheckoutDiff,
  getCheckoutSnapshotFacts,
  getCheckoutWorktreeState,
} from "../src/utils/checkout-git.js";
import {
  startGitCommandMetrics,
  stopGitCommandMetrics,
  type GitCommandMetricsSnapshot,
} from "../src/utils/run-git-command.js";
import { CheckoutDiffManager } from "../src/server/checkout-diff-manager.js";
import {
  WorkspaceGitServiceImpl,
  type WorkspaceGitRuntimeSnapshot,
} from "../src/server/workspace-git-service.js";

interface ProducerCounts {
  structural: number;
  worktree: number;
  detailedDiff: number;
}

interface PhaseResult {
  elapsedMs: number;
  gitCommands: number;
  failedGitCommands: number;
  maxConcurrentGitCommands: number;
  byCommand: Record<string, number>;
  producers: ProducerCounts;
  queueAfter: {
    inFlight: number;
    queued: number;
  };
}

function createLogger(): pino.Logger {
  const logger = {
    child: () => logger,
    debug: () => {},
    warn: () => {},
  };
  return logger as unknown as pino.Logger;
}

function runGit(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${label}`);
    }
    await sleep(25);
  }
}

function summarizeCommands(metrics: GitCommandMetricsSnapshot): Record<string, number> {
  const counts = new Map<string, number>();
  for (const command of metrics.commands) {
    const key = command.args.slice(0, 3).join(" ");
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return Object.fromEntries([...counts].sort(([left], [right]) => left.localeCompare(right)));
}

function subtractCounts(after: ProducerCounts, before: ProducerCounts): ProducerCounts {
  return {
    structural: after.structural - before.structural,
    worktree: after.worktree - before.worktree,
    detailedDiff: after.detailedDiff - before.detailedDiff,
  };
}

function snapshotCounts(counts: ProducerCounts): ProducerCounts {
  return { ...counts };
}

function createTrackedSubscriber(failWorktreeRoot: string | null) {
  const subscriptions = new Set<parcelWatcher.AsyncSubscription>();
  const subscribe = async (...args: Parameters<typeof parcelWatcher.subscribe>) => {
    if (failWorktreeRoot && path.resolve(args[0]) === failWorktreeRoot) {
      throw new Error("measurement watcher setup failure");
    }
    const subscription = await parcelWatcher.subscribe(...args);
    subscriptions.add(subscription);
    return {
      unsubscribe: async () => {
        await subscription.unsubscribe();
        subscriptions.delete(subscription);
      },
    };
  };
  return { subscribe, subscriptions };
}

function createMeasuredService(input: {
  repoDir: string;
  paseoHome: string;
  failWorktreeWatch?: boolean;
}) {
  const counts: ProducerCounts = { structural: 0, worktree: 0, detailedDiff: 0 };
  const watcher = createTrackedSubscriber(input.failWorktreeWatch ? input.repoDir : null);
  const service = new WorkspaceGitServiceImpl({
    logger: createLogger(),
    paseoHome: input.paseoHome,
    deps: {
      subscribe: watcher.subscribe,
      getWorkspaceGitSelfHealPhaseMs: () => 60_000,
      getCheckoutSnapshotFacts: async (...args) => {
        counts.structural += 1;
        return getCheckoutSnapshotFacts(...args);
      },
      getCheckoutWorktreeState: async (...args) => {
        counts.worktree += 1;
        return getCheckoutWorktreeState(...args);
      },
      getCheckoutDiff: async (...args) => {
        counts.detailedDiff += 1;
        return getCheckoutDiff(...args);
      },
    },
  });
  return { counts, service, watcher };
}

async function measurePhase(input: {
  service: WorkspaceGitServiceImpl;
  counts: ProducerCounts;
  action: () => Promise<void>;
}): Promise<PhaseResult> {
  const countsBefore = snapshotCounts(input.counts);
  const startedAtMs = Date.now();
  startGitCommandMetrics();
  let metrics: GitCommandMetricsSnapshot;
  try {
    await input.action();
    await waitFor(() => {
      const serviceMetrics = input.service.getMetrics();
      return (
        serviceMetrics.workspaceRefreshInFlightCount === 0 &&
        serviceMetrics.workspaceRefreshQueuedCount === 0
      );
    }, "observation queue to drain");
  } finally {
    metrics = stopGitCommandMetrics();
  }
  const serviceMetrics = input.service.getMetrics();
  return {
    elapsedMs: Date.now() - startedAtMs,
    gitCommands: metrics.total,
    failedGitCommands: metrics.failed,
    maxConcurrentGitCommands: metrics.maxConcurrent,
    byCommand: summarizeCommands(metrics),
    producers: subtractCounts(input.counts, countsBefore),
    queueAfter: {
      inFlight: serviceMetrics.workspaceRefreshInFlightCount,
      queued: serviceMetrics.workspaceRefreshQueuedCount,
    },
  };
}

async function closeMeasuredService(input: {
  service: WorkspaceGitServiceImpl;
  subscriptions: Set<parcelWatcher.AsyncSubscription>;
}): Promise<void> {
  input.service.dispose();
  await waitFor(() => input.subscriptions.size === 0, "watchers to close");
}

async function main(): Promise<void> {
  const tempDir = mkdtempSync(path.join(tmpdir(), "paseo-git-observation-measurement-"));
  const repoDir = path.join(tempDir, "repo");
  const paseoHome = path.join(tempDir, "paseo-home");
  const trackedPath = path.join(repoDir, "tracked.txt");
  const ignoredDir = path.join(repoDir, "build");
  mkdirSync(repoDir, { recursive: true });
  mkdirSync(ignoredDir, { recursive: true });
  writeFileSync(path.join(ignoredDir, "probe.txt"), "ignored\n");
  writeFileSync(path.join(repoDir, ".gitignore"), "build/\n");
  writeFileSync(trackedPath, "base\n");
  runGit(repoDir, ["init", "-b", "main"]);
  runGit(repoDir, ["config", "user.email", "measurement@paseo.local"]);
  runGit(repoDir, ["config", "user.name", "Paseo Measurement"]);
  runGit(repoDir, ["add", ".gitignore", "tracked.txt"]);
  runGit(repoDir, ["commit", "-m", "fixture"]);
  runGit(repoDir, ["checkout", "-b", "feature"]);

  const phases: Record<string, PhaseResult> = {};
  let healthy: ReturnType<typeof createMeasuredService> | null = null;
  let degraded: ReturnType<typeof createMeasuredService> | null = null;
  let summarySubscription: { unsubscribe: () => void } | null = null;
  let diffSubscription: { unsubscribe: () => void } | null = null;
  let diffManager: CheckoutDiffManager | null = null;

  try {
    healthy = createMeasuredService({ repoDir, paseoHome });
    let latestSummary: WorkspaceGitRuntimeSnapshot | null = null;
    let latestDiffAdditions = 0;

    startGitCommandMetrics();
    const bootstrapStartedAtMs = Date.now();
    const bootstrapCounts = snapshotCounts(healthy.counts);
    summarySubscription = healthy.service.registerWorkspace({ cwd: repoDir }, (snapshot) => {
      latestSummary = snapshot;
    });
    diffManager = new CheckoutDiffManager({
      logger: createLogger(),
      paseoHome,
      workspaceGitService: healthy.service,
    });
    const openedDiff = await diffManager.subscribe(
      { cwd: repoDir, compare: { mode: "uncommitted" } },
      (payload) => {
        latestDiffAdditions = payload.files[0]?.additions ?? 0;
      },
    );
    diffSubscription = openedDiff;
    await waitFor(
      () =>
        healthy?.service.peekSnapshot(repoDir) !== null &&
        healthy.service.getMetrics().workspaceObservationSetupInFlightCount === 0 &&
        healthy.watcher.subscriptions.size === 2,
      "healthy bootstrap",
    );
    await sleep(250);
    const bootstrapMetrics = stopGitCommandMetrics();
    const bootstrapServiceMetrics = healthy.service.getMetrics();
    phases.bootstrap = {
      elapsedMs: Date.now() - bootstrapStartedAtMs,
      gitCommands: bootstrapMetrics.total,
      failedGitCommands: bootstrapMetrics.failed,
      maxConcurrentGitCommands: bootstrapMetrics.maxConcurrent,
      byCommand: summarizeCommands(bootstrapMetrics),
      producers: subtractCounts(healthy.counts, bootstrapCounts),
      queueAfter: {
        inFlight: bootstrapServiceMetrics.workspaceRefreshInFlightCount,
        queued: bootstrapServiceMetrics.workspaceRefreshQueuedCount,
      },
    };

    phases.legacyFullRefreshReference = await measurePhase({
      service: healthy.service,
      counts: healthy.counts,
      action: async () => {
        await Promise.all([
          healthy?.service.getSnapshot(repoDir, {
            force: true,
            includeForge: false,
            reason: "measurement-legacy-full-refresh-reference",
          }),
          healthy?.service.getCheckoutDiff(
            repoDir,
            { mode: "uncommitted", includeStructured: true },
            { force: true, reason: "measurement-legacy-full-refresh-reference" },
          ),
        ]);
      },
    });

    phases.idle = await measurePhase({
      service: healthy.service,
      counts: healthy.counts,
      action: () => sleep(750),
    });

    phases.activeDiff = await measurePhase({
      service: healthy.service,
      counts: healthy.counts,
      action: async () => {
        writeFileSync(trackedPath, "first\nsecond\n");
        await waitFor(
          () => (latestSummary?.git.diffStat?.additions ?? 0) >= 2 && latestDiffAdditions >= 2,
          "active diff payload",
        );
        await sleep(1_200);
      },
    });

    phases.editBurst = await measurePhase({
      service: healthy.service,
      counts: healthy.counts,
      action: async () => {
        for (let index = 0; index < 100; index += 1) {
          writeFileSync(
            trackedPath,
            Array.from({ length: index + 2 }, (_, line) => `burst-${index}-${line}`).join("\n") +
              "\n",
          );
        }
        await waitFor(
          () => (latestSummary?.git.diffStat?.additions ?? 0) >= 100 && latestDiffAdditions >= 100,
          "edit burst final payload",
        );
        await sleep(1_200);
      },
    });

    phases.ignoredStorm = await measurePhase({
      service: healthy.service,
      counts: healthy.counts,
      action: async () => {
        for (let index = 0; index < 100; index += 1) {
          writeFileSync(path.join(ignoredDir, `artifact-${index}.txt`), `${index}\n`);
        }
        await sleep(1_200);
      },
    });

    if (phases.idle.gitCommands !== 0 || phases.ignoredStorm.gitCommands !== 0) {
      throw new Error("Idle and ignored-storm phases must perform zero Git commands");
    }
    if (phases.editBurst.producers.worktree > 2 || phases.editBurst.producers.detailedDiff > 2) {
      throw new Error("One hundred edits exceeded two final-state refresh generations");
    }

    diffSubscription.unsubscribe();
    diffSubscription = null;
    summarySubscription.unsubscribe();
    summarySubscription = null;
    diffManager.dispose();
    diffManager = null;
    await closeMeasuredService({
      service: healthy.service,
      subscriptions: healthy.watcher.subscriptions,
    });
    healthy = null;

    degraded = createMeasuredService({ repoDir, paseoHome, failWorktreeWatch: true });
    startGitCommandMetrics();
    const degradedBootstrapStartedAtMs = Date.now();
    const degradedBootstrapCounts = snapshotCounts(degraded.counts);
    summarySubscription = degraded.service.registerWorkspace({ cwd: repoDir }, () => {});
    await waitFor(
      () =>
        degraded?.service.peekSnapshot(repoDir) !== null &&
        degraded.service.getMetrics().workspaceObservationSetupInFlightCount === 0,
      "degraded bootstrap",
    );
    await sleep(250);
    const degradedBootstrapMetrics = stopGitCommandMetrics();
    const degradedBootstrapServiceMetrics = degraded.service.getMetrics();
    phases.degradedBootstrap = {
      elapsedMs: Date.now() - degradedBootstrapStartedAtMs,
      gitCommands: degradedBootstrapMetrics.total,
      failedGitCommands: degradedBootstrapMetrics.failed,
      maxConcurrentGitCommands: degradedBootstrapMetrics.maxConcurrent,
      byCommand: summarizeCommands(degradedBootstrapMetrics),
      producers: subtractCounts(degraded.counts, degradedBootstrapCounts),
      queueAfter: {
        inFlight: degradedBootstrapServiceMetrics.workspaceRefreshInFlightCount,
        queued: degradedBootstrapServiceMetrics.workspaceRefreshQueuedCount,
      },
    };

    phases.degradedWatcher = await measurePhase({
      service: degraded.service,
      counts: degraded.counts,
      action: async () => {
        const refreshCount = degraded?.counts.worktree ?? 0;
        await waitFor(
          () => (degraded?.counts.worktree ?? 0) > refreshCount,
          "degraded watcher poll",
          8_000,
        );
      },
    });

    const report = {
      generatedAt: new Date().toISOString(),
      phases,
    };
    const outputPath = process.env.PASEO_GIT_OBSERVATION_REPORT?.trim();
    if (outputPath) {
      await writeFile(path.resolve(outputPath), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    }
    process.stdout.write(`GIT_OBSERVATION_MEASUREMENT ${JSON.stringify(report)}\n`);
  } finally {
    stopGitCommandMetrics();
    diffSubscription?.unsubscribe();
    summarySubscription?.unsubscribe();
    diffManager?.dispose();
    if (healthy) {
      await closeMeasuredService({
        service: healthy.service,
        subscriptions: healthy.watcher.subscriptions,
      }).catch(() => {});
    }
    if (degraded) {
      await closeMeasuredService({
        service: degraded.service,
        subscriptions: degraded.watcher.subscriptions,
      }).catch(() => {});
    }
    rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
