import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { Command } from "commander";
import { readPersistedConfig, type PersistedConfig } from "@getpaseo/server/configuration";
import type {
  CommandError,
  CommandOptions,
  OutputSchema,
  SingleResult,
} from "../../output/index.js";
import {
  buildPathScriptPreviewInputs,
  parseRemoteOwnerAndRepo,
  PATH_SCRIPT_MODES,
  type PathScriptMode,
} from "./path-script-preview-input.js";

const CONFIG_FILENAME = "config.json";
const execFileAsync = promisify(execFile);

export interface PathScriptPreviewOptions extends CommandOptions {
  path?: string;
  branch?: string;
  slug?: string;
  mode?: string;
  baseRef?: string;
}

export interface PathScriptPreviewResult {
  scriptPath: string;
  configPath: string;
  cwd: string;
  argv: string[];
  env: Record<string, string>;
}

export interface PathScriptPreviewDeps {
  readConfig: (paseoHome: string) => PersistedConfig;
  runGit: (args: string[], cwd: string) => Promise<string>;
}

// Only reads git metadata. The configured script is never passed to any
// process-spawning dep, so the preview cannot execute it.
export const defaultPathScriptPreviewDeps: PathScriptPreviewDeps = {
  readConfig: (paseoHome) => readPersistedConfig(paseoHome),
  runGit: async (args, cwd) => {
    const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf8" });
    return stdout;
  },
};

function cmdError(code: string, message: string, details?: string): CommandError {
  return details ? { code, message, details } : { code, message };
}

const pathScriptPreviewSchema: OutputSchema<PathScriptPreviewResult> = {
  idField: "scriptPath",
  columns: [],
  renderHuman: (result) => {
    const data = result.data as PathScriptPreviewResult;
    const lines = [
      `Script: ${data.scriptPath}`,
      `Source: ${data.configPath} (reflects config on disk; restart the daemon to create worktrees with it)`,
      "Not executed: run the script yourself with these values to see the path it returns.",
      "",
      `cwd: ${data.cwd}`,
      "",
      "argv:",
      ...data.argv.map((value, index) => `  $${index + 1}  ${value}`),
      "",
      "env:",
      ...Object.entries(data.env).map(([name, value]) => `  ${name}=${value}`),
    ];
    return lines.join("\n");
  },
};

function normalizePath(input: string): string {
  try {
    return realpathSync(input);
  } catch {
    return path.resolve(input);
  }
}

async function resolveRepoPath(cwd: string, runGit: PathScriptPreviewDeps["runGit"]) {
  let commonDirOutput: string;
  try {
    commonDirOutput = await runGit(["rev-parse", "--git-common-dir"], cwd);
  } catch {
    throw cmdError("NOT_A_GIT_REPO", `${cwd} is not inside a git repository`);
  }
  const commonDir = normalizePath(path.resolve(cwd, commonDirOutput.trim()));
  return path.basename(commonDir) === ".git" ? path.dirname(commonDir) : commonDir;
}

async function resolvePrimaryRemote(
  repoPath: string,
  runGit: PathScriptPreviewDeps["runGit"],
): Promise<{ owner: string; remoteRepo: string }> {
  const empty = { owner: "", remoteRepo: "" };
  let remoteNames: string[];
  try {
    const names = await runGit(["remote"], repoPath);
    remoteNames = names
      .split("\n")
      .map((name) => name.trim())
      .filter((name) => name.length > 0);
  } catch {
    return empty;
  }
  const primary = remoteNames.includes("origin") ? "origin" : remoteNames[0];
  if (!primary) {
    return empty;
  }
  try {
    const remoteUrl = await runGit(["remote", "get-url", primary], repoPath);
    return parseRemoteOwnerAndRepo(remoteUrl.trim());
  } catch {
    return empty;
  }
}

function parseMode(value: string): PathScriptMode {
  const match = PATH_SCRIPT_MODES.find((mode) => mode === value);
  if (!match) {
    throw cmdError(
      "INVALID_MODE",
      `Invalid --mode '${value}'`,
      `Expected one of: ${PATH_SCRIPT_MODES.join(", ")}`,
    );
  }
  return match;
}

export async function runPathScriptPreviewCommandWithDeps(
  options: PathScriptPreviewOptions,
  deps: PathScriptPreviewDeps,
): Promise<SingleResult<PathScriptPreviewResult>> {
  if (options.daemonTarget.kind !== "instance") {
    throw cmdError(
      "LOCAL_DAEMON_REQUIRED",
      "paseo worktree path-script-preview reads the local daemon config; it needs --home",
    );
  }
  const paseoHome = options.daemonTarget.home;
  const configPath = path.join(paseoHome, CONFIG_FILENAME);

  const persisted = deps.readConfig(paseoHome);
  const scriptPath = persisted.worktrees?.pathScript;
  if (typeof scriptPath !== "string" || scriptPath.length === 0) {
    throw cmdError("PATH_SCRIPT_NOT_SET", `worktrees.pathScript is not set in ${configPath}`);
  }

  if (!options.branch) {
    throw cmdError("MISSING_BRANCH", "--branch is required");
  }
  const mode = parseMode(options.mode ?? "branch-off");
  const cwd = path.resolve(options.path ?? process.cwd());
  const repoPath = await resolveRepoPath(cwd, deps.runGit);
  const remote = await resolvePrimaryRemote(repoPath, deps.runGit);
  const inputs = buildPathScriptPreviewInputs({
    repoPath,
    owner: remote.owner,
    remoteRepo: remote.remoteRepo,
    branchName: options.branch,
    slug: options.slug,
    mode,
    baseRef: options.baseRef ?? "",
    paseoHome,
  });

  return {
    type: "single",
    data: {
      scriptPath,
      configPath,
      cwd: repoPath,
      argv: inputs.argv,
      env: inputs.env,
    },
    schema: pathScriptPreviewSchema,
  };
}

export async function runPathScriptPreviewCommand(
  options: PathScriptPreviewOptions,
  _command: Command,
): Promise<SingleResult<PathScriptPreviewResult>> {
  return runPathScriptPreviewCommandWithDeps(options, defaultPathScriptPreviewDeps);
}
