import { afterEach, describe, expect, test, vi } from "vitest";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import * as fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { terminalFileKey, TerminalFileLifecycle } from "../terminal/terminal-file-lifecycle.js";
import {
  TerminalImageStore,
  terminalImageReference,
  terminalImageFileSystem,
} from "./host-clipboard.js";

// Inject failures only at filesystem boundaries; all storage remains real.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rename: vi.fn(actual.rename), readFile: vi.fn(actual.readFile) };
});

const roots: string[] = [];
const PNG = Buffer.from("89504e470d0a1a0a", "hex");
const payload = (terminalId: string, suffix = "") => ({
  terminalId,
  mimeType: "image/png" as const,
  dataBase64: Buffer.concat([PNG, Buffer.from(suffix)]).toString("base64"),
});
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    roots.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
async function root() {
  const path = await mkdtemp(join(tmpdir(), "terminal image O'Brien-"));
  roots.push(path);
  return path;
}

function createStore(options: ConstructorParameters<typeof TerminalImageStore>[0]) {
  const owner = (key: string) =>
    ["a", "b", "c", "d", "gone"].find(
      (id) => terminalFileKey(id) === key && options.isActive(id),
    ) ?? null;
  return new TerminalImageStore({
    ...options,
    lifecycle: {
      owner,
      claimInactive: (key) => (owner(key) === null ? () => {} : undefined),
      subscribe: () => () => {},
    },
  });
}

