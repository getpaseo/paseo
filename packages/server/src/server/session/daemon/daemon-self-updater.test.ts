import path from "node:path";
import { describe, expect, test } from "vitest";
import type {
  CommandResult,
  GlobalCliPackageManager,
  GlobalPaseoInstall,
  PackageManagerName,
} from "./global-cli.js";
import {
  DaemonSelfUpdateInProgressError,
  DaemonSelfUpdater,
  type DaemonSelfUpdatePhase,
  type DaemonSelfUpdateRuntime,
} from "./daemon-self-updater.js";

interface TestLogger {
  errors: Array<{ obj: object; msg?: string }>;
  warnings: Array<{ obj: object; msg?: string }>;
  error(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
}

const npmGlobalRoot = path.join(path.sep, "global", "lib");
const npmGlobalNodeModules = path.join(npmGlobalRoot, "node_modules");
const npmCliPackagePath = path.join(npmGlobalNodeModules, "@getpaseo", "cli");
const npmServerPackageRoot = path.join(npmCliPackagePath, "node_modules", "@getpaseo", "server");

const pnpmGlobalRoot = path.join(path.sep, "home", "dev", ".pnpm", "global", "v11");
const pnpmHome = path.dirname(path.dirname(pnpmGlobalRoot));
const pnpmCliPackagePath = path.join(pnpmGlobalRoot, "abc", "node_modules", "@getpaseo", "cli");
const pnpmServerPackageRoot = path.join(
  pnpmHome,
  "store",
  "v11",
  "links",
  "@getpaseo",
  "server",
  "0.1.15",
  "hash",
  "node_modules",
  "@getpaseo",
  "server",
);

const sourceServerPackageRoot = path.join(path.sep, "repo", "packages", "server");

function npmInstall(version: string, options?: { linked?: boolean }): GlobalPaseoInstall {
  return {
    packageManager: "npm",
    version,
    packagePath: npmCliPackagePath,
    isLinked: options?.linked === true,
    containmentRoots: [npmCliPackagePath, npmGlobalNodeModules],
  };
}

function pnpmInstall(version: string): GlobalPaseoInstall {
  return {
    packageManager: "pnpm",
    version,
    packagePath: pnpmCliPackagePath,
    isLinked: false,
    containmentRoots: [pnpmGlobalRoot, pnpmHome],
  };
}

interface ManagerSpec {
  name: PackageManagerName;
  inspections: Array<GlobalPaseoInstall | null>;
  installResult?: CommandResult;
  calls?: string[];
}

function createManager(spec: ManagerSpec): GlobalCliPackageManager {
  return {
    name: spec.name,
    async inspect() {
      spec.calls?.push("inspect");
      if (spec.inspections.length === 0) {
        throw new Error(`Unexpected ${spec.name} inspect`);
      }
      return spec.inspections.shift() ?? null;
    },
    async installLatest() {
      spec.calls?.push("installLatest");
      return spec.installResult ?? { exitCode: 0, stdout: "changed 42 packages", stderr: "" };
    },
  };
}

function createLogger(): TestLogger {
  return {
    errors: [],
    warnings: [],
    error(obj, msg) {
      this.errors.push({ obj, msg });
    },
    warn(obj, msg) {
      this.warnings.push({ obj, msg });
    },
  };
}

function createRuntime(input: {
  managers: GlobalCliPackageManager[];
  currentServerPackageRoot?: string | null;
}): DaemonSelfUpdateRuntime {
  return {
    managers: input.managers,
    installOrigin: {
      resolveCurrentServerPackageRoot() {
        return input.currentServerPackageRoot ?? npmServerPackageRoot;
      },
    },
  };
}

async function runUpdate(input: {
  runtime: DaemonSelfUpdateRuntime;
  daemonVersion?: string | null;
  desktopManaged?: boolean;
  phases?: DaemonSelfUpdatePhase[];
}) {
  const logger = createLogger();
  const updater = new DaemonSelfUpdater(input.runtime);
  const phases = input.phases ?? [];
  const result = await updater.update({
    daemonVersion: input.daemonVersion ?? "0.1.15",
    desktopManaged: input.desktopManaged ?? false,
    onProgress: (phase) => phases.push(phase),
    logger,
  });
  return { result, logger, phases };
}

describe("DaemonSelfUpdater", () => {
  test("refuses a Desktop-managed daemon without probing any package manager", async () => {
    const calls: string[] = [];
    const runtime = createRuntime({
      managers: [createManager({ name: "npm", inspections: [], calls })],
    });

    const { result, phases } = await runUpdate({ runtime, desktopManaged: true });

    expect(result).toEqual({
      success: false,
      error: "This daemon is managed by Paseo Desktop. Update Paseo Desktop on the host.",
      newVersion: null,
    });
    expect(phases).toEqual([]);
    expect(calls).toEqual([]);
  });

  test("updates a daemon that is running from the npm global cli install", async () => {
    const calls: string[] = [];
    const runtime = createRuntime({
      managers: [
        createManager({
          name: "npm",
          inspections: [npmInstall("0.1.15"), npmInstall("0.1.96")],
          calls,
        }),
      ],
    });

    const { result, phases } = await runUpdate({ runtime });

    expect(result).toEqual({ success: true, error: null, newVersion: "0.1.96" });
    expect(phases).toEqual(["starting", "downloading", "installing", "complete"]);
    expect(calls).toEqual(["inspect", "installLatest", "inspect"]);
  });

  test("updates a daemon that is running from the pnpm global cli install", async () => {
    const npmCalls: string[] = [];
    const pnpmCalls: string[] = [];
    const runtime = createRuntime({
      currentServerPackageRoot: pnpmServerPackageRoot,
      managers: [
        // npm also has a copy globally, but it is not the daemon we are running.
        createManager({ name: "npm", inspections: [npmInstall("0.1.15")], calls: npmCalls }),
        createManager({
          name: "pnpm",
          inspections: [pnpmInstall("0.1.15"), pnpmInstall("0.1.96")],
          installResult: { exitCode: 0, stdout: "Packages: +1", stderr: "" },
          calls: pnpmCalls,
        }),
      ],
    });

    const { result, phases } = await runUpdate({ runtime });

    expect(result).toEqual({ success: true, error: null, newVersion: "0.1.96" });
    expect(phases).toEqual(["starting", "downloading", "installing", "complete"]);
    expect(npmCalls).toEqual(["inspect"]);
    expect(pnpmCalls).toEqual(["inspect", "installLatest", "inspect"]);
  });

  test("does not run install when the cli is not installed globally", async () => {
    const calls: string[] = [];
    const runtime = createRuntime({
      managers: [createManager({ name: "npm", inspections: [null], calls })],
    });

    const { result, phases } = await runUpdate({ runtime });

    expect(result.success).toBe(false);
    expect(result.error).toBe(
      "@getpaseo/cli is not installed globally with npm or pnpm on this host.",
    );
    expect(phases).toEqual(["starting"]);
    expect(calls).toEqual(["inspect"]);
  });

  test("does not update a daemon whose version does not match the global cli", async () => {
    const calls: string[] = [];
    const runtime = createRuntime({
      managers: [createManager({ name: "npm", inspections: [npmInstall("0.1.15")], calls })],
    });

    const { result } = await runUpdate({ runtime, daemonVersion: "0.1.96" });

    expect(result).toEqual({
      success: false,
      error:
        "This daemon is not running from the global @getpaseo/cli install (global npm has 0.1.15, daemon is 0.1.96).",
      newVersion: null,
    });
    expect(calls).toEqual(["inspect"]);
  });

  test("does not update a daemon running outside the global package tree", async () => {
    const calls: string[] = [];
    const runtime = createRuntime({
      currentServerPackageRoot: sourceServerPackageRoot,
      managers: [createManager({ name: "npm", inspections: [npmInstall("0.1.15")], calls })],
    });

    const { result } = await runUpdate({ runtime });

    expect(result).toEqual({
      success: false,
      error: "This daemon is not running from a global @getpaseo/cli install.",
      newVersion: null,
    });
    expect(calls).toEqual(["inspect"]);
  });

  test("does not update linked global installs", async () => {
    const runtime = createRuntime({
      managers: [
        createManager({ name: "npm", inspections: [npmInstall("0.1.15", { linked: true })] }),
      ],
    });

    const { result } = await runUpdate({ runtime });

    expect(result).toEqual({
      success: false,
      error:
        "The global @getpaseo/cli install is linked; self-update only supports normal global installs.",
      newVersion: null,
    });
  });

  test("surfaces the package manager in the install failure", async () => {
    const runtime = createRuntime({
      managers: [
        createManager({
          name: "pnpm",
          inspections: [pnpmInstall("0.1.15")],
          installResult: { exitCode: 1, stdout: "", stderr: "" },
        }),
      ],
      currentServerPackageRoot: pnpmServerPackageRoot,
    });

    const { result } = await runUpdate({ runtime });

    expect(result).toEqual({
      success: false,
      error: "pnpm exited with code 1",
      newVersion: null,
    });
  });

  test("rejects concurrent update requests", async () => {
    const calls: string[] = [];
    let resolveInstall: ((result: CommandResult) => void) | null = null;
    let installStartedResolve: (() => void) | null = null;
    const installStarted = new Promise<void>((resolve) => {
      installStartedResolve = resolve;
    });
    const manager: GlobalCliPackageManager = {
      name: "npm",
      async inspect() {
        calls.push("inspect");
        return npmInstall("0.1.15");
      },
      async installLatest() {
        calls.push("installLatest");
        installStartedResolve?.();
        return new Promise<CommandResult>((resolve) => {
          resolveInstall = resolve;
        });
      },
    };
    const runtime = createRuntime({ managers: [manager] });
    const logger = createLogger();
    const updater = new DaemonSelfUpdater(runtime);

    const firstUpdate = updater.update({
      daemonVersion: "0.1.15",
      desktopManaged: false,
      onProgress: () => {},
      logger,
    });
    await installStarted;

    await expect(
      updater.update({
        daemonVersion: "0.1.15",
        desktopManaged: false,
        onProgress: () => {},
        logger,
      }),
    ).rejects.toBeInstanceOf(DaemonSelfUpdateInProgressError);

    resolveInstall?.({ exitCode: 0, stdout: "updated", stderr: "" });
    await expect(firstUpdate).resolves.toMatchObject({ success: true });
    expect(calls).toEqual(["inspect", "installLatest", "inspect"]);
  });
});
