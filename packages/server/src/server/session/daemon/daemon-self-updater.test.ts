import { describe, expect, test } from "vitest";
import {
  DaemonSelfUpdateInProgressError,
  DaemonSelfUpdater,
  type DaemonSelfUpdateRuntime,
  type DaemonSelfUpdatePhase,
} from "./daemon-self-updater.js";
import type { CommandResult, NpmGlobalPaseoInstall } from "./npm-global-cli.js";

interface TestLogger {
  errors: Array<{ obj: object; msg?: string }>;
  warnings: Array<{ obj: object; msg?: string }>;
  error(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
}

type Inspection = NpmGlobalPaseoInstall | Error;
type RuntimeCall = "inspect" | "installLatest";

const globalRoot = "/global/lib";
const globalNodeModules = `${globalRoot}/node_modules`;
const cliPackagePath = `${globalNodeModules}/@getpaseo/cli`;
const npmServerPackageRoot = `${cliPackagePath}/node_modules/@getpaseo/server`;
const sourceServerPackageRoot = "/repo/packages/server";

function npmGlobalPaseoInstall(
  version: string,
  options?: { linked?: boolean },
): NpmGlobalPaseoInstall {
  return {
    version,
    packagePath: cliPackagePath,
    globalRootPath: globalRoot,
    isLinked: options?.linked === true,
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
  inspections: Inspection[];
  currentServerPackageRoot?: string | null;
  installResult?: CommandResult;
  calls?: RuntimeCall[];
}): DaemonSelfUpdateRuntime {
  const calls = input.calls ?? [];
  return {
    npm: {
      async inspect() {
        calls.push("inspect");
        const inspection = input.inspections.shift();
        if (!inspection) {
          throw new Error("Unexpected npm global install inspection");
        }
        if (inspection instanceof Error) {
          throw inspection;
        }
        return inspection;
      },
      async installLatest() {
        calls.push("installLatest");
        return input.installResult ?? { exitCode: 0, stdout: "changed 42 packages", stderr: "" };
      },
    },
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
  test("refuses a Desktop-managed daemon without touching npm", async () => {
    const calls: RuntimeCall[] = [];
    const runtime = createRuntime({ calls, inspections: [] });

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
    const calls: RuntimeCall[] = [];
    const runtime = createRuntime({
      calls,
      inspections: [npmGlobalPaseoInstall("0.1.15"), npmGlobalPaseoInstall("0.1.96")],
    });

    const { result, phases } = await runUpdate({ runtime });

    expect(result).toEqual({
      success: true,
      error: null,
      newVersion: "0.1.96",
    });
    expect(phases).toEqual(["starting", "downloading", "installing", "complete"]);
    expect(calls).toEqual(["inspect", "installLatest", "inspect"]);
  });

  test("does not run install when npm global cli is missing", async () => {
    const calls: RuntimeCall[] = [];
    const runtime = createRuntime({
      calls,
      inspections: [new Error("@getpaseo/cli is not installed with npm -g on this host")],
    });

    const { result, phases } = await runUpdate({ runtime });

    expect(result.success).toBe(false);
    expect(result.error).toBe("@getpaseo/cli is not installed with npm -g on this host");
    expect(phases).toEqual(["starting"]);
    expect(calls).toEqual(["inspect"]);
  });

  test("does not update a daemon whose version does not match the npm global cli", async () => {
    const calls: RuntimeCall[] = [];
    const runtime = createRuntime({
      calls,
      inspections: [npmGlobalPaseoInstall("0.1.15")],
    });

    const { result } = await runUpdate({ runtime, daemonVersion: "0.1.96" });

    expect(result).toEqual({
      success: false,
      error:
        "This daemon is not running from the npm global @getpaseo/cli install (global npm has 0.1.15, daemon is 0.1.96).",
      newVersion: null,
    });
    expect(calls).toEqual(["inspect"]);
  });

  test("does not update a daemon running outside the npm global package tree", async () => {
    const calls: RuntimeCall[] = [];
    const runtime = createRuntime({
      calls,
      currentServerPackageRoot: sourceServerPackageRoot,
      inspections: [npmGlobalPaseoInstall("0.1.15")],
    });

    const { result } = await runUpdate({ runtime });

    expect(result).toEqual({
      success: false,
      error: "This daemon is not running from the npm global @getpaseo/cli install.",
      newVersion: null,
    });
    expect(calls).toEqual(["inspect"]);
  });

  test("does not update linked global installs", async () => {
    const runtime = createRuntime({
      inspections: [npmGlobalPaseoInstall("0.1.15", { linked: true })],
    });

    const { result } = await runUpdate({ runtime });

    expect(result).toEqual({
      success: false,
      error:
        "The global @getpaseo/cli install is linked; self-update only supports normal npm global installs.",
      newVersion: null,
    });
  });

  test("rejects concurrent update requests", async () => {
    const calls: RuntimeCall[] = [];
    let resolveInstall: ((result: CommandResult) => void) | null = null;
    let installStartedResolve: (() => void) | null = null;
    const installStarted = new Promise<void>((resolve) => {
      installStartedResolve = resolve;
    });
    const runtime: DaemonSelfUpdateRuntime = {
      npm: {
        async inspect() {
          calls.push("inspect");
          return npmGlobalPaseoInstall("0.1.15");
        },
        async installLatest() {
          calls.push("installLatest");
          installStartedResolve?.();
          return new Promise<CommandResult>((resolve) => {
            resolveInstall = resolve;
          });
        },
      },
      installOrigin: {
        resolveCurrentServerPackageRoot() {
          return npmServerPackageRoot;
        },
      },
    };
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
