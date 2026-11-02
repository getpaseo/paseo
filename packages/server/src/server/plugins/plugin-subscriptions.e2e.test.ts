import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import {
  DaemonClient,
  type OwnedSubscription,
  type WebSocketLike,
} from "@getpaseo/client/internal/daemon-client";
import { afterEach, expect, test } from "vitest";
import { defineRpc } from "@getpaseo/plugin";
import { callPluginRpc } from "@getpaseo/plugin/client/host";
import { z } from "zod";
import { resolveDaemonVersion } from "../daemon-version.js";
import { createTestPaseoDaemon, type TestPaseoDaemon } from "../test-utils/paseo-daemon.js";

const PLUGIN_ID = "subscriptions";

// Written as an author writes a plugin: one contract per name, handlers that read like English.
const SERVER_ENTRY = `
import { defineRpc, defineSubscription } from "@getpaseo/plugin";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { z } from "zod";

const ticks = defineSubscription({
  name: "ticks",
  input: z.object({ count: z.number().int(), bytes: z.boolean() }),
  event: z.union([z.instanceof(Uint8Array), z.object({ n: z.number() })]),
});
const failing = defineSubscription({
  name: "failing",
  input: z.object({ when: z.enum(["before-ack", "after-ack"]) }),
  event: z.object({}),
});
const nestedPush = defineSubscription({
  name: "nested-push",
  input: z.object({}),
  event: z.object({ data: z.instanceof(Uint8Array) }),
});
const repeated = defineSubscription({
  name: "repeated",
  input: z.object({ times: z.string().transform(Number) }),
  event: z.string().transform((text) => text.length),
});
const transformed = defineRpc({
  name: "transformed",
  input: z.object({ when: z.string().transform(async (text) => new Date(text)) }),
  output: z.object({ n: z.string().transform(async (text) => Number(text)) }),
});
const defaulted = defineRpc({ name: "defaulted", input: z.string().default("x"), output: z.string() });
const defaultedOutput = defineRpc({ name: "defaulted-output", input: z.object({}), output: z.string().default("x") });
const watchers = defineRpc({
  name: "watchers",
  input: z.object({}),
  output: z.object({ starts: z.number(), active: z.number() }),
});
const thumbnail = defineRpc({
  name: "thumbnail",
  input: z.object({ size: z.number().int() }),
  output: z.instanceof(Uint8Array),
});
const nestedOutput = defineRpc({
  name: "nested-output",
  input: z.object({}),
  output: z.object({ data: z.instanceof(Uint8Array) }),
});
const reverse = defineRpc({
  name: "reverse",
  input: z.instanceof(Uint8Array),
  output: z.instanceof(Uint8Array),
});

export default function contribute(server: PluginServerContext) {
  let starts = 0;
  let active = 0;
  server.handle(ticks, ({ count, bytes }, { push, signal }) => {
    starts += 1;
    active += 1;
    signal.addEventListener("abort", () => { active -= 1; }, { once: true });
    for (let n = 0; n < count; n += 1) void push(bytes ? new Uint8Array([n, n + 1]) : { n });
  });
  server.handle(failing, ({ when }) => {
    if (when === "before-ack") throw new Error("refused before acknowledging");
    return Promise.reject(new Error("failed after acknowledging"));
  });
  server.handle(nestedPush, (_input, { push }) => {
    void push({ data: new Uint8Array(1) }).catch((error) => {
      console.error("nested push", error.message);
    });
  });
  server.handle(repeated, async ({ times }, { push }) => {
    await push(typeof times === "number" ? "x".repeat(times) : "input arrived untransformed");
  });
  server.handle(transformed, ({ when }) => ({ n: String(when.getUTCFullYear()) }));
  server.handle(defaulted, (input) => input);
  server.handle(defaultedOutput, () => undefined);
  server.handle(watchers, () => ({ starts, active }));
  server.handle(thumbnail, ({ size }) => Buffer.alloc(size, 7));
  server.handle(nestedOutput, () => ({ data: new Uint8Array(1) }));
  server.handle(reverse, (bytes) => Uint8Array.from(bytes).reverse());
  return () => undefined;
}
`;

type Received =
  | { type: "event"; event: unknown }
  | { type: "bytes"; bytes: number[] }
  | { type: "closed"; error?: string };

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

interface Harness {
  daemon: TestPaseoDaemon;
  client: DaemonClient;
  sockets: WebSocket[];
  close(): Promise<void>;
}

async function writePlugin(id: string, serverEntry: string): Promise<string> {
  const pluginDirectory = await mkdtemp(path.join(tmpdir(), "paseo-plugin-subscriptions-"));
  roots.push(pluginDirectory);
  await writeFile(
    path.join(pluginDirectory, "paseo-plugin.json"),
    JSON.stringify({ id, requirements: { paseo: `>=${resolveDaemonVersion(import.meta.url)}` } }),
  );
  await writeFile(path.join(pluginDirectory, "index.server.ts"), serverEntry);
  return pluginDirectory;
}

