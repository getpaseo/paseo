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

// A real child checks quoting through the public process capabilities. On Windows the bare name
// resolves on PATH to node.exe, which starts directly.
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

// A Windows environment with an empty PATH, so a bare name is never found on the test host.
const windowsEnv = { ComSpec: "C:\\Windows\\System32\\cmd.exe", PATH: "" };

function onWindows(command: string, args: string[], shell?: boolean | string) {
  return resolveSpawnInvocation(command, args, shell, "win32", windowsEnv);
}

// A launch wrap prepends a Windows script wrapper to the provider launch; spawnProcess starts it as
// one verbatim cmd.exe line.
test("a Windows script launch wrap starts as one verbatim cmd.exe line", () => {
  const wrapped = [
    "C:\\Program Files\\Sandbox\\run.cmd",
    "--profile",
    "work profile",
    "",
    "C:\\tools\\agy.cmd",
    "acp",
  ];
  expect(onWindows(wrapped[0]!, wrapped.slice(1))).toEqual({
    command: "C:\\Windows\\System32\\cmd.exe",
    args: [
      "/d",
      "/s",
      "/c",
      '""C:\\Program Files\\Sandbox\\run.cmd" --profile ^"work^ profile^" ^"^" C:\\tools\\agy.cmd acp"',
    ],
    shell: false,
    windowsVerbatimArguments: true,
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
    expect(() => onWindows("C:\\Sandbox\\run.cmd", ["--", argument])).toThrow(
      "cmd.exe cannot pass an argument with a line break to C:\\Sandbox\\run.cmd",
    );
    expect(() => onWindows("codex", [argument])).toThrow(
      "cmd.exe cannot pass an argument with a line break to codex",
    );
  }
  expect(onWindows("C:\\tools\\node.exe", ["a\nb"]).args).toEqual(["a\nb"]);
  expect(resolveSpawnInvocation("/usr/bin/sandbox", ["a\nb"], undefined, "linux").args).toEqual([
    "a\nb",
  ]);
});

// Only cmd.exe reads cmd.exe quoting. A shell the caller names parses the line by its own rules.
test("a Windows launch quotes for cmd.exe only when cmd.exe parses the command line", () => {
  // `shell: true` runs the child's ComSpec; a cmd.exe the caller names runs as named.
  for (const [shell, cmd] of [
    [true, windowsEnv.ComSpec],
    ["cmd.exe", "cmd.exe"],
    ["D:\\Tools\\CMD.EXE", "D:\\Tools\\CMD.EXE"],
  ] as const) {
    expect(onWindows("echo", ["hello", "a & b"], shell)).toEqual({
      command: cmd,
      args: ["/d", "/s", "/c", '"echo hello ^"a^ ^&^ b^""'],
      shell: false,
      windowsVerbatimArguments: true,
    });
  }
  for (const shell of ["bash.exe", "C:\\Program Files\\Git\\bin\\bash.exe", "pwsh"]) {
    expect(onWindows("echo", ["'a & b'", "line\nbreak"], shell)).toEqual({
      command: "echo",
      args: ["'a & b'", "line\nbreak"],
      shell,
    });
  }
  // A program starts directly, and `shell: false` keeps a bare name that is not on PATH direct.
  expect(onWindows("C:\\tools\\node.exe", ["a & b"])).toEqual({
    command: "C:\\tools\\node.exe",
    args: ["a & b"],
    shell: false,
  });
  expect(onWindows("missing", ["a & b"], false)).toEqual({
    command: "missing",
    args: ["a & b"],
    shell: false,
  });
});

// The daemon runs git with `shell: false` on hot paths that must not block on synchronous IO, so
// an explicit `shell: false` starts a bare name directly and leaves the PATH search to Windows.
test("a Windows bare name searches PATH for a script only when the caller allows a shell", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "plugin-path-shim-"));
  roots.push(directory);
  await writeFile(path.join(directory, "tool.CMD"), "");
  const env = { ...windowsEnv, PATH: directory };
  expect(resolveSpawnInvocation("tool", ["a & b"], false, "win32", env)).toEqual({
    command: "tool",
    args: ["a & b"],
    shell: false,
  });
  expect(resolveSpawnInvocation("tool", ["a & b"], undefined, "win32", env)).toEqual({
    command: windowsEnv.ComSpec,
    args: ["/d", "/s", "/c", `"${path.join(directory, "tool.CMD")} ^"a^ ^&^ b^""`],
    shell: false,
    windowsVerbatimArguments: true,
  });
});

