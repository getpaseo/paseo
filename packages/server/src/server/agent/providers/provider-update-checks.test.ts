import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import type { AgentClient } from "../agent-sdk-types.js";
import { ClaudeAgentClient } from "./claude/agent.js";
import { CodexAppServerAgentClient } from "./codex-app-server-agent.js";
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

test("Claude Code is inconclusive when a wrapper command hides its version", async () => {
  const argv = await versionCommand("cux 0.4.1");
  const { lookup, lookups } = releases("2.1.323");
  await expect(check(providers[1]!.client(argv, lookup))).resolves.toEqual({
    status: "unknown",
    message: "The configured command does not report its version",
  });
  expect(lookups).toEqual([]);
});
