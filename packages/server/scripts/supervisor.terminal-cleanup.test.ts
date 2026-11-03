import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

// A real supervisor with scripted workers. Each worker generation logs what it sees to an
// events file; `cleanupTerminals` logs "cleanup". The order of events is the contract: a kill
// intent cleans up before the next worker starts, a keep intent or a crash never cleans up.

async function runSupervisorWith(workerScript: string, timeoutMs = 8_000) {
  const home = await mkdtemp(path.join(tmpdir(), "paseo-terminal-cleanup-"));
  const workerPath = path.join(home, "worker.mjs");
  const runnerPath = path.join(home, "runner.mjs");
  const eventsPath = path.join(home, "events.jsonl");
  const supervisor = new URL("./supervisor.ts", import.meta.url).href;
  await writeFile(
    workerPath,
    `
    import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
    const counter = ${JSON.stringify(path.join(home, "generation"))};
    const generation = existsSync(counter) ? Number(readFileSync(counter, "utf8")) + 1 : 1;
    writeFileSync(counter, String(generation));
    const record = (event) =>
      appendFileSync(${JSON.stringify(eventsPath)}, JSON.stringify(event) + "\\n");
    record({ started: generation });
    ${workerScript}
  `,
  );
  await writeFile(
    runnerPath,
    `
    import { appendFileSync } from "node:fs";
    import { runSupervisor } from ${JSON.stringify(supervisor)};
    runSupervisor({
      name: "TerminalCleanupTest", startupMessage: "starting", restartOnCrash: true,
      resolveWorkerEntry: () => ${JSON.stringify(workerPath)}, workerArgs: [], workerExecArgv: [],
      cleanupTerminals: async () => {
        appendFileSync(${JSON.stringify(eventsPath)}, JSON.stringify("cleanup") + "\\n");
      },
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
  });
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(output));
      }, timeoutMs);
      child.once("error", reject);
      child.once("close", (exitCode) => {
        clearTimeout(timer);
        resolve(exitCode);
      });
    });
    const events = (await readFile(eventsPath, "utf8").catch(() => ""))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as unknown);
    return { code, output, events };
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

// Generation 1 asks for `firstIntent`; generation 2 (if any) stops with `secondIntent`.
function scriptedWorker(firstIntent: string, secondIntent = "") {
  return `
    process.on("message", (message) => {
      if (message.type !== "paseo:graceful-shutdown") return;
      record({ graceful: generation, keepTerminals: message.keepTerminals });
      process.exit(0);
    });
    process.send({ type: "paseo:ready", listen: "endpoint-" + generation, serverId: "srv" });
    if (generation === 1) { ${firstIntent} }
    else { ${secondIntent} }
  `;
}

const stopKeeping = `process.send({ type: "paseo:shutdown", reason: "test", keepTerminals: true });`;

describe("supervisor terminal cleanup", () => {
  test("a keep restart passes keepTerminals and never cleans up", async () => {
    const result = await runSupervisorWith(
      scriptedWorker(
        `process.send({ type: "paseo:restart", reason: "test", keepTerminals: true });`,
        stopKeeping,
      ),
    );
    expect(result.code, result.output).toBe(0);
    expect(result.events).toEqual([
      { started: 1 },
      { graceful: 1, keepTerminals: true },
      { started: 2 },
      { graceful: 2, keepTerminals: true },
    ]);
  });

  test("a kill restart cleans up after the worker exits and before the respawn", async () => {
    const result = await runSupervisorWith(
      scriptedWorker(
        `process.send({ type: "paseo:restart", reason: "test", keepTerminals: false });`,
        stopKeeping,
      ),
    );
    expect(result.code, result.output).toBe(0);
    expect(result.events).toEqual([
      { started: 1 },
      { graceful: 1, keepTerminals: false },
      "cleanup",
      { started: 2 },
      { graceful: 2, keepTerminals: true },
    ]);
  });

  test("a kill restart whose worker hangs cleans up after the forced kill, before the respawn", async () => {
    const result = await runSupervisorWith(
      `
      process.on("message", (message) => {
        if (message.type !== "paseo:graceful-shutdown") return;
        record({ graceful: generation, keepTerminals: message.keepTerminals });
        if (generation === 2) process.exit(0);
      });
      process.send({ type: "paseo:ready", listen: "endpoint-" + generation, serverId: "srv" });
      if (generation === 1) {
        process.send({ type: "paseo:restart", reason: "test", keepTerminals: false });
        setInterval(() => {}, 1000);
      } else {
        ${stopKeeping}
      }
    `,
      20_000,
    );
    expect(result.code, result.output).toBe(0);
    expect(result.events).toEqual([
      { started: 1 },
      { graceful: 1, keepTerminals: false },
      "cleanup",
      { started: 2 },
      { graceful: 2, keepTerminals: true },
    ]);
  }, 30_000);

  test("a crash restart keeps terminals", async () => {
    const result = await runSupervisorWith(scriptedWorker(`process.exit(1);`, stopKeeping));
    expect(result.code, result.output).toBe(0);
    expect(result.events).toEqual([
      { started: 1 },
      { started: 2 },
      { graceful: 2, keepTerminals: true },
    ]);
  });

  test("a kill stop cleans up when the supervisor exits", async () => {
    const result = await runSupervisorWith(
      scriptedWorker(
        `process.send({ type: "paseo:shutdown", reason: "test", keepTerminals: false });`,
      ),
    );
    expect(result.code, result.output).toBe(0);
    expect(result.events).toEqual([
      { started: 1 },
      { graceful: 1, keepTerminals: false },
      "cleanup",
    ]);
  });
});