// Real Git Bash on Windows: the arguments reach Bash as given, without cmd.exe escapes.
test.runIf(process.platform === "win32")(
  "execCommand passes arguments as given to a Windows shell other than cmd.exe",
  async () => {
    const bash = path.join(
      process.env.ProgramFiles ?? "C:\\Program Files",
      "Git",
      "bin",
      "bash.exe",
    );
    const { stdout } = await execCommand("printf", ["'%s|'", "hello", "'a & b'"], {
      shell: bash,
    });
    expect(stdout).toBe("hello|a & b|");
  },
);

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
  "--profile=restricted",
  "a,b;c",
  // cmd.exe expands a set variable inside a quoted region, so this checks that none opens.
  "value with %PATH% inside",
  'quote "then %PATH%" & more',
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

// Real cmd.exe: a script that reads `%~1` gets each argument as given, without escapes.
test.runIf(process.platform === "win32")(
  "a .cmd script that reads its arguments one by one gets each one as given on Windows",
  async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "plugin script reader "));
    roots.push(directory);
    const script = path.join(directory, "read.cmd");
    // `set /p` without input exits 1, so the script exits 0 on its own.
    await writeFile(
      script,
      '@echo off\r\n<nul set /p "=%~1|%~2|%~3|%~4|%~5|%~6|%~7|%~8|%~9"\r\nexit /b 0\r\n',
    );
    const { stdout } = await execCommand(script, [
      "plain",
      "with space",
      "feature&bugfix",
      "100%",
      "--profile=restricted",
      "a,b",
      "a;b",
      "value with %PATH% inside",
      "",
    ]);
    expect(stdout).toBe(
      "plain|with space|feature&bugfix|100%|--profile=restricted|a,b|a;b|value with %PATH% inside|",
    );
  },
);

// Real cmd.exe: a bare name is found on PATH like cmd.exe finds it. A `.cmd` shim that forwards
// `%*`, as npm writes them, passes every argument on unchanged; a program starts directly.
test.runIf(process.platform === "win32")(
  "a bare command name found on PATH gets its arguments unchanged on Windows",
  async () => {
    const reader = await writeArgumentReader();
    const directory = await mkdtemp(path.join(os.tmpdir(), "plugin bare shim "));
    roots.push(directory);
    await writeFile(
      path.join(directory, "paseo-forward.cmd"),
      `@"${process.execPath}" "${reader}" %*\r\n`,
    );
    // Windows env names ignore case, so drop the inherited `Path` before setting the new one.
    const inherited = Object.entries(process.env).filter(([key]) => key.toLowerCase() !== "path");
    const env = {
      ...Object.fromEntries(inherited),
      PATH: `${directory};${process.env.PATH ?? ""}`,
    };
    const shim = await execCommand("paseo-forward", commandScriptArguments, { env });
    expect(JSON.parse(shim.stdout)).toEqual(commandScriptArguments);
    const program = await execCommand("node", [reader, ...commandScriptArguments], { env });
    expect(JSON.parse(program.stdout)).toEqual(commandScriptArguments);
  },
);

// Real cmd.exe: a caller that formats its own cmd.exe line asks Node to pass it verbatim.
test.runIf(process.platform === "win32")(
  "spawnProcess passes a caller's verbatim cmd.exe line unchanged on Windows",
  async () => {
    const reader = await writeArgumentReader();
    const child = spawnProcess(
      process.env.ComSpec ?? "cmd.exe",
      ["/d", "/s", "/c", `""${process.execPath}" "${reader}" "a b" c"`],
      { shell: false, windowsVerbatimArguments: true, stdio: "pipe" },
    );
    expect(JSON.parse(await readStdout(child))).toEqual(["a b", "c"]);
  },
);
