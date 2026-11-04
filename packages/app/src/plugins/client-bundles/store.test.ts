import { createHash } from "node:crypto";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { expect, test } from "vitest";
import { createPluginClientBundleStore, type PluginBundleFiles } from "./store";

const sha256 = async (contents: string) => createHash("sha256").update(contents).digest("hex");

class BundleFiles implements PluginBundleFiles {
  readonly contents = new Map<string, string>();
  readonly writes: string[] = [];
  async list() {
    return [...this.contents.keys()];
  }
  async read(name: string) {
    const contents = this.contents.get(name);
    if (contents === undefined) throw new Error("File disappeared");
    return contents;
  }
  async writeAtomic(name: string, contents: string) {
    this.writes.push(name);
    this.contents.set(name, contents);
  }
  async remove(name: string) {
    this.contents.delete(name);
  }
}

async function bundle(id: string, clientBundle: string) {
  return { id, clientBundle, clientBundleHash: await sha256(clientBundle) };
}

test("a cold store loads verified bundles and prunes versions missing from the latest catalog", async () => {
  const files = new BundleFiles();
  const old = await bundle("changed", "old");
  const kept = await bundle("kept", "Unicode: 折叠屏 🐚");
  await createPluginClientBundleStore(files, sha256).replace([old, kept]);
  const cold = createPluginClientBundleStore(files, sha256);
  expect(await cold.load()).toEqual([old, kept]);
  const changed = await bundle("changed", "new");
  await cold.replace([kept, changed]);
  expect(files.contents.size).toBe(2);
  expect(await createPluginClientBundleStore(files, sha256).load()).toEqual([kept, changed]);
  expect(files.writes).toHaveLength(3);
  await cold.replace([]);
  expect(files.contents.size).toBe(0);
});

test("same-length corruption, truncated files and unreadable files are not advertised", async () => {
  const files = new BundleFiles();
  const entries = await Promise.all([
    bundle("same-length", "good"),
    bundle("truncated", "long"),
    bundle("missing", "lost"),
  ]);
  await createPluginClientBundleStore(files, sha256).replace(entries);
  const names = [...files.contents.keys()];
  files.contents.set(names[0]!, "evil");
  files.contents.set(names[1]!, "lo");
  // The directory entry still exists while reading the file fails.
  const unreadable: PluginBundleFiles = {
    list: () => files.list(),
    read: (name) =>
      name === names[2] ? Promise.reject(new Error("Unreadable")) : files.read(name),
    writeAtomic: (name, contents) => files.writeAtomic(name, contents),
    remove: (name) => files.remove(name),
  };
  const cold = createPluginClientBundleStore(unreadable, sha256);
  expect(await cold.load()).toEqual([]);
  await cold.replace(entries);
  expect(await createPluginClientBundleStore(files, sha256).load()).toEqual(entries);
});

test("an interrupted atomic write leaves the prior catalog available for a cold reader", async () => {
  const files = new BundleFiles();
  const previous = await bundle("plugin", "previous");
  await createPluginClientBundleStore(files, sha256).replace([previous]);
  const failing: PluginBundleFiles = {
    list: () => files.list(),
    read: (name) => files.read(name),
    remove: (name) => files.remove(name),
    writeAtomic: async () => {
      throw new Error("Disk full");
    },
  };
  await expect(
    createPluginClientBundleStore(failing, sha256).replace([await bundle("plugin", "next")]),
  ).rejects.toThrow("Disk full");
  expect(await createPluginClientBundleStore(files, sha256).load()).toEqual([previous]);
});

// Exercise the app store through a fresh platform-agnostic client, using its transport port.
test.each(["valid", "corrupt", "missing"])(
  "cold catalog uses a %s persisted bundle correctly",
  async (state) => {
    const files = new BundleFiles();
    const entry = await bundle("plugin", "good code");
    await createPluginClientBundleStore(files, sha256).replace([entry]);
    if (state === "corrupt") files.contents.set([...files.contents.keys()][0]!, "evil code");
    if (state === "missing") files.contents.clear();
    let open = () => {};
    let receive: (data: unknown, binary: boolean) => void = () => {};
    const requests: Record<string, unknown>[] = [];
    const client = new DaemonClient({
      url: "ws://test",
      clientId: "plugin-cache-test",
      reconnect: { enabled: false },
      createPluginClientBundleStore: () => createPluginClientBundleStore(files, sha256),
      transportFactory: () => ({
        send(data) {
          if (typeof data !== "string") return;
          const frame = JSON.parse(data);
          if (frame.type !== "session") return;
          const request = frame.message;
          if (request.type !== "plugin.catalog.get.request") return;
          requests.push(request);
          const { clientBundle: _code, ...reference } = entry;
          receive(
            JSON.stringify({
              type: "session",
              message: {
                type: "plugin.catalog.get.response",
                payload: {
                  requestId: request.requestId,
                  plugins: [request.cachedClientBundles ? reference : entry],
                },
              },
            }),
            false,
          );
        },
        close() {},
        onOpen(handler) {
          open = handler;
          return () => {};
        },
        onMessage(handler) {
          receive = handler;
          return () => {};
        },
        onClose() {
          return () => {};
        },
        onError() {
          return () => {};
        },
      }),
    });
    try {
      const connecting = client.connect();
      open();
      receive(
        JSON.stringify({
          type: "session",
          message: {
            type: "status",
            payload: {
              status: "server_info",
              serverId: "cache-host",
              hostname: null,
              version: null,
              features: { plugins: true },
            },
          },
        }),
        false,
      );
      await connecting;
      expect(await client.getPluginCatalog()).toEqual([entry]);
      if (state === "valid")
        expect(requests[0]?.cachedClientBundles).toEqual([
          { id: entry.id, clientBundleHash: entry.clientBundleHash },
        ]);
      else expect(requests[0]).not.toHaveProperty("cachedClientBundles");
      await expect.poll(() => createPluginClientBundleStore(files, sha256).load()).toEqual([entry]);
    } finally {
      await client.close();
    }
  },
);
