import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, test } from "vitest";
import { withExclusiveFileLock } from "./atomic-file.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture(): Promise<{ directory: string; lockPath: string }> {
  const directory = await mkdtemp(join(tmpdir(), "paseo-atomic-file-"));
  directories.push(directory);
  return { directory, lockPath: join(directory, "resource.lock") };
}

async function abandonLock(lockPath: string): Promise<void> {
  const moduleUrl = pathToFileURL(join(import.meta.dirname, "atomic-file.ts")).href;
  const script = [
    `import { withExclusiveFileLock } from ${JSON.stringify(moduleUrl)};`,
    `await withExclusiveFileLock(${JSON.stringify(lockPath)}, async () => process.exit(0));`,
  ].join("\n");
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", script],
    { stdio: "ignore" },
  );
  const [code, signal] = (await once(child, "exit")) as [number | null, NodeJS.Signals | null];
  expect({ code, signal }).toEqual({ code: 0, signal: null });
}

test("recovers a main lock abandoned by a dead child process", async () => {
  const { lockPath } = await fixture();
  await abandonLock(lockPath);

  let entered = false;
  await withExclusiveFileLock(lockPath, async () => {
    entered = true;
  });

  expect(entered).toBe(true);
  await expect(readFile(lockPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
});

test("recovers recovery ownership abandoned by a dead child process", async () => {
  const { lockPath } = await fixture();
  await abandonLock(lockPath);
  await abandonLock(`${lockPath}.recovery`);

  let entered = false;
  await withExclusiveFileLock(lockPath, async () => {
    entered = true;
  });

  expect(entered).toBe(true);
  await expect(readFile(`${lockPath}.recovery`, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
});

test("fails closed while recovery ownership is live", async () => {
  const { lockPath } = await fixture();
  await abandonLock(lockPath);
  let signalEntered!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => {
    signalEntered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const held = withExclusiveFileLock(`${lockPath}.recovery`, async () => {
    signalEntered();
    await gate;
  });
  await entered;
  try {
    await expect(withExclusiveFileLock(lockPath, async () => undefined)).rejects.toThrow(
      "file_lock_recovery_busy",
    );
  } finally {
    release();
    await held;
  }
});

test("fails closed on malformed recovery ownership", async () => {
  const { lockPath } = await fixture();
  await abandonLock(lockPath);
  await writeFile(`${lockPath}.recovery`, "not lock metadata");

  await expect(withExclusiveFileLock(lockPath, async () => undefined)).rejects.toThrow(
    "file_lock_invalid",
  );
});

test("process-instance identity participates in release ownership", async () => {
  const { lockPath } = await fixture();

  await expect(
    withExclusiveFileLock(lockPath, async () => {
      const owner = JSON.parse(await readFile(lockPath, "utf8")) as Record<string, unknown>;
      await writeFile(
        lockPath,
        JSON.stringify({ ...owner, processStartedAt: "2000-01-01T00:00:00.000Z" }),
      );
    }),
  ).rejects.toThrow("file_lock_ownership_lost");
});

test("lock creation time participates in release ownership", async () => {
  const { lockPath } = await fixture();

  await expect(
    withExclusiveFileLock(lockPath, async () => {
      const owner = JSON.parse(await readFile(lockPath, "utf8")) as Record<string, unknown>;
      const createdAt = new Date(Date.parse(String(owner.createdAt)) + 1_000).toISOString();
      await writeFile(lockPath, JSON.stringify({ ...owner, createdAt }));
    }),
  ).rejects.toThrow("file_lock_ownership_lost");
});

test("fails closed when a live PID has a different process-instance identity", async () => {
  const { lockPath } = await fixture();
  await writeFile(
    lockPath,
    JSON.stringify({
      pid: process.pid,
      processStartedAt: "2000-01-01T00:00:00.000Z",
      token: "previous-process-instance",
      createdAt: "2000-01-01T00:00:01.000Z",
    }),
  );

  await expect(withExclusiveFileLock(lockPath, async () => undefined)).rejects.toThrow(
    "file_lock_busy",
  );
});
