import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

async function runWorker(worker: string, publicationDelay = 0) {
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
      }, 5_000);
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
    process.send({ type: "paseo:ready", listen: "test-endpoint" });
    process.send({ type: "paseo:restart" });
  `);
  expect(result.code).toBe(1);
  expect(result.events, result.output).toEqual(["test-endpoint", null, null]);
});

test("exit clears publication after an in-flight ready write", async () => {
  const result = await runWorker(
    `
    process.send({ type: "paseo:ready", listen: "test-endpoint" }, () => process.exit(0));
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