async function startHarness(): Promise<Harness> {
  const pluginDirectory = await writePlugin(PLUGIN_ID, SERVER_ENTRY);
  const daemon = await createTestPaseoDaemon({ mcpEnabled: false });
  const sockets: WebSocket[] = [];
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    clientId: `clid_plugin_subscriptions_${Date.now()}`,
    appVersion: resolveDaemonVersion(import.meta.url),
    reconnect: { enabled: true, baseDelayMs: 10, maxDelayMs: 50 },
    webSocketFactory: (url) => {
      const socket = new WebSocket(url);
      sockets.push(socket);
      return socket as unknown as WebSocketLike;
    },
  });
  await client.connect();
  await client.patchDaemonConfig({ pluginsEnabled: true });
  await expect(client.installDirectoryPlugin(pluginDirectory)).resolves.toMatchObject({
    id: PLUGIN_ID,
    status: "running",
  });
  return {
    daemon,
    client,
    sockets,
    async close() {
      await client.close().catch(() => undefined);
      await daemon.close();
    },
  };
}

function collect(subscription: OwnedSubscription<unknown>): Received[] {
  const received: Received[] = [];
  subscription.subscribe({
    snapshot: () => undefined,
    update: (message) => {
      if (message.type === "plugin.rpc.event")
        received.push({ type: "event", event: message.payload.event });
      if (message.type === "plugin.rpc.closed")
        received.push({
          type: "closed",
          ...(message.payload.error ? { error: message.payload.error } : {}),
        });
    },
    binary: (payload) => received.push({ type: "bytes", bytes: [...payload] }),
  });
  return received;
}

function watcherCount(client: DaemonClient) {
  return client.invokePluginRpc(PLUGIN_ID, "watchers", {});
}

test("a subscription delivers JSON and binary events in order and release aborts its handler", async () => {
  const harness = await startHarness();
  const { client } = harness;
  try {
    const json = client.observePluginRpc(PLUGIN_ID, "ticks", { count: 3, bytes: false });
    const jsonEvents = collect(json);
    await json.ready;
    const binary = client.observePluginRpc(PLUGIN_ID, "ticks", { count: 2, bytes: true });
    const binaryEvents = collect(binary);
    await binary.ready;

    await expect
      .poll(() => jsonEvents)
      .toEqual([
        { type: "event", event: { n: 0 } },
        { type: "event", event: { n: 1 } },
        { type: "event", event: { n: 2 } },
      ]);
    await expect
      .poll(() => binaryEvents)
      .toEqual([
        { type: "bytes", bytes: [0, 1] },
        { type: "bytes", bytes: [1, 2] },
      ]);
    expect(json.subscriptionId).not.toBe(binary.subscriptionId);
    await expect(watcherCount(client)).resolves.toEqual({ starts: 2, active: 2 });

    await json.release();
    await expect(watcherCount(client)).resolves.toEqual({ starts: 2, active: 1 });
    await binary.release();
    await expect(watcherCount(client)).resolves.toEqual({ starts: 2, active: 0 });
  } finally {
    await harness.close();
  }
}, 60_000);

test("a schema transform runs once: the handler gets the parsed input and the wire carries the pushed event", async () => {
  const harness = await startHarness();
  try {
    const subscription = harness.client.observePluginRpc(PLUGIN_ID, "repeated", { times: "2" });
    const received = collect(subscription);
    await subscription.ready;
    // The client parses "xx" into 2; parsing it on the plugin side too would reject it.
    await expect.poll(() => received).toEqual([{ type: "event", event: "xx" }, { type: "closed" }]);
  } finally {
    await harness.close();
  }
}, 60_000);

test("dropping the connection releases subscriptions and reconnecting runs the handler again", async () => {
  const harness = await startHarness();
  const { client, sockets } = harness;
  try {
    const subscription = client.observePluginRpc(PLUGIN_ID, "ticks", { count: 1, bytes: false });
    const events = collect(subscription);
    await subscription.ready;
    await expect.poll(() => events).toEqual([{ type: "event", event: { n: 0 } }]);
    const firstId = subscription.subscriptionId;

    sockets.at(-1)!.terminate();
    await expect
      .poll(() => subscription.subscriptionId, { timeout: 10_000 })
      .toSatisfy((id: unknown) => typeof id === "string" && id !== firstId);
    await expect
      .poll(() => events)
      .toEqual([
        { type: "event", event: { n: 0 } },
        { type: "event", event: { n: 0 } },
      ]);
    // The first handler's signal aborted when its connection dropped; one handler runs now.
    await expect(watcherCount(client)).resolves.toEqual({ starts: 2, active: 1 });
    await subscription.release();
  } finally {
    await harness.close();
  }
}, 60_000);

test("a handler that throws before acknowledging rejects; one that fails later closes", async () => {
  const harness = await startHarness();
  const { client } = harness;
  try {
    const refused = client.observePluginRpc(PLUGIN_ID, "failing", { when: "before-ack" });
    await expect(refused.ready).rejects.toThrow("refused before acknowledging");

    const later = client.observePluginRpc(PLUGIN_ID, "failing", { when: "after-ack" });
    const events = collect(later);
    await later.ready;
    await expect
      .poll(() => events)
      .toEqual([{ type: "closed", error: "failed after acknowledging" }]);
    await later.release();

    const invalid = client.observePluginRpc(PLUGIN_ID, "ticks", { count: "many" });
    await expect(invalid.ready).rejects.toThrow();
    const unknown = client.observePluginRpc(PLUGIN_ID, "watchers", {});
    await expect(unknown.ready).rejects.toThrow("does not contribute subscription watchers");
  } finally {
    await harness.close();
  }
}, 60_000);

