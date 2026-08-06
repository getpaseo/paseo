import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  DEFAULT_AGENT_ENVIRONMENT_ENTRIES,
  type AgentEnvironmentEntry,
} from "@getpaseo/protocol/agent-environment";
import { createTestLogger } from "../test-utils/test-logger.js";
import {
  createAgentEnvironmentResolver,
  hasMarkerAtOrAbove,
  type AgentEnvironmentCommandResult,
  type AgentEnvironmentCommandRunnerInput,
} from "./agent-environment.js";
import { findExecutable } from "../executable-resolution/executable-resolution.js";

const execFileAsync = promisify(execFile);
const logger = createTestLogger();

interface StubRunner {
  run: (input: AgentEnvironmentCommandRunnerInput) => Promise<AgentEnvironmentCommandResult>;
  calls: AgentEnvironmentCommandRunnerInput[];
}

function stubRunner(
  results: Array<AgentEnvironmentCommandResult | Error>,
  fallback: AgentEnvironmentCommandResult = { stdout: "", stderr: "" },
): StubRunner {
  const calls: AgentEnvironmentCommandRunnerInput[] = [];
  return {
    calls,
    run: async (input) => {
      const result = results[calls.length] ?? fallback;
      calls.push(input);
      if (result instanceof Error) {
        throw result;
      }
      return result;
    },
  };
}

interface ResolverOptions {
  baseEnv?: Record<string, string>;
  binaries?: string[];
  markerDirs?: string[];
}

function resolverFor(
  entries: AgentEnvironmentEntry[],
  runner: StubRunner,
  options: ResolverOptions = {},
): (cwd: string) => Promise<Record<string, string | undefined>> {
  const binaries = new Set(options.binaries ?? ["direnv"]);
  const markerDirs = new Set(options.markerDirs ?? ["/project"]);
  return createAgentEnvironmentResolver({
    getConfig: () => ({ entries, timeoutMs: 30_000 }),
    logger,
    baseEnv: options.baseEnv ?? { PATH: "/usr/bin" },
    run: runner.run,
    resolveBinary: async (name) => (binaries.has(name) ? `/usr/bin/${name}` : null),
    fileExists: (path) => [...markerDirs].some((dir) => path === join(dir, ".envrc")),
  });
}

function commandEntry(
  command: string[],
  extra: Partial<Extract<AgentEnvironmentEntry, { kind: "command" }>> = {},
): AgentEnvironmentEntry {
  return { kind: "command", id: command.join("-"), command, ...extra };
}

test("runs a preset when its tool and marker are both present", async () => {
  const runner = stubRunner([
    {
      stdout: JSON.stringify({ FOO: "bar", PATH: "/project/bin:/usr/bin", HOME: null }),
      stderr: "",
    },
  ]);
  const resolve = resolverFor([...DEFAULT_AGENT_ENVIRONMENT_ENTRIES], runner);

  const env = await resolve("/project");

  expect(env).toEqual({ FOO: "bar", PATH: "/project/bin:/usr/bin", HOME: undefined });
  expect(Object.hasOwn(env, "HOME")).toBe(true);
  expect(runner.calls[0]).toEqual({
    command: "direnv",
    args: ["export", "json"],
    cwd: "/project",
    env: { PATH: "/usr/bin" },
    timeoutMs: 30_000,
  });
});

test("skips a preset without running anything when the tool is not installed", async () => {
  const runner = stubRunner([]);
  const resolve = resolverFor([...DEFAULT_AGENT_ENVIRONMENT_ENTRIES], runner, { binaries: [] });

  await expect(resolve("/project")).resolves.toEqual({});
  expect(runner.calls).toEqual([]);
});

test("skips a preset when the directory has no marker file", async () => {
  const runner = stubRunner([]);
  const resolve = resolverFor([...DEFAULT_AGENT_ENVIRONMENT_ENTRIES], runner, { markerDirs: [] });

  await expect(resolve("/project")).resolves.toEqual({});
  expect(runner.calls).toEqual([]);
});