describe("terminal image storage", () => {
  test("isolates concurrent terminals and retains bytes across reconnect and store restart", async () => {
    const directory = join(await root(), "images");
    const store = createStore({ directory, isActive: () => true });
    const [a, b] = await Promise.all([
      store.save(payload("a", "A")),
      store.save(payload("b", "B")),
    ]);
    expect(dirname(a)).not.toBe(dirname(b));
    const restarted = createStore({ directory, isActive: () => true });
    await restarted.save(payload("a", "later"));
    expect(await readFile(a)).toEqual(Buffer.concat([PNG, Buffer.from("A")]));
    expect(await readFile(b)).toEqual(Buffer.concat([PNG, Buffer.from("B")]));
  });

  test.skipIf(process.platform === "win32")(
    "directories and image bytes are owner-only",
    async () => {
      const directory = join(await root(), "images");
      const store = createStore({ directory, isActive: () => true });
      const path = await store.save(payload("a"));
      expect((await stat(directory)).mode & 0o777).toBe(0o700);
      expect((await stat(dirname(path))).mode & 0o777).toBe(0o700);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect((await stat(join(dirname(path), "terminal.json"))).mode & 0o777).toBe(0o600);
    },
  );

  test("never evicts active images; retirement survives restart and permits delayed reads", async () => {
    const directory = join(await root(), "images");
    let now = 0;
    const active = new Set(["a", "b"]);
    const options = {
      directory,
      now: () => now,
      isActive: (id: string) => active.has(id),
      retentionMs: 100,
    };
    const store = createStore(options);
    const a = await store.save(payload("a"));
    now = 1000;
    await store.save(payload("b"));
    expect(await readFile(a)).toEqual(PNG);
    active.delete("a");
    await store.sweep();
    await store.save(payload("b"));
    now = 1099;
    const restarted = createStore(options);
    await restarted.save(payload("b"));
    expect(await readFile(a)).toEqual(PNG);
    now = 1100;
    await restarted.sweep();
    await restarted.save(payload("b"));
    await expect(stat(a)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("reactivation cancels retirement", async () => {
    const directory = join(await root(), "images");
    let now = 0;
    const active = new Set(["a", "b"]);
    const store = createStore({
      directory,
      now: () => now,
      isActive: (id) => active.has(id),
      retentionMs: 100,
    });
    const a = await store.save(payload("a"));
    active.delete("a");
    await store.sweep();
    await store.save(payload("b"));
    active.add("a");
    now = 200;
    await store.save(payload("a"));
    expect(await readFile(a)).toEqual(PNG);
  });

  test("serialized global/per-terminal/count limits reject uploads without evicting files", async () => {
    const directory = join(await root(), "images");
    const store = createStore({
      directory,
      isActive: () => true,
      maxBytes: 16,
      maxTerminalBytes: 8,
      maxFiles: 2,
    });
    const a = await store.save(payload("a"));
    await expect(store.save(payload("a"))).rejects.toThrow("storage limit reached");
    const results = await Promise.allSettled([store.save(payload("b")), store.save(payload("c"))]);
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(await readFile(a)).toEqual(PNG);
    const restarted = createStore({ directory, isActive: () => true, maxBytes: 16 });
    await expect(restarted.save(payload("d"))).rejects.toThrow("storage limit reached");
  });

  test.each([undefined, "", '{"terminalId":', "null", "{}", '{"terminalId":"wrong"}'])(
    "recovers owner metadata %s without dropping retained bytes or quota accounting",
    async (metadata) => {
      const directory = join(await root(), "images");
      const options = { directory, isActive: () => true, maxBytes: 24, maxTerminalBytes: 8 };
      const original = await createStore(options).save(payload("a"));
      const ownerPath = join(dirname(original), "terminal.json");
      if (metadata === undefined) await rm(ownerPath);
      else await writeFile(ownerPath, metadata);
      // An abandoned temporary write must not become authoritative metadata.
      await writeFile(`${ownerPath}.interrupted.tmp`, '{"terminalId":');
      const restarted = createStore(options);
      await restarted.save(payload("b"));
      const counted = createStore({ ...options, maxBytes: 16 });
      await expect(counted.save(payload("c"))).rejects.toThrow("storage limit reached");
      await expect(restarted.save(payload("a"))).rejects.toThrow("storage limit reached");
      expect(JSON.parse(await readFile(ownerPath, "utf8"))).toEqual({ terminalId: "a" });
      expect(await readFile(original)).toEqual(PNG);
    },
  );

  test("unknown owners start a fresh grace period instead of trusting old retirement metadata", async () => {
    const directory = join(await root(), "images");
    const original = await createStore({ directory, isActive: () => true }).save(payload("a"));
    await rm(join(dirname(original), "terminal.json"));
    await writeFile(join(dirname(original), "retired.json"), "0");
    const restarted = createStore({
      directory,
      isActive: (id) => id === "b",
      now: () => 1000,
      retentionMs: 100,
      maxFiles: 1,
    });
    await restarted.sweep();
    expect(await readFile(original)).toEqual(PNG);
  });

  test("an interrupted empty directory does not block another terminal or its eventual owner", async () => {
    const directory = join(await root(), "images");
    await mkdir(join(directory, createHash("sha256").update("a").digest("hex")), {
      recursive: true,
    });
    const store = createStore({ directory, isActive: () => true });
    expect(await readFile(await store.save(payload("b")))).toEqual(PNG);
    expect(await readFile(await store.save(payload("a")))).toEqual(PNG);
  });

  test.each(["", "null", "{}", '"invalid"'])(
    "invalid retirement %s starts a full persisted grace period",
    async (metadata) => {
      const directory = join(await root(), "images");
      let now = 1000;
      const active = new Set(["a", "b"]);
      const options = {
        directory,
        isActive: (id: string) => active.has(id),
        now: () => now,
        retentionMs: 100,
      };
      const original = await createStore(options).save(payload("a"));
      active.delete("a");
      await writeFile(join(dirname(original), "retired.json"), metadata);
      await createStore(options).sweep();
      expect(await readFile(join(dirname(original), "retired.json"), "utf8")).toBe("1000");
      now = 1099;
      await createStore(options).save(payload("b"));
      expect(await readFile(original)).toEqual(PNG);
      now = 1100;
      await createStore(options).sweep();
      await expect(stat(original)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  test("reactivation cancels corrupted retirement without rewriting valid owner metadata", async () => {
    const directory = join(await root(), "images");
    const options = { directory, isActive: () => true };
    const original = await createStore(options).save(payload("a"));
    const ownerPath = join(dirname(original), "terminal.json");
    const originalMetadata = '{ "terminalId": "a" }';
    await writeFile(ownerPath, originalMetadata);
    await writeFile(join(dirname(original), "retired.json"), "{");
    await createStore(options).save(payload("a"));
    expect(await readFile(ownerPath, "utf8")).toBe(originalMetadata);
    await expect(stat(join(dirname(original), "retired.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await readFile(original)).toEqual(PNG);
  });

  test("failed atomic publication preserves old metadata and images, and retry recovers", async () => {
    const directory = join(await root(), "images");
    const options = { directory, isActive: () => true };
    const original = await createStore(options).save(payload("a"));
    const ownerPath = join(dirname(original), "terminal.json");
    await writeFile(ownerPath, "{");
    const failure = Object.assign(new Error("rename failed"), { code: "EIO" });
    vi.spyOn(fs, "rename").mockRejectedValueOnce(failure);
    await expect(createStore(options).save(payload("a"))).rejects.toBe(failure);
    expect(await readFile(ownerPath, "utf8")).toBe("{");
    expect(await readFile(original)).toEqual(PNG);
    expect((await readdir(dirname(original))).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    await createStore(options).save(payload("a"));
    expect(JSON.parse(await readFile(ownerPath, "utf8"))).toEqual({ terminalId: "a" });
  });

  test("real metadata read errors remain visible", async () => {
    const directory = join(await root(), "images");
    const store = createStore({ directory, isActive: () => true });
    await store.save(payload("a"));
    const failure = Object.assign(new Error("permission denied"), { code: "EACCES" });
    vi.spyOn(fs, "readFile").mockRejectedValueOnce(failure);
    await expect(store.save(payload("a"))).rejects.toBe(failure);
  });

  test("rejects closed terminals and invalid/oversized images", async () => {
    const directory = join(await root(), "images");
    const store = createStore({ directory, isActive: () => false });
    await expect(store.save(payload("gone"))).rejects.toThrow("no longer exists");
    await expect(store.save({ ...payload("a"), dataBase64: "not image" })).rejects.toThrow(
      "encoding",
    );
    await expect(store.save({ ...payload("a"), mimeType: "image/jpeg" })).rejects.toThrow(
      "image type",
    );
    await expect(
      store.save({ ...payload("a"), dataBase64: "A".repeat(14 * 1024 * 1024) }),
    ).rejects.toThrow("10 MiB");
  });

  test.skipIf(process.platform === "win32")(
    "does not follow a replaced storage directory",
    async () => {
      const directory = join(await root(), "images");
      await symlink(await root(), directory);
      await expect(
        createStore({ directory, isActive: () => true }).save(payload("a")),
      ).rejects.toThrow("Unsafe");
    },
  );
});

describe("terminal file references", () => {
  test.each([
    ["/home/O'Brien/my images/image.png", "linux"],
    ["C:\\Users\\O'Brien\\my images\\image.png", "win32"],
  ] as const)("preserves spaces and apostrophes for %s", (path, platform) => {
    expect(terminalImageReference(path, platform)).toBe(`"${path}"`);
  });
  test("encodes control and interpolation characters without losing filename bytes", () => {
    const path = '/tmp/dollar$ back` slash\\ quote"/image.png';
    const reference = terminalImageReference(path, "linux");
    expect(reference.startsWith("file://")).toBe(true);
    expect(fileURLToPath(reference)).toBe(path);
  });
  test("uses host Windows URL semantics, independent of the client OS", () => {
    expect(terminalImageReference("C:\\Users\\name%name\\image.png", "win32")).toBe(
      "file:///C:/Users/name%25name/image.png",
    );
  });
});

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

test("startup accounting waits inside uploads and reserves concurrent quotas after readiness", async () => {
  const directory = join(await root(), "images");
  const original = await createStore({ directory, isActive: () => true }).save(payload("a"));
  const entered = gate(),
    resume = gate();
  const filesystem: typeof terminalImageFileSystem = {
    ...terminalImageFileSystem,
    readdir: async (...args: Parameters<typeof terminalImageFileSystem.readdir>) => {
      entered.release();
      await resume.promise;
      return terminalImageFileSystem.readdir(...args);
    },
  };
  const store = createStore({ directory, filesystem, isActive: () => true, maxFiles: 2 });
  let completed = false;
  const upload = store.save(payload("b")).then((path) => {
    completed = true;
    return path;
  });
  await entered.promise;
  expect(completed).toBe(false);
  const competing = store.save(payload("c"));
  const results = Promise.allSettled([upload, competing]);
  resume.release();
  expect((await results).filter((result) => result.status === "fulfilled")).toHaveLength(1);
  expect(await readFile(original)).toEqual(PNG);
});

test("background deletion never queues other uploads and releases only its own accounting", async () => {
  const directory = join(await root(), "images");
  const lifecycle = new TerminalFileLifecycle();
  await lifecycle.begin("a");
  await lifecycle.begin("b");
  await lifecycle.begin("c");
  let now = 0;
  const entered = gate(),
    resume = gate();
  const filesystem: typeof terminalImageFileSystem = {
    ...terminalImageFileSystem,
    rm: async (path, options) => {
      if (String(path) === join(directory, terminalFileKey("a"))) {
        entered.release();
        await resume.promise;
      }
      return terminalImageFileSystem.rm(path, options);
    },
  };
  const store = new TerminalImageStore({
    directory,
    lifecycle,
    filesystem,
    isActive: (id) => lifecycle.owner(terminalFileKey(id)) === id,
    now: () => now,
    retentionMs: 100,
    maxFiles: 2,
  });
  await store.save(payload("a"));
  lifecycle.end("a");
  await store.sweep();
  now = 100;
  const cleanup = store.sweep();
  await entered.promise;
  try {
    const b = await store.save(payload("b"));
    expect(await readFile(b)).toEqual(PNG);
    await expect(store.save(payload("c"))).rejects.toThrow("storage limit reached");
  } finally {
    resume.release();
  }
  await cleanup;
  expect(await readFile(await store.save(payload("c")))).toEqual(PNG);
  await expect(store.save(payload("b"))).rejects.toThrow("storage limit reached");
});

test("orphan inactivity persists across restart and releases quota without another owner upload", async () => {
  const directory = join(await root(), "images");
  const original = await createStore({ directory, isActive: () => true }).save(payload("a"));
  await rm(join(dirname(original), "terminal.json"));
  await writeFile(join(dirname(original), "retired.json"), "0");
  let now = 1000;
  const lifecycle = new TerminalFileLifecycle();
  await lifecycle.begin("b");
  const options = {
    directory,
    lifecycle,
    isActive: (id: string) => id === "b",
    now: () => now,
    retentionMs: 100,
    maxFiles: 1,
  };
  const store = new TerminalImageStore(options);
  await store.sweep();
  expect(JSON.parse(await readFile(join(dirname(original), "retired.json"), "utf8"))).toEqual({
    orphanedAt: 1000,
  });
  await expect(store.save(payload("b"))).rejects.toThrow("storage limit reached");
  now = 1099;
  const restarted = new TerminalImageStore(options);
  await restarted.sweep();
  expect(await readFile(original)).toEqual(PNG);
  now = 1100;
  await restarted.sweep();
  expect(await readFile(await restarted.save(payload("b")))).toEqual(PNG);
  await expect(stat(original)).rejects.toMatchObject({ code: "ENOENT" });
});

test("active orphan recovery uses the lifecycle hash; unavailable inventory retains images", async () => {
  const directory = join(await root(), "images");
  const original = await createStore({ directory, isActive: () => true }).save(payload("a"));
  const ownerPath = join(dirname(original), "terminal.json");
  await writeFile(ownerPath, "{");
  const lifecycle = new TerminalFileLifecycle();
  await lifecycle.begin("a");
  const store = new TerminalImageStore({ directory, lifecycle, isActive: () => true });
  await store.sweep();
  expect(JSON.parse(await readFile(ownerPath, "utf8"))).toEqual({ terminalId: "a" });
  lifecycle.end("a");
  lifecycle.unavailable();
  await writeFile(join(dirname(original), "retired.json"), "0");
  await store.sweep();
  expect(await readFile(original)).toEqual(PNG);
});

test("a partial ENOSPC write releases quota only after confirmed removal", async () => {
  const directory = join(await root(), "images");
  let failWrite = true,
    failRemoval = true;
  const filesystem: typeof terminalImageFileSystem = {
    ...terminalImageFileSystem,
    writeFile: async (path, data, options) => {
      await terminalImageFileSystem.writeFile(path, data, options);
      if (String(path).endsWith(".png") && failWrite)
        throw Object.assign(new Error("disk failure"), { code: "ENOSPC" });
    },
    rm: async (path, options) => {
      if (String(path).endsWith(".png") && failRemoval)
        throw Object.assign(new Error("cannot remove"), { code: "EACCES" });
      await terminalImageFileSystem.rm(path, options);
    },
  };
  const store = createStore({ directory, filesystem, isActive: () => true, maxFiles: 1 });
  await expect(store.save(payload("a"))).rejects.toThrow("Host disk is full");
  failWrite = false;
  failRemoval = false;
  await expect(store.save(payload("b"))).rejects.toThrow("storage limit reached");
  const restarted = createStore({ directory, isActive: () => true, maxFiles: 1 });
  await expect(restarted.save(payload("b"))).rejects.toThrow("storage limit reached");
});

test("successful rollback of a failed image write restores its reservation", async () => {
  const directory = join(await root(), "images");
  let fail = true;
  const filesystem: typeof terminalImageFileSystem = {
    ...terminalImageFileSystem,
    writeFile: async (path, data, options) => {
      await terminalImageFileSystem.writeFile(path, data, options);
      if (String(path).endsWith(".png") && fail)
        throw Object.assign(new Error("disk failure"), { code: "ENOSPC" });
    },
  };
  const store = createStore({ directory, filesystem, isActive: () => true, maxFiles: 1 });
  await expect(store.save(payload("a"))).rejects.toThrow("Host disk is full");
  fail = false;
  expect(await readFile(await store.save(payload("b")))).toEqual(PNG);
});

test("actual lifecycle exit schedules retirement without an upload and stop unsubscribes", async () => {
  const directory = join(await root(), "images");
  const lifecycle = new TerminalFileLifecycle();
  await lifecycle.begin("a");
  const store = new TerminalImageStore({
    directory,
    lifecycle,
    isActive: () => true,
    now: () => 1000,
  });
  const original = await store.save(payload("a"));
  store.start();
  try {
    await store.sweep();
    lifecycle.end("a");
    await expect
      .poll(async () => readFile(join(dirname(original), "retired.json"), "utf8").catch(() => ""))
      .toBe("1000");
    await store.stop();
    await lifecycle.begin("a");
    expect(await readFile(join(dirname(original), "retired.json"), "utf8")).toBe("1000");
  } finally {
    await store.stop();
  }
});

test("periodic maintenance expires retirement while idle and ordinary uploads do not scan", async () => {
  const directory = join(await root(), "images");
  const lifecycle = new TerminalFileLifecycle();
  await lifecycle.begin("a");
  let now = 0,
    scans = 0;
  const filesystem: typeof terminalImageFileSystem = {
    ...terminalImageFileSystem,
    readdir: async (path, options) => {
      scans++;
      return terminalImageFileSystem.readdir(path, options);
    },
  };
  const store = new TerminalImageStore({
    directory,
    filesystem,
    lifecycle,
    isActive: () => true,
    now: () => now,
    retentionMs: 100,
    maintenanceIntervalMs: 10,
  });
  const original = await store.save(payload("a"));
  const initialScans = scans;
  await store.save(payload("a"));
  expect(scans).toBe(initialScans);
  store.start();
  try {
    await store.sweep();
    lifecycle.end("a");
    await expect
      .poll(async () => readFile(join(dirname(original), "retired.json"), "utf8").catch(() => ""))
      .toBe("0");
    now = 100;
    await expect
      .poll(async () =>
        stat(original).then(
          () => true,
          () => false,
        ),
      )
      .toBe(false);
  } finally {
    await store.stop();
  }
});

test("reactivation during maintenance cancels deletion before the PTY is created", async () => {
  const directory = join(await root(), "images");
  const original = await createStore({ directory, isActive: () => true }).save(payload("a"));
  await writeFile(join(dirname(original), "retired.json"), "0");
  const lifecycle = new TerminalFileLifecycle();
  const entered = gate(),
    resume = gate();
  const filesystem: typeof terminalImageFileSystem = { ...terminalImageFileSystem };
  const originalRead = filesystem.readFile;
  filesystem.readFile = (async (...args: Parameters<typeof originalRead>) => {
    if (String(args[0]).endsWith("retired.json")) {
      entered.release();
      await resume.promise;
    }
    return originalRead(...args);
  }) as typeof originalRead;
  const store = new TerminalImageStore({
    directory,
    filesystem,
    lifecycle,
    isActive: () => true,
    now: () => 1000,
    retentionMs: 100,
  });
  const sweep = store.sweep();
  await entered.promise;
  const creation = lifecycle.begin("a");
  resume.release();
  await sweep;
  await creation;
  expect(await readFile(original)).toEqual(PNG);
  await store.sweep();
  await expect(stat(join(dirname(original), "retired.json"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});

test("brief reactivation between sweeps restarts the grace period", async () => {
  const directory = join(await root(), "images");
  const original = await createStore({ directory, isActive: () => true }).save(payload("a"));
  await writeFile(join(dirname(original), "retired.json"), "0");
  const lifecycle = new TerminalFileLifecycle();
  const store = new TerminalImageStore({
    directory,
    lifecycle,
    isActive: () => false,
    now: () => 1000,
    retentionMs: 100,
  });
  store.start();
  try {
    await lifecycle.begin("a");
    lifecycle.end("a");
    await store.sweep();
    expect(await readFile(original)).toEqual(PNG);
    expect(await readFile(join(dirname(original), "retired.json"), "utf8")).toBe("1000");
  } finally {
    await store.stop();
  }
});
