import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import type { AgentClient } from "../agent-sdk-types.js";
import { ClaudeAgentClient } from "./claude/agent.js";
import { CodexAppServerAgentClient } from "./codex-app-server-agent.js";
import { CopilotACPAgentClient } from "./copilot-acp-agent.js";
import { OmpAgentClient } from "./omp/agent.js";
import { OpenCodeRuntimeClient } from "./opencode/runtime-client.js";
import { PiRpcAgentClient } from "./pi/agent.js";
import type { LatestReleaseLookup } from "./release-check.js";
import type { ProviderUpdateReport } from "@getpaseo/plugin/server/provider";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

/** A command that prints `banner` for `--version`, the way the real CLI does. */
async function versionCommand(banner: string): Promise<[string, string]> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paseo-update-check-"));
  roots.push(root);
  const script = path.join(root, "cli.mjs");
  await fs.writeFile(script, `console.log(${JSON.stringify(banner)});\n`);
  return [process.execPath, script];
}

/**
 * A command that, for `update`, writes `stdout` and `stderr` and exits with `exitCode`. Its
 * arguments are recorded so the test can see which updater ran.
 */
async function updaterCommand(input: {
  stdout: string;
  stderr: string;
  exitCode: number;
}): Promise<{ argv: [string, string]; recordedArgs: () => Promise<string[]> }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paseo-updater-"));
  roots.push(root);
  const script = path.join(root, "cli.mjs");
  const record = path.join(root, "args.json");
  await fs.writeFile(
    script,
    [
      `import { writeFileSync } from "node:fs";`,
      `writeFileSync(${JSON.stringify(record)}, JSON.stringify(process.argv.slice(2)));`,
      `process.stdout.write(${JSON.stringify(input.stdout)});`,
      `process.stderr.write(${JSON.stringify(input.stderr)});`,
      `process.exitCode = ${input.exitCode};`,
    ].join("\n"),
  );
  return {
    argv: [process.execPath, script],
    recordedArgs: async () => JSON.parse(await fs.readFile(record, "utf8")) as string[],
  };
}

async function runUpdate(client: AgentClient) {
  const output: ProviderUpdateReport[] = [];
  const result = await client.installation?.update?.({
    signal: new AbortController().signal,
    report: (event) => output.push(event),
  });
  return { result, output };
}

function releases(latest: string) {
  const lookups: string[] = [];
  const lookup: LatestReleaseLookup = async ({ executablePath }) => {
    lookups.push(executablePath);
    return latest;
  };
  return { lookup, lookups };
}

function check(client: AgentClient) {
  return client.installation?.checkForUpdates?.({ signal: new AbortController().signal });
}

const providers = [
  {
    name: "Codex",
    banner: (version: string) => `codex-cli ${version}`,
    client: (argv: [string, string], lookupLatestRelease: LatestReleaseLookup) =>
      new CodexAppServerAgentClient(
        createTestLogger(),
        { command: { mode: "replace", argv } },
        { lookupLatestRelease },
      ),
  },
  {
    name: "Claude Code",
    banner: (version: string) => `${version} (Claude Code)`,
    client: (argv: [string, string], lookupLatestRelease: LatestReleaseLookup) =>
      new ClaudeAgentClient({
        logger: createTestLogger(),
        runtimeSettings: { command: { mode: "replace", argv } },
        lookupLatestRelease,
      }),
  },
];

describe.each(providers)("$name update", ({ client }) => {
  test("runs the CLI's own update command and passes its output through", async () => {
    const updater = await updaterCommand({
      stdout: "Updating via `npm install -g`...\nadded 1 package\n",
      stderr: "npm warn deprecated\n",
      exitCode: 0,
    });
    const { result, output } = await runUpdate(client(updater.argv, releases("9.9.9").lookup));
    expect(await updater.recordedArgs()).toEqual(["update"]);
    expect(result).toEqual({ status: "succeeded", message: expect.stringContaining("updated") });
    expect(output[0]).toEqual({
      type: "message",
      text: `Running ${updater.argv.join(" ")} update\n`,
    });
    expect(
      output
        .filter((event) => event.type === "stdout")
        .map((event) => event.text)
        .join(""),
    ).toBe("Updating via `npm install -g`...\nadded 1 package\n");
    expect(
      output
        .filter((event) => event.type === "stderr")
        .map((event) => event.text)
        .join(""),
    ).toBe("npm warn deprecated\n");
  });

  test("fails with the exit code and keeps the updater's output", async () => {
    const updater = await updaterCommand({
      stdout: "",
      stderr: "Could not detect the installation method\n",
      exitCode: 3,
    });
    const { result, output } = await runUpdate(client(updater.argv, releases("9.9.9").lookup));
    expect(result).toEqual({
      status: "failed",
      message: `${updater.argv.join(" ")} update exited with code 3`,
    });
    expect(output).toContainEqual({
      type: "stderr",
      text: "Could not detect the installation method\n",
    });
  });
});