test("applies a preset to a directory below the one holding the marker", async () => {
  const runner = stubRunner([{ stdout: JSON.stringify({ FOO: "bar" }), stderr: "" }]);
  const resolve = resolverFor([...DEFAULT_AGENT_ENVIRONMENT_ENTRIES], runner, {
    markerDirs: ["/project"],
  });

  await expect(resolve("/project/packages/app")).resolves.toEqual({ FOO: "bar" });
});

test("skips an entry naming a preset this daemon does not know", async () => {
  const runner = stubRunner([]);
  const resolve = resolverFor([{ kind: "preset", id: "e1", preset: "not-a-real-tool" }], runner);

  await expect(resolve("/project")).resolves.toEqual({});
  expect(runner.calls).toEqual([]);
});

test("keeps launching when preset detection throws", async () => {
  const runner = stubRunner([{ stdout: JSON.stringify({ AFTER: "ran" }), stderr: "" }]);
  const resolve = createAgentEnvironmentResolver({
    getConfig: () => ({
      entries: [...DEFAULT_AGENT_ENVIRONMENT_ENTRIES, commandEntry(["second"])],
      timeoutMs: 30_000,
    }),
    logger,
    baseEnv: { PATH: "/usr/bin" },
    run: runner.run,
    resolveBinary: async () => {
      throw new Error("PATH scan blew up");
    },
  });

  await expect(resolve("/project")).resolves.toEqual({ AFTER: "ran" });
});

test("keeps launching when marker detection throws", async () => {
  const runner = stubRunner([]);
  const resolve = createAgentEnvironmentResolver({
    getConfig: () => ({ entries: [...DEFAULT_AGENT_ENVIRONMENT_ENTRIES], timeoutMs: 30_000 }),
    logger,
    baseEnv: { PATH: "/usr/bin" },
    run: runner.run,
    resolveBinary: async () => "/usr/bin/direnv",
    fileExists: () => {
      throw new Error("stat blew up");
    },
  });

  await expect(resolve("/project")).resolves.toEqual({});
});

test("retries a binary lookup that failed instead of caching the failure", async () => {
  const runner = stubRunner([{ stdout: JSON.stringify({ PROBE: "ok" }), stderr: "" }]);
  let attempts = 0;
  const resolve = createAgentEnvironmentResolver({
    getConfig: () => ({ entries: [...DEFAULT_AGENT_ENVIRONMENT_ENTRIES], timeoutMs: 30_000 }),
    logger,
    baseEnv: { PATH: "/usr/bin" },
    run: runner.run,
    resolveBinary: async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("transient PATH error");
      }
      return "/usr/bin/direnv";
    },
    fileExists: (path) => path === join("/project", ".envrc"),
  });

  await expect(resolve("/project")).resolves.toEqual({});
  await expect(resolve("/project")).resolves.toEqual({ PROBE: "ok" });
  expect(attempts).toBe(2);
});

test("runs a custom command with no detection gate", async () => {
  const runner = stubRunner([{ stdout: JSON.stringify({ FROM_SCRIPT: "1" }), stderr: "" }]);
  const resolve = resolverFor([commandEntry(["setup-env"])], runner, {
    binaries: [],
    markerDirs: [],
  });

  await expect(resolve("/anywhere")).resolves.toEqual({ FROM_SCRIPT: "1" });
});

test("turns an env0 snapshot into an overlay, including removals", async () => {
  const runner = stubRunner([{ stdout: "PATH=/nix/bin\0EXTRA=1\0", stderr: "" }]);
  const resolve = resolverFor([commandEntry(["print-env"], { format: "env0" })], runner, {
    baseEnv: { PATH: "/usr/bin", STALE: "drop-me" },
  });

  await expect(resolve("/project")).resolves.toEqual({
    PATH: "/nix/bin",
    EXTRA: "1",
    STALE: undefined,
  });
});

test("runs entries in order, each seeing what the previous one produced", async () => {
  const runner = stubRunner([
    { stdout: JSON.stringify({ STAGE: "one", KEEP: "yes" }), stderr: "" },
    { stdout: JSON.stringify({ STAGE: "two" }), stderr: "" },
  ]);
  const resolve = resolverFor([commandEntry(["first"]), commandEntry(["second"])], runner);

  await expect(resolve("/project")).resolves.toEqual({ STAGE: "two", KEEP: "yes" });
  expect(runner.calls[1]?.env).toEqual({ PATH: "/usr/bin", STAGE: "one", KEEP: "yes" });
});

