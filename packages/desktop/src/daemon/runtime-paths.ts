import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { spawnProcess } from "@getpaseo/server";
import { createRequire } from "node:module";
import path from "node:path";
import { app } from "electron";
import log from "electron-log/main";
import {
  DESKTOP_CLI_ENV,
  createNodeEntrypointInvocation as createSharedNodeEntrypointInvocation,
  parseCliPassthroughArgsFromArgv as parseCliPassthroughArgs,
  type NodeEntrypointArgvMode,
  type NodeEntrypointInvocation,
  type NodeEntrypointSpec,
} from "./node-entrypoint-launcher.js";

const CLI_PACKAGE_NAME = "@getpaseo/cli";
const SERVER_PACKAGE_NAME = "@getpaseo/server";
const CLI_BIN_ENTRY = `${CLI_PACKAGE_NAME}/bin/paseo`;

type PackageInfo = {
  root: string;
};

const esmRequire = createRequire(__filename);

function findPackageRootFromResolvedPath(input: {
  resolvedPath: string;
  packageName: string;
}): PackageInfo {
  let currentDir = path.dirname(input.resolvedPath);

  while (true) {
    const packageJsonPath = path.join(currentDir, "package.json");
    if (existsSync(packageJsonPath)) {
      try {
        const pkg = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as {
          name?: string;
        };
        if (pkg.name === input.packageName) {
          return {
            root: currentDir,
          };
        }
      } catch {
        // Ignore malformed package metadata while walking up.
      }
    }

    const parent = path.dirname(currentDir);
    if (parent === currentDir) {
      break;
    }
    currentDir = parent;
  }

  throw new Error(`Unable to resolve ${input.packageName} package root`);
}

function resolveServerPackageInfo(): PackageInfo {
  const serverExportPath = esmRequire.resolve(SERVER_PACKAGE_NAME);
  return findPackageRootFromResolvedPath({
    resolvedPath: serverExportPath,
    packageName: SERVER_PACKAGE_NAME,
  });
}

function resolveCliPackageInfo(): PackageInfo {
  const cliBinPath = esmRequire.resolve(CLI_BIN_ENTRY);
  return findPackageRootFromResolvedPath({
    resolvedPath: cliBinPath,
    packageName: CLI_PACKAGE_NAME,
  });
}

function resolvePackagedAsarPath(): string {
  return path.join(process.resourcesPath, "app.asar");
}

function resolvePackagedNodeEntrypointRunnerPath(): string {
  return path.join(
    process.resourcesPath,
    "app.asar.unpacked",
    "dist",
    "daemon",
    "node-entrypoint-runner.js",
  );
}

function assertPathExists(input: { label: string; filePath: string }): string {
  if (!existsSync(input.filePath)) {
    throw new Error(`${input.label} is missing at ${input.filePath}`);
  }

  return input.filePath;
}

export function parseCliPassthroughArgsFromArgv(argv: string[]): string[] | null {
  return parseCliPassthroughArgs({
    argv,
    isDefaultApp: process.defaultApp,
    forceCli: process.env[DESKTOP_CLI_ENV] === "1",
  });
}

export function resolveDaemonRunnerEntrypoint(): NodeEntrypointSpec {
  if (app.isPackaged) {
    return {
      entryPath: assertPathExists({
        label: "Bundled daemon runner",
        filePath: path.join(
          resolvePackagedAsarPath(),
          "node_modules",
          "@getpaseo",
          "server",
          "dist",
          "scripts",
          "supervisor-entrypoint.js",
        ),
      }),
      execArgv: [],
    };
  }

  const serverPackage = resolveServerPackageInfo();
  const distRunner = path.join(serverPackage.root, "dist", "scripts", "supervisor-entrypoint.js");
  if (existsSync(distRunner)) {
    return {
      entryPath: distRunner,
      execArgv: [],
    };
  }

  return {
    entryPath: assertPathExists({
      label: "Daemon runner source",
      filePath: path.join(serverPackage.root, "scripts", "supervisor-entrypoint.ts"),
    }),
    execArgv: ["--import", "tsx"],
  };
}

export function resolveCliEntrypoint(): NodeEntrypointSpec {
  if (app.isPackaged) {
    return {
      entryPath: assertPathExists({
        label: "Bundled CLI entrypoint",
        filePath: path.join(
          resolvePackagedAsarPath(),
          "node_modules",
          "@getpaseo",
          "cli",
          "dist",
          "index.js",
        ),
      }),
      execArgv: [],
    };
  }

  const cliPackage = resolveCliPackageInfo();
  const distEntry = path.join(cliPackage.root, "dist", "index.js");
  if (existsSync(distEntry)) {
    return {
      entryPath: distEntry,
      execArgv: [],
    };
  }

  return {
    entryPath: assertPathExists({
      label: "CLI source entrypoint",
      filePath: path.join(cliPackage.root, "src", "index.ts"),
    }),
    execArgv: ["--import", "tsx"],
  };
}

