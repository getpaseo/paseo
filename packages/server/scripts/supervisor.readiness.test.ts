import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

async function runWorker(
  worker: string,
  publicationDelay = 0,
  options: { packagedSpawn?: boolean; background?: boolean; timeoutMs?: number } = {},
) {
  const home = await mkdtemp(path.join(tmpdir(), "paseo-readiness-"));
  const workerPath = path.join(home, "worker.mjs");
  const runnerPath = path.join(home, "runner.mjs");
  const eventsPath = path.join(home, "events.jsonl");
  const supervisor = new URL("./supervisor.ts", import.meta.url).href;
  await writeFile(workerPath, worker);
  await writeFile(
    runnerPath,
    `
    import { appendFile } from "node:fs/promises";
    import { runSupervisor } from ${JSON.stringify(supervisor)};
    const record = (event) => appendFile(${JSON.stringify(eventsPath)}, JSON.stringify(event) + "\\n");
    runSupervisor({
      name: "ReadinessTest", startupMessage: "starting", restartOnCrash: true,
      resolveWorkerEntry: () => ${JSON.stringify(workerPath)}, workerArgs: [], workerExecArgv: [],
      resolveWorkerSpawnSpec: ${options.packagedSpawn ? `() => ({ command: process.execPath, args: [${JSON.stringify(workerPath)}], env: process.env })` : "undefined"},
      onWorkerReady: async ({ listen }) => {
        await new Promise(resolve => setTimeout(resolve, ${publicationDelay}));
        await record(listen);
      },
      onWorkerExit: () => record(null),
    });
  `,
  );
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("PASEO_")),
  );
  const child = spawn(process.execPath, ["--import", "tsx", runnerPath], {
    cwd: fileURLToPath(new URL("../../../", import.meta.url)),
    env: { ...env, HOME: home, PASEO_HOME: home },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    detached: options.background ?? false,
  });
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(output));
      }, options.timeoutMs ?? 5_000);
      child.once("error", reject);
      child.once("close", (exitCode) => {
        clearTimeout(timer);
        resolve(exitCode);
      });
    });
    const events = await readFile(eventsPath, "utf8").catch(() => "");
    return {
      code,
      output,
      events: events
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
    };
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

test("a worker that exits before ready fails the supervisor without respawning", async () => {
  const result = await runWorker(`
    import { existsSync, writeFileSync } from "node:fs";
    const marker = process.argv[1] + ".started";
    if (existsSync(marker)) process.exit(0);
    writeFileSync(marker, "started");
    process.exit(1);
  `);
  expect(result.code).toBe(1);
  expect(result.output).not.toContain("Restarting worker");
});

test("a replacement worker must independently reach ready", async () => {
  const result = await runWorker(`
    import { existsSync, writeFileSync } from "node:fs";
    const marker = process.argv[1] + ".started";
    if (existsSync(marker)) process.exit(0);
    writeFileSync(marker, "started");
    process.on("message", message => {
      if (message.type === "paseo:graceful-shutdown") process.exit(0);
    });
    process.send({ type: "paseo:ready", listen: "test-endpoint", serverId: "srv_test" });
    process.send({ type: "paseo:restart" });
  `);
  expect(result.code).toBe(1);
  expect(result.events, result.output).toEqual(["test-endpoint", null, null]);
});

test("exit clears publication after an in-flight ready write", async () => {
  const result = await runWorker(
    `
    process.send({ type: "paseo:ready", listen: "test-endpoint", serverId: "srv_test" }, () => process.exit(0));
  `,
    100,
  );
  expect(result.code).toBe(0);
  expect(result.events.at(-1)).toBeNull();
});

test("requested shutdown before first readiness exits successfully", async () => {
  const result = await runWorker(`
    process.on("message", message => {
      if (message.type === "paseo:graceful-shutdown") process.exit(0);
    });
    process.send({ type: "paseo:shutdown", reason: "cancelled_start" });
  `);
  expect(result.code).toBe(0);
  expect(result.events).toEqual([null]);
});

test.runIf(process.platform === "win32").each([false, true])(
  "keeps worker consoles hidden through restart and crash recovery (packaged spawn: %s)",
  async (packagedSpawn) => {
    const result = await runWorker(
      `
      import { existsSync, readFileSync, writeFileSync } from "node:fs";
      import { execFileSync } from "node:child_process";
      const marker = process.argv[1] + ".launch-count";
      const count = existsSync(marker) ? Number(readFileSync(marker, "utf8")) + 1 : 1;
      writeFileSync(marker, String(count));
      process.title = "PaseoConsoleTest-" + process.pid;
      const observation = process.argv[1] + ".console";
      const script = \`
        Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class ConsoleProbe { [DllImport("kernel32.dll", SetLastError=true)] public static extern bool AttachConsole(uint pid); [DllImport("kernel32.dll")] public static extern bool FreeConsole(); [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow(); [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr handle); }';
        [ConsoleProbe]::FreeConsole() | Out-Null;
        $attached = [ConsoleProbe]::AttachConsole(\${process.pid});
        $consoleVisible = $attached -and [ConsoleProbe]::IsWindowVisible([ConsoleProbe]::GetConsoleWindow());
        $terminalVisible = @(Get-Process WindowsTerminal -ErrorAction SilentlyContinue | Where-Object MainWindowTitle -EQ 'PaseoConsoleTest-\${process.pid}').Count -gt 0;
        [System.IO.File]::WriteAllText('\${observation.replaceAll("'", "''")}', ($consoleVisible -or $terminalVisible).ToString().ToLowerInvariant());
        if ($attached) { [ConsoleProbe]::FreeConsole() | Out-Null }
      \`;
      execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { windowsHide: true, stdio: "ignore", timeout: 5000 });
      const visible = readFileSync(observation, "utf8");
      process.on("message", message => {
        if (message.type === "paseo:graceful-shutdown") process.exit(0);
      });
      process.send({ type: "paseo:ready", listen: count + ":visible=" + visible, serverId: "srv_fixture" }, () => {
        if (count === 1) process.send({ type: "paseo:restart" });
        else if (count === 2) process.exit(1);
        else process.send({ type: "paseo:shutdown" });
      });
    `,
      0,
      { packagedSpawn, background: true, timeoutMs: 20_000 },
    );
    expect(result.code, result.output).toBe(0);
    expect(result.events, result.output).toEqual([
      "1:visible=false",
      null,
      "2:visible=false",
      null,
      "3:visible=false",
      null,
    ]);
  },
);