test("skips a failing entry and keeps the rest", async () => {
  const failure = Object.assign(new Error("Command failed"), {
    stderr: "direnv: error /project/.envrc is blocked. Run `direnv allow` to approve its content",
  });
  const runner = stubRunner([failure, { stdout: JSON.stringify({ AFTER: "ran" }), stderr: "" }]);
  const resolve = resolverFor([commandEntry(["direnv"]), commandEntry(["second"])], runner);

  await expect(resolve("/project")).resolves.toEqual({ AFTER: "ran" });
  expect(runner.calls).toHaveLength(2);
});

test("ignores output that is not the declared format", async () => {
  const runner = stubRunner([
    { stdout: '["not", "a", "diff"]', stderr: "" },
    { stdout: "NOT-A-RECORD\0", stderr: "" },
  ]);
  const resolve = resolverFor(
    [commandEntry(["bad-json"]), commandEntry(["bad-env0"], { format: "env0" })],
    runner,
  );

  await expect(resolve("/project")).resolves.toEqual({});
});

test("prefers the per-entry timeout over the shared one", async () => {
  const runner = stubRunner([]);
  const resolve = resolverFor(
    [commandEntry(["slow"], { timeoutMs: 1234 }), commandEntry(["default"])],
    runner,
  );

  await resolve("/project");

  expect(runner.calls.map((call) => call.timeoutMs)).toEqual([1234, 30_000]);
});

test("picks up an entry list edited after the resolver was built", async () => {
  const runner = stubRunner([
    { stdout: JSON.stringify({ FIRST: "1" }), stderr: "" },
    { stdout: JSON.stringify({ SECOND: "2" }), stderr: "" },
  ]);
  let entries: AgentEnvironmentEntry[] = [commandEntry(["first"])];
  const resolve = createAgentEnvironmentResolver({
    getConfig: () => ({ entries, timeoutMs: 30_000 }),
    logger,
    baseEnv: { PATH: "/usr/bin" },
    run: runner.run,
  });

  await expect(resolve("/project")).resolves.toEqual({ FIRST: "1" });

  entries = [commandEntry(["second"])];

  await expect(resolve("/project")).resolves.toEqual({ SECOND: "2" });
});

test("stops the marker walk at the filesystem root", () => {
  expect(hasMarkerAtOrAbove("/a/b/c", [".envrc"], () => false)).toBe(false);
});

const direnvPath = await findExecutable("direnv");

// direnv is the preset this feature ships with, and its `export json` contract
// is the part stubs cannot keep honest. Skipped where it is not installed.
describe.skipIf(!direnvPath)("with the direnv preset against a real direnv", () => {
  let projectDir: string;
  let dataHome: string;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "agent-env-project-"));
    dataHome = mkdtempSync(join(tmpdir(), "agent-env-data-"));
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(dataHome, { recursive: true, force: true });
  });

  test("loads an allowed .envrc and skips a blocked one", async () => {
    writeFileSync(join(projectDir, ".envrc"), "export PASEO_ENV_PROBE=loaded\n");
    const baseEnv = { ...process.env, XDG_DATA_HOME: dataHome };
    const resolve = createAgentEnvironmentResolver({
      getConfig: () => ({
        entries: [...DEFAULT_AGENT_ENVIRONMENT_ENTRIES],
        timeoutMs: 30_000,
      }),
      logger,
      baseEnv,
    });

    await expect(resolve(projectDir)).resolves.toEqual({});

    await execFileAsync(direnvPath as string, ["allow", projectDir], { env: baseEnv });

    await expect(resolve(projectDir)).resolves.toMatchObject({ PASEO_ENV_PROBE: "loaded" });
  });

  test("does nothing in a directory with no .envrc", async () => {
    const resolve = createAgentEnvironmentResolver({
      getConfig: () => ({
        entries: [...DEFAULT_AGENT_ENVIRONMENT_ENTRIES],
        timeoutMs: 30_000,
      }),
      logger,
      baseEnv: { ...process.env, XDG_DATA_HOME: dataHome },
    });

    await expect(resolve(dataHome)).resolves.toEqual({});
  });
});
