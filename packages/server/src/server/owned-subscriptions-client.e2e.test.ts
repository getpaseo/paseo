import { WebSocket } from "ws";
import {
  DaemonClient as PublicDaemonClient,
  type WebSocketLike,
} from "@getpaseo/client/internal/daemon-client";
import { expect, test } from "vitest";
import { createPaseoApi } from "@getpaseo/client";
import { DaemonClient } from "./test-utils/daemon-client.js";
import { createTestPaseoDaemon } from "./test-utils/paseo-daemon.js";

test("two SDK facades own combined agent lists and disposal preserves the other facade", async () => {
  const daemon = await createTestPaseoDaemon({ mcpEnabled: false });
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.8.0",
    capabilities: { owned_subscriptions: true },
  });
  const admin = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws`, appVersion: "0.8.0" });
  const app = createPaseoApi(client);
  const plugin = createPaseoApi(client);
  try {
    await admin.connect();
    await client.connect();
    const agent = await admin.createAgent({
      provider: "codex",
      cwd: daemon.staticDir,
      title: "Before",
    });
    const appUpdates: unknown[] = [];
    const pluginUpdates: unknown[] = [];
    app.agents.subscribe((update) => appUpdates.push(update));
    plugin.agents.subscribe((update) => pluginUpdates.push(update));
    const broad = await app.agents.list({ scope: "active", subscribe: {} });
    const filtered = await plugin.agents.list({
      scope: "active",
      filter: { labels: { role: "orchestrator" } },
      page: { limit: 100 },
      subscribe: {},
    });
    expect(broad.subscriptionId).toEqual(expect.any(String));
    expect(filtered.subscriptionId).toEqual(expect.any(String));
    expect(broad.subscriptionId).not.toBe(filtered.subscriptionId);
    expect(filtered.entries).toEqual([]);
    await admin.updateAgent(agent.id, { name: "After" });
    await expect
      .poll(() => appUpdates)
      .toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "upsert",
            subscriptionId: broad.subscriptionId,
            agent: expect.objectContaining({ id: agent.id, title: "After" }),
          }),
        ]),
      );
    expect(appUpdates).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "remove" })]),
    );
    expect(pluginUpdates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "remove",
          subscriptionId: filtered.subscriptionId,
          agentId: agent.id,
        }),
      ]),
    );
    await plugin.dispose();
    const before = pluginUpdates.length;
    await admin.updateAgent(agent.id, { name: "Still observed" });
    await expect
      .poll(() => appUpdates)
      .toEqual(
        expect.arrayContaining([
          expect.objectContaining({ agent: expect.objectContaining({ title: "Still observed" }) }),
        ]),
      );
    expect(pluginUpdates).toHaveLength(before);
  } finally {
    await client.close();
    await admin.close();
    await daemon.close();
  }
});

test("public SDK scope cancellation during bootstrap releases the returned ID", async () => {
  const daemon = await createTestPaseoDaemon({ mcpEnabled: false });
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  const lifetime = new AbortController();
  const api = createPaseoApi(client, { signal: lifetime.signal });
  try {
    await client.connect();
    const listing = api.agents.list({ subscribe: {} });
    lifetime.abort();
    await expect(listing).rejects.toThrow("released");
    await api.dispose();
    const { diagnostic } = await client.collectDiagnostics();
    expect(diagnostic).toContain("Source registrations: 0");
    expect(diagnostic).toContain("Producer listeners: 0");
    await expect(api.agents.list({ subscribe: {} })).rejects.toThrow("disposed");
  } finally {
    await client.close();
    await daemon.close();
  }
});

test("a restored public SDK timeline leaves missed history to the consumer", async () => {
  const daemon = await createTestPaseoDaemon({ mcpEnabled: false });
  const sockets: WebSocket[] = [];
  const makeClient = (observer: boolean) =>
    new PublicDaemonClient({
      url: `ws://127.0.0.1:${daemon.port}/ws`,
      clientId: observer ? "timeline-observer" : "timeline-actor",
      appVersion: "0.8.0",
      reconnect: { enabled: false },
      webSocketFactory: (url) => {
        const socket = new WebSocket(url);
        if (observer) {
          sockets.push(socket);
        }
        return socket as unknown as WebSocketLike;
      },
    });
  const observer = makeClient(true);
  const actor = makeClient(false);
  const api = createPaseoApi(observer);
  const received: unknown[] = [];
  try {
    await actor.connect();
    await observer.connect();
    const agent = await actor.createAgent({
      provider: "codex",
      cwd: daemon.staticDir,
      title: "Reconnect review",
    });
    const handle = api.agents.ref(agent.id);
    const subscription = handle.timeline.subscribe((event) => received.push(event));
    await subscription.ready;
    await actor.sendMessage(agent.id, "before-outage");
    await actor.waitForFinish(agent.id);
    await expect.poll(() => JSON.stringify(received)).toContain("before-outage");
    const cached = await handle.timeline.refetch();
    expect(cached.endCursor).not.toBeNull();
    const oldId = subscription.subscriptionId;
    sockets[0]!.terminate();
    await expect.poll(() => observer.getConnectionState().status).not.toBe("connected");
    await actor.sendMessage(agent.id, "during-outage");
    await actor.waitForFinish(agent.id);
    await observer.connect();
    await expect
      .poll(() => subscription.subscriptionId)
      .toSatisfy((id: unknown) => typeof id === "string" && id !== oldId);
    await expect.poll(() => JSON.stringify(received)).toContain("subscription_restored");
    expect(JSON.stringify(received)).not.toContain("during-outage");
    await actor.sendMessage(agent.id, "after-outage");
    await actor.waitForFinish(agent.id);
    await expect.poll(() => JSON.stringify(received)).toContain("after-outage");
    const history = await handle.timeline.refetch({
      direction: "after",
      cursor: cached.endCursor!,
      projection: "projected",
    });
    expect(JSON.stringify(history)).toContain("during-outage");
    expect(JSON.stringify(received)).not.toContain("during-outage");
  } finally {
    await api.dispose();
    await observer.close();
    await actor.close();
    await daemon.close();
  }
});
