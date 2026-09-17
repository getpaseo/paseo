import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { createPaseoApi } from "@getpaseo/client";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";

test("an RPC-only plugin receives no agent, project or provider data", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-quiet-plugin-"));
  await writeFile(path.join(directory, "paseo-plugin.json"), JSON.stringify({ id: "quiet" }));
  await writeFile(
    path.join(directory, "index.server.ts"),
    `
import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
export default function contribute(server) {
  const counts = {};
  const observe = message => {
    if (message.type !== "paseo_frame" || typeof message.data !== "string") return;
    const frame = JSON.parse(message.data);
    const type = frame.message?.type;
    if (type) counts[type] = (counts[type] ?? 0) + 1;
  };
  process.on("message", observe);
  server.handle(defineRpc({name:"counts", input:z.object({}), output:z.record(z.string(),z.number())}), () => counts);
  return () => process.off("message", observe);
}`,
  );
  const daemon = await createTestPaseoDaemon();
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  const idle = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  const legacy = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    capabilities: {
      selective_agent_timeline: false,
      explicit_event_subscriptions: false,
      provider_snapshot_references: false,
    },
  });
  const legacyTypes: string[] = [];
  legacy.subscribeRawMessages((message) => legacyTypes.push(message.type));
  const idleTypes: string[] = [];
  idle.subscribeRawMessages((message) => idleTypes.push(message.type));
  try {
    await client.connect();
    await idle.connect();
    await legacy.connect();
    await client.patchDaemonConfig({ pluginsEnabled: true });
    await client.installDirectoryPlugin(directory);
    const agent = await client.createAgent({ provider: "claude", cwd: directory });
    const api = createPaseoApi(client);
    const received: string[] = [];
    const release = api.agents
      .ref(agent.id)
      .timeline.subscribe((event) => received.push(event.event.type));
    await release.ready;
    await daemon.daemon.agentManager.emitLiveTimelineItem(agent.id, {
      type: "assistant_message",
      id: "row",
      text: "only the subscriber sees this",
    });
    await expect.poll(() => received).toEqual(["timeline"]);
    await client.sendMessage(agent.id, "Say hello");
    await client.waitForFinish(agent.id);
    await client.refreshProvidersSnapshot({ cwd: directory });
    const counts = await client.invokePluginRpc("quiet", "counts", {});
    expect(counts).toEqual({ status: 1 });
    await legacy.getDaemonConfig();
    expect(legacyTypes).toEqual(
      expect.arrayContaining(["project.update", "providers_snapshot_update", "agent_stream"]),
    );
    expect(idleTypes.filter((type) => type !== "status")).toEqual([]);
    const deliveredBeforeRelease = received.length;
    release();
    await client.getDaemonConfig();
    await daemon.daemon.agentManager.emitLiveTimelineItem(agent.id, {
      type: "assistant_message",
      id: "row-2",
      text: "unsubscribed",
    });
    await client.getDaemonConfig();
    expect(received).toHaveLength(deliveredBeforeRelease);
  } finally {
    await legacy.close();
    await idle.close();
    await client.close();
    await daemon.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);
