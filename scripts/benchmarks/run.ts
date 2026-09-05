import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { benchmarkTasks, type BenchmarkTaskDefinition } from "./tasks";
import {
  parseBenchmarkTaskResult,
  type BenchmarkRunResult,
  type BenchmarkTaskResult,
} from "./types";

type BenchmarkCommand =
  | { kind: "list" }
  | { kind: "run"; taskIds: string[]; outputPath: string | null };

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function parseCommand(args: string[]): BenchmarkCommand {
  const taskIds: string[] = [];
  let outputPath: string | null = null;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--list") {
      return { kind: "list" };
    }
    if (arg === "--output") {
      const value = args[index + 1];
      if (!value) {
        throw new Error("--output requires a file path");
      }
      outputPath = resolve(value);
      index += 1;
      continue;
    }
    if (arg?.startsWith("--output=")) {
      const value = arg.slice("--output=".length);
      if (!value) {
        throw new Error("--output requires a file path");
      }
      outputPath = resolve(value);
      continue;
    }
    if (arg?.startsWith("-")) {
      throw new Error(`unknown option: ${arg}`);
    }
    if (arg) {
      taskIds.push(arg);
    }
  }
  return { kind: "run", taskIds, outputPath };
}

function selectTasks(taskIds: string[]): BenchmarkTaskDefinition[] {
  if (taskIds.length === 0) {
    return benchmarkTasks;
  }
  const tasksById = new Map(benchmarkTasks.map((task) => [task.id, task]));
  return taskIds.map((taskId) => {
    const task = tasksById.get(taskId);
    if (!task) {
      throw new Error(`unknown benchmark task: ${taskId}`);
    }
    return task;
  });
}

function runTask(task: BenchmarkTaskDefinition, resultPath: string): BenchmarkTaskResult {
  process.stderr.write(`[benchmark] running ${task.id}: ${task.description}\n`);
  const child = spawnSync(task.command, task.args, {
    cwd: resolve(repoRoot, task.cwd ?? "."),
    env: {
      ...process.env,
      ...task.env,
      PASEO_BENCHMARK_OUTPUT: resultPath,
      PASEO_BENCHMARK_QUIET: "1",
    },
    stdio: "inherit",
  });
  if (child.error) {
    throw child.error;
  }
  if (child.status !== 0) {
    throw new Error(`benchmark task ${task.id} exited with status ${child.status ?? "unknown"}`);
  }

  const parsed = parseBenchmarkTaskResult(JSON.parse(readFileSync(resultPath, "utf8")));
  if (parsed.taskId !== task.id) {
    throw new Error(`benchmark task ${task.id} returned taskId ${parsed.taskId}`);
  }
  return parsed;
}

function readGit(args: string[]): string {
  const child = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8" });
  if (child.error) {
    throw child.error;
  }
  if (child.status !== 0) {
    throw new Error(`git ${args.join(" ")} exited with status ${child.status ?? "unknown"}`);
  }
  return child.stdout.trim();
}

function main(): void {
  const command = parseCommand(process.argv.slice(2));
  if (command.kind === "list") {
    for (const task of benchmarkTasks) {
      process.stdout.write(`${task.id}\t${task.description}\n`);
    }
    return;
  }

  const selectedTasks = selectTasks(command.taskIds);
  const workDir = mkdtempSync(join(tmpdir(), "paseo-benchmark-"));
  try {
    const tasks = selectedTasks.map((task) => runTask(task, join(workDir, `${task.id}.json`)));
    const result: BenchmarkRunResult = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      source: {
        gitCommit: readGit(["rev-parse", "HEAD"]),
        gitDirty: readGit(["status", "--porcelain"]).length > 0,
      },
      runtime: {
        nodeVersion: process.version,
        platform: process.platform,
        arch: process.arch,
      },
      tasks,
    };
    const serialized = `${JSON.stringify(result, null, 2)}\n`;
    if (command.outputPath) {
      writeFileSync(command.outputPath, serialized);
      process.stderr.write(`[benchmark] wrote ${command.outputPath}\n`);
    } else {
      process.stdout.write(serialized);
    }
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

main();