test("reloading the plugin closes its subscriptions with an error", async () => {
  const harness = await startHarness();
  const { client } = harness;
  try {
    const subscription = client.observePluginRpc(PLUGIN_ID, "ticks", { count: 0, bytes: false });
    const events = collect(subscription);
    await subscription.ready;
    await client.reloadPlugin(PLUGIN_ID);
    await expect
      .poll(() => events)
      .toEqual([{ type: "closed", error: `Plugin stopped: ${PLUGIN_ID}` }]);
    await subscription.release();
    // The reloaded plugin starts fresh and serves new subscriptions.
    const again = client.observePluginRpc(PLUGIN_ID, "ticks", { count: 1, bytes: false });
    const againEvents = collect(again);
    await again.ready;
    await expect.poll(() => againEvents).toEqual([{ type: "event", event: { n: 0 } }]);
    await again.release();
  } finally {
    await harness.close();
  }
}, 60_000);

test("RPC bytes ride as binary frames in both directions and nested bytes fail validation", async () => {
  const harness = await startHarness();
  const { client } = harness;
  try {
    const output = await client.invokePluginRpc(PLUGIN_ID, "thumbnail", { size: 4 });
    expect(output).toBeInstanceOf(Uint8Array);
    expect([...(output as Uint8Array)]).toEqual([7, 7, 7, 7]);

    const reversed = await client.invokePluginRpc(PLUGIN_ID, "reverse", new Uint8Array([1, 2, 3]));
    expect([...(reversed as Uint8Array)]).toEqual([3, 2, 1]);

    await expect(client.invokePluginRpc(PLUGIN_ID, "nested-output", {})).rejects.toThrow(
      "output.data is a Uint8Array. Bytes cross the wire only as the whole value",
    );
    await expect(
      client.invokePluginRpc(PLUGIN_ID, "reverse", { data: new Uint8Array(1) }),
    ).rejects.toThrow("input.data is a Uint8Array");

    const nested = client.observePluginRpc(PLUGIN_ID, "nested-push", {});
    await nested.ready;
    await expect
      .poll(async () => JSON.stringify(await client.getPluginLogs(PLUGIN_ID)))
      .toContain("event.data is a Uint8Array");
    await nested.release();
  } finally {
    await harness.close();
  }
}, 60_000);

test("one name cannot serve both an RPC and a subscription", async () => {
  const harness = await startHarness();
  try {
    const directory = await writePlugin(
      "collision",
      `
import { defineRpc, defineSubscription } from "@getpaseo/plugin";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { z } from "zod";

export default function contribute(server: PluginServerContext) {
  server.handle(defineRpc({ name: "watch", input: z.object({}), output: z.null() }), () => null);
  server.handle(
    defineSubscription({ name: "watch", input: z.object({}), event: z.object({}) }),
    () => undefined,
  );
  return () => undefined;
}
`,
    );
    await expect(harness.client.installDirectoryPlugin(directory)).rejects.toThrow(
      "Duplicate plugin RPC method: watch",
    );
  } finally {
    await harness.close();
  }
}, 60_000);

test("plain RPC parses async input and output transforms once at the receiver", async () => {
  const transformed = defineRpc({
    name: "transformed",
    input: z.object({ when: z.string().transform(async (text) => new Date(text)) }),
    output: z.object({ n: z.string().transform(async (text) => Number(text)) }),
  });

  const harness = await startHarness();
  try {
    await expect(
      callPluginRpc(
        transformed,
        (method, input) => harness.client.invokePluginRpc(PLUGIN_ID, method, input),
        { when: "2026-01-01T00:00:00.000Z" },
      ),
    ).resolves.toEqual({ n: 2026 });
  } finally {
    await harness.close();
  }
});

test("plain RPC applies a top-level input default in the plugin process", async () => {
  const contract = defineRpc({
    name: "defaulted",
    input: z.string().default("x"),
    output: z.string(),
  });
  const harness = await startHarness();
  try {
    await expect(
      callPluginRpc(
        contract,
        (method, input) => harness.client.invokePluginRpc(PLUGIN_ID, method, input),
        undefined,
      ),
    ).resolves.toBe("x");
  } finally {
    await harness.close();
  }
});

test("plain RPC applies a top-level output default on the client", async () => {
  const contract = defineRpc({
    name: "defaulted-output",
    input: z.object({}),
    output: z.string().default("x"),
  });
  const harness = await startHarness();
  try {
    await expect(
      callPluginRpc(
        contract,
        (method, input) => harness.client.invokePluginRpc(PLUGIN_ID, method, input),
        {},
      ),
    ).resolves.toBe("x");
  } finally {
    await harness.close();
  }
}, 30_000);
