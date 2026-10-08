import { afterEach, describe, expect, test, vi } from "vitest";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import * as fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TerminalImageStore, terminalImageReference } from "./host-clipboard.js";

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

describe("terminal image storage", () => {
  test("isolates concurrent terminals and retains bytes across reconnect and store restart", async () => {
    const directory = join(await root(), "images");
    const store = new TerminalImageStore({ directory, isActive: () => true });
    const [a, b] = await Promise.all([
      store.save(payload("a", "A")),
      store.save(payload("b", "B")),
    ]);
    expect(dirname(a)).not.toBe(dirname(b));
    const restarted = new TerminalImageStore({ directory, isActive: () => true });
    await restarted.save(payload("a", "later"));
    expect(await readFile(a)).toEqual(Buffer.concat([PNG, Buffer.from("A")]));
    expect(await readFile(b)).toEqual(Buffer.concat([PNG, Buffer.from("B")]));
  });

  test.skipIf(process.platform === "win32")(
    "directories and image bytes are owner-only",
    async () => {
      const directory = join(await root(), "images");
      const store = new TerminalImageStore({ directory, isActive: () => true });
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
    const store = new TerminalImageStore(options);
    const a = await store.save(payload("a"));
    now = 1000;
    await store.save(payload("b"));
    expect(await readFile(a)).toEqual(PNG);
    active.delete("a");
    await store.save(payload("b"));
    now = 1099;
    const restarted = new TerminalImageStore(options);
    await restarted.save(payload("b"));
    expect(await readFile(a)).toEqual(PNG);
    now = 1100;
    await restarted.save(payload("b"));
    await expect(stat(a)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("reactivation cancels retirement", async () => {
    const directory = join(await root(), "images");
    let now = 0;
    const active = new Set(["a", "b"]);
    const store = new TerminalImageStore({
      directory,
      now: () => now,
      isActive: (id) => active.has(id),
      retentionMs: 100,
    });
    const a = await store.save(payload("a"));
    active.delete("a");
    await store.save(payload("b"));
    active.add("a");
    now = 200;
    await store.save(payload("a"));
    expect(await readFile(a)).toEqual(PNG);
  });

  test("serialized global/per-terminal/count limits reject uploads without evicting files", async () => {
    const directory = join(await root(), "images");
    const store = new TerminalImageStore({
      directory,
      isActive: () => true,
      maxBytes: 16,
      maxTerminalBytes: 8,
      maxFiles: 2,
    });
    const a = await store.save(payload("a"));
    await expect(store.save(payload("a"))).rejects.toThrow("storage is full");
    const results = await Promise.allSettled([store.save(payload("b")), store.save(payload("c"))]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected"]);
    expect(await readFile(a)).toEqual(PNG);
    const restarted = new TerminalImageStore({ directory, isActive: () => true, maxBytes: 16 });
    await expect(restarted.save(payload("d"))).rejects.toThrow("storage is full");
  });

  test.each([undefined, "", '{"terminalId":', "null", "{}", '{"terminalId":"wrong"}'])(
    "recovers owner metadata %s without dropping retained bytes or quota accounting",
    async (metadata) => {
      const directory = join(await root(), "images");
      const options = { directory, isActive: () => true, maxBytes: 24, maxTerminalBytes: 8 };
      const original = await new TerminalImageStore(options).save(payload("a"));
      const ownerPath = join(dirname(original), "terminal.json");
      if (metadata === undefined) await rm(ownerPath);
      else await writeFile(ownerPath, metadata);
      // An abandoned temporary write must not become authoritative metadata.
      await writeFile(`${ownerPath}.interrupted.tmp`, '{"terminalId":');
      const restarted = new TerminalImageStore(options);
      await restarted.save(payload("b"));
      const counted = new TerminalImageStore({ ...options, maxBytes: 16 });
      await expect(counted.save(payload("c"))).rejects.toThrow("storage is full");
      await expect(restarted.save(payload("a"))).rejects.toThrow("storage is full");
      expect(JSON.parse(await readFile(ownerPath, "utf8"))).toEqual({ terminalId: "a" });
      expect(await readFile(original)).toEqual(PNG);
    },
  );

  test("unknown owners remain retained and count toward file limits beyond the grace period", async () => {
    const directory = join(await root(), "images");
    const original = await new TerminalImageStore({ directory, isActive: () => true }).save(
      payload("a"),
    );
    await rm(join(dirname(original), "terminal.json"));
    await writeFile(join(dirname(original), "retired.json"), "0");
    const restarted = new TerminalImageStore({
      directory,
      isActive: () => false,
      now: () => 1000,
      retentionMs: 100,
      maxFiles: 1,
    });
    await expect(restarted.save(payload("b"))).rejects.toThrow("storage is full");
    expect(await readFile(original)).toEqual(PNG);
  });

  test("an interrupted empty directory does not block another terminal or its eventual owner", async () => {
    const directory = join(await root(), "images");
    await mkdir(join(directory, createHash("sha256").update("a").digest("hex")), {
      recursive: true,
    });
    const store = new TerminalImageStore({ directory, isActive: () => true });
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
      const original = await new TerminalImageStore(options).save(payload("a"));
      active.delete("a");
      await writeFile(join(dirname(original), "retired.json"), metadata);
      await new TerminalImageStore(options).save(payload("b"));
      expect(await readFile(join(dirname(original), "retired.json"), "utf8")).toBe("1000");
      now = 1099;
      await new TerminalImageStore(options).save(payload("b"));
      expect(await readFile(original)).toEqual(PNG);
      now = 1100;
      await new TerminalImageStore(options).save(payload("b"));
      await expect(stat(original)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  test("reactivation cancels corrupted retirement without rewriting valid owner metadata", async () => {
    const directory = join(await root(), "images");
    const options = { directory, isActive: () => true };
    const original = await new TerminalImageStore(options).save(payload("a"));
    const ownerPath = join(dirname(original), "terminal.json");
    const originalMetadata = '{ "terminalId": "a" }';
    await writeFile(ownerPath, originalMetadata);
    await writeFile(join(dirname(original), "retired.json"), "{");
    await new TerminalImageStore(options).save(payload("a"));
    expect(await readFile(ownerPath, "utf8")).toBe(originalMetadata);
    await expect(stat(join(dirname(original), "retired.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await readFile(original)).toEqual(PNG);
  });

  test("failed atomic publication preserves old metadata and images, and retry recovers", async () => {
    const directory = join(await root(), "images");
    const options = { directory, isActive: () => true };
    const original = await new TerminalImageStore(options).save(payload("a"));
    const ownerPath = join(dirname(original), "terminal.json");
    await writeFile(ownerPath, "{");
    const failure = Object.assign(new Error("rename failed"), { code: "EIO" });
    vi.spyOn(fs, "rename").mockRejectedValueOnce(failure);
    await expect(new TerminalImageStore(options).save(payload("a"))).rejects.toBe(failure);
    expect(await readFile(ownerPath, "utf8")).toBe("{");
    expect(await readFile(original)).toEqual(PNG);
    expect((await readdir(dirname(original))).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    await new TerminalImageStore(options).save(payload("a"));
    expect(JSON.parse(await readFile(ownerPath, "utf8"))).toEqual({ terminalId: "a" });
  });

  test("real metadata read errors remain visible", async () => {
    const directory = join(await root(), "images");
    const store = new TerminalImageStore({ directory, isActive: () => true });
    await store.save(payload("a"));
    const failure = Object.assign(new Error("permission denied"), { code: "EACCES" });
    vi.spyOn(fs, "readFile").mockRejectedValueOnce(failure);
    await expect(store.save(payload("b"))).rejects.toBe(failure);
  });

  test("rejects closed terminals and invalid/oversized images", async () => {
    const directory = join(await root(), "images");
    const store = new TerminalImageStore({ directory, isActive: () => false });
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
        new TerminalImageStore({ directory, isActive: () => true }).save(payload("a")),
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
