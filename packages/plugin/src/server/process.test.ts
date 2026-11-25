import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { execCommand, spawnProcess } from "./index.js";
import { resolveSpawnInvocation } from "./process.js";

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

// A launch wrap prepends a Windows script wrapper to the provider launch; spawnProcess must run it
// through cmd.exe with every argument quoted whole, as it does for any provider launcher.
test("a Windows script launch wrap starts through cmd.exe with each argument quoted", () => {
  const wrapped = [
    "C:\\Program Files\\Sandbox\\run.cmd",
    "--profile",
    "work profile",
    "",
    "C:\\tools\\agy.cmd",
    "acp",
  ];
  expect(resolveSpawnInvocation(wrapped[0]!, wrapped.slice(1), undefined, "win32")).toEqual({
    command: '"C:\\Program Files\\Sandbox\\run.cmd"',
    args: ["--profile", '"work profile"', '""', "C:\\tools\\agy.cmd", "acp"],
    shell: true,
  });
  expect(resolveSpawnInvocation(wrapped[0]!, wrapped.slice(1), undefined, "linux")).toEqual({
    command: wrapped[0],
    args: wrapped.slice(1),
    shell: false,
  });
});
