import { spawn } from "node:child_process";
import { once } from "node:events";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, expect, it, test } from "vitest";
import { withExclusiveFileLock, writeFileAtomic, writeJsonFileAtomic } from "./atomic-file.js";

let directory: string;
const lockDirectories: string[] = [];

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "paseo-atomic-file-"));
});
afterEach(async () => {
  await fs.rm(directory, { recursive: true, force: true });
  await Promise.all(
    lockDirectories.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

it.each(["EPERM", "EACCES", "EBUSY"])(
  "commits a completed receipt after transient Windows %s replace failures",
  async (code) => {
    const file = path.join(directory, "receipt.json");
    await writeJsonFileAtomic(file, { state: "pending" });
    let failures = 3;
    let elapsed = 0;
    await writeJsonFileAtomic(
      file,
      { state: "completed" },
      {
        platform: "win32",
        now: () => elapsed,
        sleep: async (milliseconds) => {
          elapsed += milliseconds;
        },
        rename: async (source, destination) => {
          if (failures-- > 0) {
            expect(JSON.parse(await fs.readFile(destination, "utf8"))).toEqual({
              state: "pending",
            });
            expect(JSON.parse(await fs.readFile(source, "utf8"))).toEqual({ state: "completed" });
            throw Object.assign(new Error("destination held open"), { code });
          }
          await fs.rename(source, destination);
        },
      },
    );
    expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual({ state: "completed" });
    expect(await fs.readdir(directory)).toEqual(["receipt.json"]);
    expect(elapsed).toBeGreaterThan(0);
  },
);

it.each(["EPERM", "EACCES", "EBUSY"])(
  "preserves the previous file and removes the temp file when Windows %s persists",
  async (code) => {
    const file = path.join(directory, "receipt.json");
    await writeJsonFileAtomic(file, { state: "pending" });
    const error = Object.assign(new Error("destination held open"), { code });
    const waits: number[] = [];
    let elapsed = 0;
    const attempts: number[] = [];
    await expect(
      writeJsonFileAtomic(
        file,
        { state: "completed" },
        {
          platform: "win32",
          now: () => elapsed,
          sleep: async (milliseconds) => {
            waits.push(milliseconds);
            elapsed += milliseconds;
          },
          rename: async () => {
            attempts.push(elapsed);
            throw error;
          },
        },
      ),
    ).rejects.toBe(error);
    expect(elapsed).toBe(1000);
    expect(waits.slice(0, 5)).toEqual([10, 20, 40, 80, 100]);
    expect(Math.max(...waits)).toBe(100);
    expect(attempts.every((time) => time < 1000)).toBe(true);
    expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual({ state: "pending" });
    expect(await fs.readdir(directory)).toEqual(["receipt.json"]);
  },
);

it.each([
  ["linux", "EPERM"],
  ["darwin", "EACCES"],
  ["linux", "EBUSY"],
  ["win32", "ENOENT"],
  ["win32", "ENOSPC"],
  ["win32", "EXDEV"],
] as const)("does not retry %s %s failures", async (platform, code) => {
  const file = path.join(directory, "receipt.json");
  await writeJsonFileAtomic(file, { state: "pending" });
  const error = Object.assign(new Error("rename failed"), { code });
  let attempts = 0;
  const waits: number[] = [];
  await expect(
    writeFileAtomic(file, "replacement", {
      platform,
      now: () => 0,
      sleep: async (milliseconds) => {
        waits.push(milliseconds);
      },
      rename: async () => {
        attempts++;
        throw error;
      },
    }),
  ).rejects.toBe(error);
  expect(attempts).toBe(1);
  expect(waits).toEqual([]);
  expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual({ state: "pending" });
  expect(await fs.readdir(directory)).toEqual(["receipt.json"]);
});

it("does not retry after a rename consumes the Windows retry budget", async () => {
  const file = path.join(directory, "receipt.json");
  const error = Object.assign(new Error("slow rename failed"), { code: "EPERM" });
  let elapsed = 0;
  const waits: number[] = [];
  await expect(
    writeFileAtomic(file, "replacement", {
      platform: "win32",
      now: () => elapsed,
      sleep: async (milliseconds) => {
        waits.push(milliseconds);
      },
      rename: async () => {
        elapsed += 1000;
        throw error;
      },
    }),
  ).rejects.toBe(error);
  expect(waits).toEqual([]);
  expect(await fs.readdir(directory)).toEqual([]);
});

it("creates parent directories and replaces binary and JSON files through the default runtime", async () => {
  const file = path.join(directory, "nested", "file");
  const bytes = Buffer.from([0, 255, 128, 1]);
  await writeFileAtomic(file, bytes);
  expect(await fs.readFile(file)).toEqual(bytes);
  await writeJsonFileAtomic(file, { state: "completed" });
  expect(await fs.readFile(file, "utf8")).toBe('{\n  "state": "completed"\n}');
  expect(await fs.readdir(path.dirname(file))).toEqual(["file"]);
async function fixture(): Promise<{ directory: string; lockPath: string }> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "paseo-atomic-file-lock-"));
  lockDirectories.push(directory);
  return { directory, lockPath: path.join(directory, "resource.lock") };
}

async function abandonLock(lockPath: string): Promise<void> {
  const moduleUrl = pathToFileURL(path.join(import.meta.dirname, "atomic-file.ts")).href;
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
  await expect(fs.readFile(lockPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
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
  await expect(fs.readFile(`${lockPath}.recovery`, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
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
  await fs.writeFile(`${lockPath}.recovery`, "not lock metadata");

  await expect(withExclusiveFileLock(lockPath, async () => undefined)).rejects.toThrow(
    "file_lock_invalid",
  );
});

test("process-instance identity participates in release ownership", async () => {
  const { lockPath } = await fixture();

  await expect(
    withExclusiveFileLock(lockPath, async () => {
      const owner = JSON.parse(await fs.readFile(lockPath, "utf8")) as Record<string, unknown>;
      await fs.writeFile(
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
      const owner = JSON.parse(await fs.readFile(lockPath, "utf8")) as Record<string, unknown>;
      const createdAt = new Date(Date.parse(String(owner.createdAt)) + 1_000).toISOString();
      await fs.writeFile(lockPath, JSON.stringify({ ...owner, createdAt }));
    }),
  ).rejects.toThrow("file_lock_ownership_lost");
});

test("fails closed when a live PID has a different process-instance identity", async () => {
  const { lockPath } = await fixture();
  await fs.writeFile(
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

test.skipIf(process.platform === "win32")(
  "preserves requested source permissions and ownership during replacement",
  async () => {
    const { directory } = await fixture();
    const filePath = path.join(directory, "ledger.md");
    await fs.writeFile(filePath, "before");
    await fs.chmod(filePath, 0o600);
    const before = await fs.stat(filePath);

    await writeFileAtomic(filePath, "after", undefined, {
      expectedSource: "before",
      expectedSourceStat: before,
      preserveSourceMetadata: true,
    });

    const after = await fs.stat(filePath);
    expect(after.mode & 0o7777).toBe(0o600);
    expect({ uid: after.uid, gid: after.gid }).toEqual({ uid: before.uid, gid: before.gid });
  },
);
