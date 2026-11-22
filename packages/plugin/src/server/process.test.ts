import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type * as ChildProcess from "node:child_process";
import { afterEach, expect, test, vi } from "vitest";
import { applyLaunchWrap, execCommand, spawnProcess } from "./index.js";

// Delegates to the real spawn; a test can capture one call instead of starting a process.
const spawnSpy = vi.hoisted(() => ({
  current: undefined as undefined | ((...args: unknown[]) => unknown),
}));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  return {
    ...actual,
    spawn: (...args: Parameters<typeof actual.spawn>) =>
      spawnSpy.current ? spawnSpy.current(...args) : actual.spawn(...args),
  };
});

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function writeArgumentReader(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "plugin process arguments "));
  roots.push(root);
  const script = path.join(root, "read arguments.mjs");
  await writeFile(script, "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n");
  return script;
}

const argumentsToPreserve = [
  "argument with spaces",
  "--format=%(refname)%09%(committerdate:unix)",
  "100%",
  "feature&bugfix",
  "feature|bugfix",
  "feature^bugfix",
];

// A bare extensionless command selects the Windows shell; an absolute node.exe path would
// skip that path. The real child checks quoting through the public process capabilities.
test("execCommand delivers shell arguments to the real child unchanged", async () => {
  const script = await writeArgumentReader();
  const { stdout } = await execCommand("node", [script, ...argumentsToPreserve]);
  expect(JSON.parse(stdout)).toEqual(argumentsToPreserve);
});

test("spawnProcess delivers shell arguments to the real child unchanged", async () => {
  const script = await writeArgumentReader();
  const child = spawnProcess("node", [script, ...argumentsToPreserve], { stdio: "pipe" });
  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Argument reader exited with ${code}`));
    });
  });
  expect(JSON.parse(stdout)).toEqual(argumentsToPreserve);
});

test("a Windows command-script wrapper starts through cmd.exe with each argument quoted whole", () => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  const calls: unknown[][] = [];
  spawnSpy.current = (...args) => {
    calls.push(args);
    return {};
  };
  Object.defineProperty(process, "platform", { ...platform, value: "win32" });
  try {
    const { command, args } = applyLaunchWrap(
      ["C:\\Program Files\\Sandbox\\run.cmd", "--profile", "work profile"],
      { command: "C:\\tools\\agy.cmd", args: ["acp", "--disable-telemetry"] },
    );
    spawnProcess(command, args, { stdio: "pipe" });
  } finally {
    Object.defineProperty(process, "platform", platform);
    spawnSpy.current = undefined;
  }
  expect(calls).toHaveLength(1);
  const [command, args, options] = calls[0] as [string, string[], { shell: unknown }];
  expect(options.shell).toBe(true);
  expect(command).toBe('"C:\\Program Files\\Sandbox\\run.cmd"');
  expect(args).toEqual([
    "--profile",
    '"work profile"',
    "C:\\tools\\agy.cmd",
    "acp",
    "--disable-telemetry",
  ]);
});