describe.each(providers)("$name update check", ({ banner, client }) => {
  test("reports the newer release as available, version as published", async () => {
    const argv = await versionCommand(banner("0.165.0"));
    const { lookup, lookups } = releases("0.168.0");
    await expect(check(client(argv, lookup))).resolves.toEqual({
      status: "available",
      versions: ["0.168.0"],
    });
    expect(lookups).toEqual([await fs.realpath(process.execPath)]);
  });

  test("reports current when the installed release is the latest or newer", async () => {
    const argv = await versionCommand(banner("2.1.323"));
    await expect(check(client(argv, releases("2.1.323").lookup))).resolves.toEqual({
      status: "current",
    });
    await expect(check(client(argv, releases("2.1.311").lookup))).resolves.toEqual({
      status: "current",
    });
  });

  test("is inconclusive when the release channel answers something unreadable", async () => {
    const argv = await versionCommand(banner("2.1.323"));
    await expect(check(client(argv, releases("<html>").lookup))).resolves.toEqual({
      status: "unknown",
      message: "Unrecognized release <html>",
    });
  });
});

describe("Codex prerelease update check", () => {
  const codex = providers[0]!;
  const client = codex.client;
  const banner = codex.banner;

  test("orders a prerelease before the release with the same numbers", async () => {
    const prerelease = await versionCommand(banner("0.200.0-alpha.1"));
    await expect(check(client(prerelease, releases("0.200.0").lookup))).resolves.toEqual({
      status: "available",
      versions: ["0.200.0"],
    });
    const release = await versionCommand(banner("0.200.0"));
    await expect(check(client(release, releases("0.200.0-alpha.1").lookup))).resolves.toEqual({
      status: "current",
    });
  });

  test("is inconclusive between two prereleases of the same release", async () => {
    const argv = await versionCommand(banner("0.200.0-alpha.1"));
    await expect(check(client(argv, releases("0.200.0-alpha.2").lookup))).resolves.toEqual({
      status: "unknown",
      message: "Cannot compare 0.200.0-alpha.1 with 0.200.0-alpha.2",
    });
  });
});

test("Claude Code is inconclusive when a wrapper command hides its version", async () => {
  const argv = await versionCommand("cux 0.4.1");
  const { lookup, lookups } = releases("2.1.323");
  await expect(check(providers[1]!.client(argv, lookup))).resolves.toEqual({
    status: "unknown",
    message: "The configured command does not report its version",
  });
  expect(lookups).toEqual([]);
});

/**
 * A command that answers `--version` with `banner` and any other invocation with `rest`, the way
 * a CLI answers both its version and its update check.
 */
async function cliCommand(input: { banner: string; rest: string }): Promise<[string, string]> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paseo-cli-"));
  roots.push(root);
  const script = path.join(root, "cli.mjs");
  await fs.writeFile(
    script,
    [
      `const args = process.argv.slice(2);`,
      `console.log(args.at(-1) === "--version" ? ${JSON.stringify(input.banner)} : ${JSON.stringify(input.rest)});`,
    ].join("\n"),
  );
  return [process.execPath, script];
}

function inspect(client: AgentClient) {
  return client.installation?.inspect?.({ signal: new AbortController().signal });
}

