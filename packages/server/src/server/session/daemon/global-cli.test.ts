import path from "node:path";
import { describe, expect, test } from "vitest";
import { DefaultNpmGlobalCli, DefaultPnpmGlobalCli, type CommandOptions } from "./global-cli.js";

interface CommandCall {
  command: string;
  args: string[];
  timeout?: number;
  maxBuffer?: number;
}

const npmGlobalRoot = path.join(path.sep, "global", "lib");
const npmGlobalNodeModules = path.join(npmGlobalRoot, "node_modules");
const npmCliPackagePath = path.join(npmGlobalNodeModules, "@getpaseo", "cli");

function npmGlobalPaseoCliJson(version: string, options?: { linked?: boolean }): string {
  return JSON.stringify({
    name: "lib",
    path: npmGlobalRoot,
    dependencies: {
      "@getpaseo/cli": {
        version,
        path: npmCliPackagePath,
        link: options?.linked === true,
      },
    },
  });
}

const pnpmGlobalRoot = path.join(path.sep, "home", "dev", ".pnpm", "global", "v11");
const pnpmHome = path.dirname(path.dirname(pnpmGlobalRoot));
const pnpmCliPackagePath = path.join(pnpmGlobalRoot, "abc123", "node_modules", "@getpaseo", "cli");

function pnpmGlobalPaseoCliJson(version: string): string {
  return JSON.stringify([
    {
      path: pnpmGlobalRoot,
      private: true,
      dependencies: {
        "@getpaseo/cli": {
          from: "@getpaseo/cli",
          version,
          path: pnpmCliPackagePath,
        },
        "@openai/codex": {
          from: "@openai/codex",
          version: "1.2.3",
          path: path.join(pnpmGlobalRoot, "def456", "node_modules", "@openai", "codex"),
        },
      },
    },
  ]);
}

function recordingRunner(response: { exitCode?: number; stdout?: string; stderr?: string }) {
  const calls: CommandCall[] = [];
  const runner = async (command: string, args: string[], options?: CommandOptions) => {
    calls.push({ command, args, timeout: options?.timeout, maxBuffer: options?.maxBuffer });
    return {
      exitCode: response.exitCode ?? 0,
      stdout: response.stdout ?? "",
      stderr: response.stderr ?? "",
    };
  };
  return { calls, runner };
}

describe("DefaultNpmGlobalCli", () => {
  test("inspects the npm global cli install with npm -g ls", async () => {
    const { calls, runner } = recordingRunner({ stdout: npmGlobalPaseoCliJson("0.1.15") });
    const cli = new DefaultNpmGlobalCli(runner);

    await expect(cli.inspect()).resolves.toEqual({
      packageManager: "npm",
      version: "0.1.15",
      packagePath: npmCliPackagePath,
      isLinked: false,
      containmentRoots: [npmCliPackagePath, npmGlobalNodeModules],
    });
    expect(calls).toEqual([
      {
        command: "npm",
        args: ["-g", "ls", "@getpaseo/cli", "--json", "--depth=0", "--long"],
        timeout: 10_000,
        maxBuffer: 10 * 1024 * 1024,
      },
    ]);
  });

  test("marks linked npm global installs", async () => {
    const { runner } = recordingRunner({
      stdout: npmGlobalPaseoCliJson("0.1.15", { linked: true }),
    });
    const cli = new DefaultNpmGlobalCli(runner);

    await expect(cli.inspect()).resolves.toMatchObject({ isLinked: true });
  });

  test("runs the global install command for the latest cli", async () => {
    const { calls, runner } = recordingRunner({ stdout: "changed 42 packages" });
    const cli = new DefaultNpmGlobalCli(runner);

    await expect(cli.installLatest()).resolves.toEqual({
      exitCode: 0,
      stdout: "changed 42 packages",
      stderr: "",
    });
    expect(calls).toEqual([
      {
        command: "npm",
        args: ["install", "-g", "@getpaseo/cli@latest"],
        timeout: 300_000,
        maxBuffer: 10 * 1024 * 1024,
      },
    ]);
  });

  test("returns null when npm is not on the host", async () => {
    const cli = new DefaultNpmGlobalCli(async () => ({
      exitCode: 127,
      stdout: "",
      stderr: "npm: command not found",
    }));

    await expect(cli.inspect()).resolves.toBeNull();
  });

  test("returns null when npm cannot be spawned", async () => {
    const cli = new DefaultNpmGlobalCli(async () => ({
      exitCode: 1,
      stdout: "",
      stderr: "spawn npm ENOENT",
      errorCode: "ENOENT",
    }));

    await expect(cli.inspect()).resolves.toBeNull();
  });

  test("returns null when npm output has no cli dependency", async () => {
    const cli = new DefaultNpmGlobalCli(async () => ({
      exitCode: 1,
      stdout: JSON.stringify({ name: "lib", path: npmGlobalRoot, dependencies: {} }),
      stderr: "missing",
    }));

    await expect(cli.inspect()).resolves.toBeNull();
  });

  test("rejects when the npm probe fails without JSON output", async () => {
    const cli = new DefaultNpmGlobalCli(async () => ({
      exitCode: 1,
      stdout: "",
      stderr: "EACCES: permission denied",
    }));

    await expect(cli.inspect()).rejects.toThrow("npm -g ls failed: EACCES: permission denied");
  });
});

