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

// A launch wrap prepends a Windows script wrapper to the provider launch; spawnProcess runs it
// through cmd.exe with every argument escaped twice, because the script forwards them with `%*`.
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
    args: [
      '^^^"--profile^^^"',
      '^^^"work profile^^^"',
      '^^^"^^^"',
      '^^^"C:\\tools\\agy.cmd^^^"',
      '^^^"acp^^^"',
    ],
    shell: true,
  });
  expect(resolveSpawnInvocation(wrapped[0]!, wrapped.slice(1), undefined, "linux")).toEqual({
    command: wrapped[0],
    args: wrapped.slice(1),
    shell: false,
  });
});

// cmd.exe ends a command at a line break, and the text after it would run as a second command.
test("a Windows cmd.exe launch refuses an argument with a line break before it starts", () => {
  for (const argument of ["line one\nline two", "line one\r\n& calc"]) {
    expect(() =>
      resolveSpawnInvocation("C:\\Sandbox\\run.cmd", ["--", argument], undefined, "win32"),
    ).toThrow("cmd.exe cannot pass an argument with a line break to C:\\Sandbox\\run.cmd");
    expect(() => resolveSpawnInvocation("codex", [argument], undefined, "win32")).toThrow(
      "cmd.exe cannot pass an argument with a line break to codex",
    );
  }
  expect(resolveSpawnInvocation("C:\\tools\\node.exe", ["a\nb"], undefined, "win32").args).toEqual([
    "a\nb",
  ]);
  expect(resolveSpawnInvocation("/usr/bin/sandbox", ["a\nb"], undefined, "linux").args).toEqual([
    "a\nb",
  ]);
});

// A launch wrap starts its executable with the command and its arguments after the wrap's own.
// The caller's shell choice belongs to the unwrapped command, so a wrap ignores it.
test("spawnProcess starts a wrap's executable with the command after the wrap arguments", async () => {
  const launcher = await writeArgumentReader();
  const child = spawnProcess("harness", ["--flag", ...argumentsToPreserve], {
    wrap: [process.execPath, launcher, "--sandbox profile"],
    shell: true,
    stdio: "pipe",
  });
  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Launcher exited with ${code}`));
    });
  });
  expect(JSON.parse(stdout)).toEqual([
    "--sandbox profile",
    "harness",
    "--flag",
    ...argumentsToPreserve,
  ]);
});

// Arguments that cmd.exe reads as syntax unless they are escaped for it. A `.cmd` launcher reads
// its arguments a second time when it forwards them with `%*`.
const commandScriptArguments = [
  ...argumentsToPreserve,
  'say "hi"',
  '"quoted"',
  "",
  "a & b",
  "(parenthesized) arg",
  "100% done",
  "%PATH%",
  "!bang!",
  "C:\\path with space\\",
  'mixed "a & b" quote',
];

async function writeCommandScriptLauncher(): Promise<string> {
  const reader = await writeArgumentReader();
  const directory = await mkdtemp(path.join(os.tmpdir(), "plugin wrap (x86) & launcher "));
  roots.push(directory);
  const launcher = path.join(directory, "sandbox run.cmd");
  await writeFile(launcher, `@"${process.execPath}" "${reader}" %*\r\n`);
  return launcher;
}

async function readStdout(child: ReturnType<typeof spawnProcess>): Promise<string> {
  let stdout = "";
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    stdout += chunk;
  });
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Child exited with ${code}`));
    });
  });
  return stdout;
}

// Real cmd.exe: a `.cmd` launch wrap in a directory with spaces and cmd.exe syntax forwards the
// harness command and every argument to the program it starts, unchanged.
test.runIf(process.platform === "win32")(
  "a .cmd launch wrap forwards the command and its arguments unchanged on Windows",
  async () => {
    const launcher = await writeCommandScriptLauncher();
    const child = spawnProcess("harness", commandScriptArguments, {
      wrap: [launcher, "--sandbox profile", 'say "hi"', ""],
      stdio: "pipe",
    });
    expect(JSON.parse(await readStdout(child))).toEqual([
      "--sandbox profile",
      'say "hi"',
      "",
      "harness",
      ...commandScriptArguments,
    ]);
  },
);

test.runIf(process.platform === "win32")(
  "execCommand runs a .cmd script with its arguments unchanged on Windows",
  async () => {
    const launcher = await writeCommandScriptLauncher();
    const { stdout } = await execCommand(launcher, commandScriptArguments);
    expect(JSON.parse(stdout)).toEqual(commandScriptArguments);
  },
);

test.runIf(process.platform === "win32")(
  "a bare command name gets its arguments unchanged through cmd.exe on Windows",
  async () => {
    const reader = await writeArgumentReader();
    const { stdout } = await execCommand("node", [reader, ...commandScriptArguments]);
    expect(JSON.parse(stdout)).toEqual(commandScriptArguments);
  },
);