const selfUpdatingClis = [
  {
    name: "Copilot",
    banner: "GitHub Copilot CLI 1.0.110.\nRun 'copilot update' to check for updates.",
    version: "1.0.110",
    updateArgs: ["update"],
    successMessage: expect.stringContaining("New agents use the new version"),
    client: (argv: [string, string]) =>
      new CopilotACPAgentClient({
        logger: createTestLogger(),
        runtimeSettings: { command: { mode: "replace", argv } },
      }),
  },
  {
    name: "OpenCode",
    banner: "1.19.5",
    version: "1.19.5",
    updateArgs: ["upgrade"],
    // OpenCode runs one server for every agent, which keeps the old version until restarted.
    successMessage: expect.stringContaining("Restart the Paseo daemon"),
    client: (argv: [string, string]) =>
      new OpenCodeRuntimeClient(createTestLogger(), { command: { mode: "replace", argv } }),
  },
  {
    name: "Pi",
    banner: "1.3.0",
    version: "1.3.0",
    updateArgs: ["update", "--self"],
    successMessage: expect.stringContaining("New agents use the new version"),
    client: (argv: [string, string]) =>
      new PiRpcAgentClient({
        logger: createTestLogger(),
        runtimeSettings: { command: { mode: "replace", argv } },
      }),
  },
  {
    name: "Oh My Pi",
    banner: "omp/18.6.1",
    version: "18.6.1",
    updateArgs: ["update"],
    successMessage: expect.stringContaining("New agents use the new version"),
    client: (argv: [string, string]) =>
      new OmpAgentClient({
        logger: createTestLogger(),
        runtimeSettings: { command: { mode: "replace", argv } },
      }),
  },
];

describe.each(selfUpdatingClis)("$name installation", (cli) => {
  test("reports the version the CLI prints", async () => {
    const argv = await versionCommand(cli.banner);
    await expect(inspect(cli.client(argv))).resolves.toEqual({
      status: "installed",
      version: cli.version,
    });
  });

  test("updates with the CLI's own update command", async () => {
    const updater = await updaterCommand({ stdout: "done\n", stderr: "", exitCode: 0 });
    const { result } = await runUpdate(cli.client(updater.argv));
    expect(await updater.recordedArgs()).toEqual(cli.updateArgs);
    expect(result).toEqual({ status: "succeeded", message: cli.successMessage });
  });

  test("is not installed when the command is missing", async () => {
    const client = cli.client(["/nonexistent/paseo-cli", "--flag"]);
    await expect(inspect(client)).resolves.toEqual({ status: "not_installed" });
    await expect(runUpdate(client)).resolves.toMatchObject({
      result: { status: "failed", message: `${cli.name} is not installed` },
    });
  });
});

test("Pi checks the release its own update check reads", async () => {
  const argv = await versionCommand("1.3.0");
  const { lookup, lookups } = releases("1.5.2");
  const client = new PiRpcAgentClient({
    logger: createTestLogger(),
    runtimeSettings: { command: { mode: "replace", argv } },
    lookupLatestRelease: lookup,
  });
  await expect(check(client)).resolves.toEqual({ status: "available", versions: ["1.5.2"] });
  expect(lookups).toEqual([await fs.realpath(process.execPath)]);
});

describe("Oh My Pi update check", () => {
  async function ompCheck(answer: string) {
    const argv = await cliCommand({ banner: "omp/18.6.1", rest: answer });
    return check(
      new OmpAgentClient({
        logger: createTestLogger(),
        runtimeSettings: { command: { mode: "replace", argv } },
      }),
    );
  }

  test("reads the answer of `omp update --check`", async () => {
    await expect(ompCheck("\u001b[32mNew version available: 18.7.0\u001b[0m")).resolves.toEqual({
      status: "available",
      versions: ["18.7.0"],
    });
    await expect(ompCheck("Already up to date")).resolves.toEqual({ status: "current" });
  });

  test("passes through an install that another tool keeps up to date", async () => {
    await expect(ompCheck("omp is kept up to date by mise")).resolves.toEqual({
      status: "unknown",
      message: "omp is kept up to date by mise",
    });
  });
});

test("Copilot and OpenCode declare no update check", () => {
  const argv: [string, string] = [process.execPath, "cli.mjs"];
  expect(selfUpdatingClis[0]!.client(argv).installation.checkForUpdates).toBeUndefined();
  expect(selfUpdatingClis[1]!.client(argv).installation.checkForUpdates).toBeUndefined();
});
