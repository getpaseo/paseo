import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, test, vi } from "vitest";
import { ConversationImageStore } from "./conversation-images.js";
import type { TimelineImage } from "@getpaseo/protocol/timeline-image";

vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return { ...fs, writeFile: vi.fn(fs.writeFile), rename: vi.fn(fs.rename) };
});

const homes: string[] = [];
async function home(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-image-bindings-"));
  homes.push(directory);
  return directory;
}
const images: TimelineImage[] = [
  { kind: "stored", id: "a".repeat(64), mimeType: "image/png", byteSize: 3 },
  { kind: "unavailable", mimeType: "image/jpeg" },
];
async function resolve(store: ConversationImageStore, id: string) {
  return store.normalize("agent", { type: "user_message", text: "", messageId: id });
}
afterEach(async () => {
  vi.restoreAllMocks();
  vi.mocked(writeFile).mockClear();
  vi.mocked(rename).mockClear();
  await Promise.all(
    homes.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

test("binding history writes only the new aliases and survives restart", async () => {
  const directory = await home();
  const store = new ConversationImageStore(directory);
  const count = 64;
  for (let index = 0; index < count; index++) {
    await store.bind("agent", [`native-${index}`, `client-${index}`], images);
  }
  const writes = vi.mocked(writeFile).mock.calls;
  expect(writes).toHaveLength(count);
  const sizes = writes.map(([, bytes]) => Buffer.byteLength(String(bytes)));
  // A fixed-size message must not rewrite all previous messages' bindings.
  expect(Math.max(...sizes)).toBeLessThan(512);
  expect(sizes.reduce((total, size) => total + size, 0)).toBeLessThan(count * 512);
  const reopened = new ConversationImageStore(directory);
  for (const id of ["native-0", "client-0", "native-63", "client-63"]) {
    expect((await resolve(reopened, id)).images).toEqual(images);
  }
  expect(vi.mocked(writeFile).mock.calls).toHaveLength(count);
  expect((await resolve(reopened, "not-in-this-timeline")).images).toBeUndefined();
});

test("concurrent aliases are ordered, duplicate binds do not write, and failures do not publish", async () => {
  const directory = await home();
  const store = new ConversationImageStore(directory);
  const replacement: TimelineImage[] = [
    { kind: "stored", id: "b".repeat(64), mimeType: "image/png", byteSize: 4 },
  ];
  await Promise.all([
    store.bind("agent", ["native", "client", "native"], images),
    store.bind("agent", ["native", "client"], replacement),
    store.bind("agent", ["other"], images),
  ]);
  await store.bind("agent", ["native", "client"], replacement);
  expect(vi.mocked(writeFile).mock.calls).toHaveLength(3);
  vi.mocked(rename).mockRejectedValueOnce(new Error("disk failure"));
  await expect(store.bind("agent", ["native", "client"], images)).rejects.toThrow("disk failure");
  expect((await resolve(store, "native")).images).toEqual(replacement);
  const reopened = new ConversationImageStore(directory);
  expect((await resolve(reopened, "client")).images).toEqual(replacement);
  expect((await resolve(reopened, "other")).images).toEqual(images);
  await store.bind("agent", ["native", "client"], images);
  expect((await resolve(new ConversationImageStore(directory), "client")).images).toEqual(images);
  async function checkModes(target: string): Promise<void> {
    const info = await stat(target);
    expect(info.mode & 0o777).toBe(info.isDirectory() ? 0o700 : 0o600);
    if (info.isDirectory()) {
      for (const filename of await readdir(target)) {
        expect(filename.endsWith(".tmp")).toBe(false);
        await checkModes(path.join(target, filename));
      }
    }
  }
  await checkModes(path.join(directory, "conversation-images"));
});

test("reads existing manifests without rewriting earlier bindings", async () => {
  const directory = await home();
  const agents = path.join(directory, "conversation-images", "agents");
  await mkdir(agents, { recursive: true });
  const manifest = path.join(agents, `${createHash("sha256").update("agent").digest("hex")}.json`);
  const seed = JSON.stringify({ old: images });
  await writeFile(manifest, seed);
  const store = new ConversationImageStore(directory);
  expect((await resolve(store, "old")).images).toEqual(images);
  await store.bind("agent", ["new"], images);
  const reopened = new ConversationImageStore(directory);
  expect((await resolve(reopened, "old")).images).toEqual(images);
  expect((await resolve(reopened, "new")).images).toEqual(images);
  expect(await readFile(manifest, "utf8")).toBe(seed);
});

test("native normalization keeps ordered images across restart and ignores incomplete records", async () => {
  const directory = await home();
  const store = new ConversationImageStore(directory);
  const item = {
    type: "user_message" as const,
    text: "images",
    messageId: "native",
    imageSources: [
      {
        kind: "base64" as const,
        data: Buffer.from("first").toString("base64"),
        mimeType: "image/png",
      },
      { kind: "unavailable" as const, mimeType: "image/jpeg" },
      {
        kind: "base64" as const,
        data: Buffer.from("last").toString("base64"),
        mimeType: "image/webp",
      },
    ],
  };
  const normalized = await store.normalize("agent", item);
  expect(normalized).not.toHaveProperty("imageSources");
  expect(normalized.images?.map((image) => image.mimeType)).toEqual([
    "image/png",
    "image/jpeg",
    "image/webp",
  ]);
  await store.bind("agent", ["native", "client"], normalized.images ?? []);
  const records = path.join(
    directory,
    "conversation-images",
    "agents",
    createHash("sha256").update("agent").digest("hex"),
  );
  await writeFile(path.join(records, "99.json.unfinished.tmp"), "incomplete");
  const reopened = new ConversationImageStore(directory);
  expect((await resolve(reopened, "client")).images).toEqual(normalized.images);
  expect((await resolve(reopened, "native")).images).toEqual(normalized.images);
});

test("replays binding replacements numerically, including records after the tenth write", async () => {
  const directory = await home();
  const store = new ConversationImageStore(directory);
  for (let index = 0; index < 14; index++) {
    await store.bind(
      "agent",
      ["native", "client"],
      [{ kind: "stored", id: "a".repeat(64), mimeType: "image/png", byteSize: index + 1 }],
    );
  }
  expect((await resolve(new ConversationImageStore(directory), "client")).images).toEqual([
    { kind: "stored", id: "a".repeat(64), mimeType: "image/png", byteSize: 14 },
  ]);
});
