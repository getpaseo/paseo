import { afterEach, describe, expect, test } from "vitest";
import { mkdtemp, readFile, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TerminalImageStore, terminalImageReference } from "./host-clipboard.js";

const roots: string[] = [];
const PNG = Buffer.from("89504e470d0a1a0a", "hex");
const payload = (terminalId: string, suffix = "") => ({
  terminalId,
  mimeType: "image/png" as const,
  dataBase64: Buffer.concat([PNG, Buffer.from(suffix)]).toString("base64"),
});
afterEach(async () => {
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