function resolveNodeExecPath(): string {
  if (app.isPackaged && process.platform === "darwin") {
    const marker = ".app/Contents/MacOS/";
    const markerIndex = process.execPath.indexOf(marker);
    if (markerIndex !== -1) {
      const bundleRoot = process.execPath.substring(0, markerIndex + ".app".length);
      const name = path.basename(process.execPath);
      const helperPath = path.join(
        bundleRoot,
        "Contents",
        "Frameworks",
        `${name} Helper.app`,
        "Contents",
        "MacOS",
        `${name} Helper`,
      );
      if (existsSync(helperPath)) {
        return helperPath;
      }
    }
  }
  return process.execPath;
}

export function createNodeEntrypointInvocation(input: {
  entrypoint: NodeEntrypointSpec;
  argvMode: NodeEntrypointArgvMode;
  args: string[];
  baseEnv: NodeJS.ProcessEnv;
}): NodeEntrypointInvocation {
  return createSharedNodeEntrypointInvocation({
    execPath: resolveNodeExecPath(),
    isPackaged: app.isPackaged,
    packagedRunnerPath: app.isPackaged
      ? assertPathExists({
          label: "Bundled node entrypoint runner",
          filePath: resolvePackagedNodeEntrypointRunnerPath(),
        })
      : null,
    entrypoint: input.entrypoint,
    argvMode: input.argvMode,
    args: input.args,
    baseEnv: input.baseEnv,
  });
}

function createCliInvocation(args: string[]): NodeEntrypointInvocation {
  const cli = resolveCliEntrypoint();
  return createNodeEntrypointInvocation({
    entrypoint: cli,
    argvMode: "node-script",
    args,
    baseEnv: process.env,
  });
}

export function runCliPassthroughCommand(args: string[]): number {
  const invocation = createCliInvocation(args);
  const result = spawnSync(invocation.command, invocation.args, {
    env: invocation.env,
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.error) {
    throw result.error;
  }

  if (typeof result.status === "number") {
    return result.status;
  }

  return result.signal ? 1 : 0;
}

function spawnAsync(
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv },
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(command, args, {
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout!.on("data", (data: Buffer) => {
      stdout += data.toString();
    });
    child.stderr!.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    child.on("error", reject);
    child.on("close", (exitCode) => {
      resolve({ stdout, stderr, exitCode });
    });
  });
}

export async function runCliTextCommand(args: string[]): Promise<string> {
  const invocation = createCliInvocation(args);
  const result = await spawnAsync(invocation.command, invocation.args, {
    env: invocation.env,
  });

  if (result.exitCode !== 0) {
    const stderr = result.stderr.trim();
    const stdout = result.stdout.trim();
    log.warn("[desktop cli]", `CLI text command failed`, {
      args,
      exitCode: result.exitCode,
      stdout: stdout.slice(0, 500),
      stderr: stderr.slice(0, 500),
    });
    throw new Error(
      stderr.length > 0
        ? stderr
        : `CLI command failed with exit code ${result.exitCode}${stdout.length > 0 ? `\nstdout: ${stdout.slice(0, 200)}` : ""}`,
    );
  }

  return result.stdout.trimEnd();
}

export async function runCliJsonCommand(args: string[]): Promise<unknown> {
  const invocation = createCliInvocation(args);
  const result = await spawnAsync(invocation.command, invocation.args, {
    env: invocation.env,
  });

  if (result.exitCode !== 0) {
    const stderr = result.stderr.trim();
    const stdout = result.stdout.trim();
    log.warn("[desktop cli]", `CLI command failed`, {
      args,
      exitCode: result.exitCode,
      stdout: stdout.slice(0, 500),
      stderr: stderr.slice(0, 500),
      command: invocation.command,
    });
    throw new Error(
      stderr.length > 0
        ? stderr
        : `CLI command failed with exit code ${result.exitCode}${stdout.length > 0 ? `\nstdout: ${stdout.slice(0, 200)}` : ""}`,
    );
  }

  const stdout = result.stdout.trim();
  if (stdout.length === 0) {
    log.warn("[desktop cli]", `CLI command produced no output`, { args });
    throw new Error("CLI command did not produce JSON output.");
  }

  // The stdout may contain non-JSON preamble (e.g. Node deprecation warnings).
  // Extract the first valid JSON object or array from the output.
  const jsonStart = stdout.search(/[{[]/);
  if (jsonStart < 0) {
    log.warn("[desktop cli]", `CLI command output contained no JSON`, {
      args,
      stdout: stdout.slice(0, 500),
    });
    throw new Error(`CLI command output contained no JSON. Output: ${stdout.slice(0, 200)}`);
  }
  const jsonText = stdout.slice(jsonStart);

  try {
    return JSON.parse(jsonText) as unknown;
  } catch (error) {
    throw new Error(
      `CLI command returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
