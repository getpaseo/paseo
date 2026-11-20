import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createCli } from "./cli";
import { createCliParseArgv } from "./run";

const runModuleUrl = new URL("./run.ts", import.meta.url).href;

// Runs the CLI in a child process whose stdout pipe has no reader, as when the
// program that launched it has already closed its end.
async function runCliWithClosedStdout(
  argv: string[],
): Promise<{ code: number | null; stderr: string }> {
  const script = `
    const { runCli } = await import(${JSON.stringify(runModuleUrl)});
    process.exitCode = await runCli(${JSON.stringify(argv)});
    await new Promise((resolve) => setTimeout(resolve, 100));
    process.stderr.write("still running\\n");
  `;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: path.dirname(fileURLToPath(import.meta.url)),
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.destroy();
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
  return { code, stderr };
}

describe("runCli", () => {
  it("lets plugin update own --version while preserving global output options", async () => {
    const cli = createCli()
      .exitOverride()
      .configureOutput({ writeOut: () => {} });
    const update = cli.commands
      .find((command) => command.name() === "plugin")!
      .commands.find((command) => command.name() === "update")!;
    let received: Record<string, unknown> | undefined;
    update.action((_id, options) => {
      received = options;
    });
    await cli.parseAsync(
      ["plugin", "update", "example", "--version", "1.2.0", "--format", "json", "--no-color"],
      { from: "user" },
    );
    expect(received).toMatchObject({ version: "1.2.0" });
    expect(update.optsWithGlobals()).toMatchObject({ format: "json", color: false });
  });

  it("defaults an empty CLI invocation to onboard", () => {
    expect(
      createCliParseArgv({
        argv: [],
        cwd: process.cwd(),
        nodeArgv: ["node", "paseo"],
      }),
    ).toEqual(["node", "paseo", "onboard"]);
  });

  it("routes explicit root relay flags to onboard", () => {
    expect(
      createCliParseArgv({
        argv: ["--relay"],
        cwd: process.cwd(),
        nodeArgv: ["node", "paseo"],
      }),
    ).toEqual(["node", "paseo", "onboard", "--relay"]);
    expect(
      createCliParseArgv({
        argv: ["--no-relay"],
        cwd: process.cwd(),
        nodeArgv: ["node", "paseo"],
      }),
    ).toEqual(["node", "paseo", "onboard", "--no-relay"]);
  });

  it("preserves known CLI command argv", () => {
    expect(
      createCliParseArgv({
        argv: ["daemon", "set-password"],
        cwd: process.cwd(),
        nodeArgv: ["node", "paseo"],
      }),
    ).toEqual(["node", "paseo", "daemon", "set-password"]);
  });

  it("preserves the hooks command argv", () => {
    expect(
      createCliParseArgv({
        argv: ["hooks", "claude", "UserPromptSubmit"],
        cwd: process.cwd(),
        nodeArgv: ["node", "paseo"],
      }),
    ).toEqual(["node", "paseo", "hooks", "claude", "UserPromptSubmit"]);
  });

  it("finishes the command quietly when stdout is closed before it writes its output", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "paseo-cli-closed-stdout-"));

    try {
      const result = await runCliWithClosedStdout(["daemon", "status", "--json", "--home", home]);

      expect(result.stderr).toBe("still running\n");
      expect(result.code).toBe(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);

  it("classifies existing unknown directories as open-project invocations", () => {
    const root = mkdtempSync(path.join(tmpdir(), "paseo-cli-run-"));
    const project = path.join(root, "repository");
    mkdirSync(project);

    try {
      expect(
        createCliParseArgv({
          argv: ["repository"],
          cwd: root,
          nodeArgv: ["node", "paseo"],
        }),
      ).toEqual({
        kind: "open-project",
        resolvedPath: project,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