describe("DefaultPnpmGlobalCli", () => {
  test("inspects the pnpm global cli install with pnpm ls -g", async () => {
    const { calls, runner } = recordingRunner({ stdout: pnpmGlobalPaseoCliJson("0.1.15") });
    const cli = new DefaultPnpmGlobalCli(runner, {});

    await expect(cli.inspect()).resolves.toEqual({
      packageManager: "pnpm",
      version: "0.1.15",
      packagePath: pnpmCliPackagePath,
      isLinked: false,
      // pnpm resolves the running daemon through the store next to the global
      // dir, so the pnpm home is the containment root that actually matches.
      containmentRoots: [pnpmGlobalRoot, pnpmHome],
    });
    expect(calls).toEqual([
      {
        command: "pnpm",
        args: ["ls", "-g", "--json", "--depth=0"],
        timeout: 10_000,
        maxBuffer: 10 * 1024 * 1024,
      },
    ]);
  });

  test("prefers PNPM_HOME from the environment for containment", async () => {
    const envHome = path.join(path.sep, "custom", "pnpm-home");
    const { runner } = recordingRunner({ stdout: pnpmGlobalPaseoCliJson("0.1.15") });
    const cli = new DefaultPnpmGlobalCli(runner, { PNPM_HOME: envHome });

    await expect(cli.inspect()).resolves.toMatchObject({
      containmentRoots: [pnpmGlobalRoot, envHome, pnpmHome],
    });
  });

  test("does not widen containment for a custom global-dir layout", async () => {
    const customGlobalRoot = path.join(path.sep, "custom", "pg", "v11");
    const stdout = JSON.stringify([
      {
        path: customGlobalRoot,
        private: true,
        dependencies: {
          "@getpaseo/cli": { from: "@getpaseo/cli", version: "0.1.15" },
        },
      },
    ]);
    const cli = new DefaultPnpmGlobalCli(async () => ({ exitCode: 0, stdout, stderr: "" }), {});

    // The grandparent of an arbitrary global-dir is not the pnpm home; deriving
    // it anyway would let containment claim daemons under an unrelated ancestor.
    await expect(cli.inspect()).resolves.toMatchObject({
      containmentRoots: [customGlobalRoot],
    });
  });

  test("runs the pnpm add command for the latest cli", async () => {
    const { calls, runner } = recordingRunner({ stdout: "Packages: +1" });
    const cli = new DefaultPnpmGlobalCli(runner, {});

    await expect(cli.installLatest()).resolves.toEqual({
      exitCode: 0,
      stdout: "Packages: +1",
      stderr: "",
    });
    expect(calls).toEqual([
      {
        command: "pnpm",
        args: ["add", "-g", "@getpaseo/cli@latest"],
        timeout: 300_000,
        maxBuffer: 10 * 1024 * 1024,
      },
    ]);
  });

  test("returns null when pnpm is not available", async () => {
    const cli = new DefaultPnpmGlobalCli(
      async () => ({
        exitCode: 127,
        stdout: "",
        stderr: "pnpm: command not found",
      }),
      {},
    );

    await expect(cli.inspect()).resolves.toBeNull();
  });

  test("returns null when pnpm global has no cli dependency", async () => {
    const cli = new DefaultPnpmGlobalCli(
      async () => ({
        exitCode: 0,
        stdout: JSON.stringify([{ path: pnpmGlobalRoot, dependencies: {} }]),
        stderr: "",
      }),
      {},
    );

    await expect(cli.inspect()).resolves.toBeNull();
  });

  test("rejects when the pnpm probe fails without JSON output", async () => {
    const cli = new DefaultPnpmGlobalCli(
      async () => ({
        exitCode: 1,
        stdout: "",
        stderr: "Command failed: pnpm ls -g --json --depth=0",
      }),
      {},
    );

    await expect(cli.inspect()).rejects.toThrow(
      "pnpm ls -g failed: Command failed: pnpm ls -g --json --depth=0",
    );
  });
});
