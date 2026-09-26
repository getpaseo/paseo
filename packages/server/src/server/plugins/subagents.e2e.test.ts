import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { createTestAgentClient } from "../test-utils/fake-agent-client.js";

const source = `
import { defineRpc } from "@getpaseo/plugin";
import { PluginSubagentEventSchema, PLUGIN_SUBAGENT_MAX_EVENT_BYTES } from "@getpaseo/plugin/server";
import { z } from "zod";
export default function contribute(server) {
  let reporter;
  server.handle(defineRpc({ name: "contract", input: z.null(), output: z.object({ limit: z.number(), acceptsDescriptor: z.boolean(), acceptsInvalidStatus: z.boolean() }) }), () => ({
    limit: PLUGIN_SUBAGENT_MAX_EVENT_BYTES,
    acceptsDescriptor: PluginSubagentEventSchema.safeParse({ type: "upsert", id: "child", status: "running" }).success,
    acceptsInvalidStatus: PluginSubagentEventSchema.safeParse({ type: "upsert", id: "child", status: "invalid" }).success,
  }));
  server.handle(defineRpc({ name: "report", input: z.object({ parentAgentId: z.string() }), output: z.null() }), async ({ parentAgentId }) => {
    reporter = await server.subagents.open({ parentAgentId });
    await reporter.report({ type: "upsert", id: "child", title: "External worker", status: "running" });
    await reporter.report({ type: "timeline", id: "child", item: { type: "assistant_message", text: "External output" } });
    return null;
  });
  server.handle(defineRpc({ name: "late", input: z.null(), output: z.null() }), async () => {
    await reporter.report({ type: "upsert", id: "late" });
    return null;
  });
  server.handle(defineRpc({ name: "close", input: z.null(), output: z.null() }), async () => {
    await reporter.close();
    await reporter.close();
    return null;
  });
  server.handle(defineRpc({ name: "crash", input: z.null(), output: z.null() }), async () => {
    process.exit(17);
  });
  return () => {};
}
`;

test("real plugin IPC publishes beneath an existing Pi parent and cleans each process source", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-subagent-ipc-"));
  const daemon = await createTestPaseoDaemon({
    daemonVersion: "0.8.0",
    agentClients: { pi: createTestAgentClient("pi") },
  });
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws`, appVersion: "0.8.0" });
  const observer = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.8.0",
  });
  try {
    await writeFile(
      path.join(directory, "paseo-plugin.json"),
      JSON.stringify({ id: "source-id", requirements: { paseo: ">=0.8.0" } }),
    );
    await writeFile(path.join(directory, "index.server.ts"), source);
    await client.connect();
    await observer.connect();
    await client.patchDaemonConfig({ pluginsEnabled: true });
    await client.installDirectoryPlugin(directory, "first");
    await client.installDirectoryPlugin(directory, "second");
    expect(await client.invokePluginRpc("first", "contract", null)).toEqual({
      limit: 65_536,
      acceptsDescriptor: true,
      acceptsInvalidStatus: false,
    });
    const parent = await client.createAgent({
      provider: "pi",
      cwd: directory,
      title: "Built-in parent",
    });
    await client.invokePluginRpc("first", "report", { parentAgentId: parent.id });
    await client.invokePluginRpc("second", "report", { parentAgentId: parent.id });
    const result = await observer.listProviderSubagents(parent.id);
    expect(result.error).toBeNull();
    expect(result.subagents).toHaveLength(2);
    const first = result.subagents.find((child) => child.id.startsWith("plugin/first/"))!;
    const second = result.subagents.find((child) => child.id.startsWith("plugin/second/"))!;
    expect(first).toMatchObject({ parentAgentId: parent.id, provider: "pi", status: "running" });
    expect(second).toMatchObject({ parentAgentId: parent.id, provider: "pi", status: "running" });
    const timeline = await observer.fetchProviderSubagentTimeline(parent.id, first.id);
    expect(timeline.error).toBeNull();
    expect(timeline.rows.map((row) => row.item)).toEqual([
      { type: "assistant_message", text: "External output" },
    ]);
    expect(daemon.daemon.agentManager.getAgent(parent.id)?.provider).toBe("pi");
    expect(daemon.daemon.agentManager.listAgents()).toHaveLength(1);

    await client.reloadPlugin("first");
    expect((await observer.listProviderSubagents(parent.id)).subagents).toEqual([second]);
    await client.invokePluginRpc("first", "report", { parentAgentId: parent.id });
    await expect(client.invokePluginRpc("first", "crash", null)).rejects.toThrow();
    await expect
      .poll(async () => (await observer.listProviderSubagents(parent.id)).subagents)
      .toEqual([second]);

    await daemon.daemon.agentManager.closeAgent(parent.id);
    await expect(client.invokePluginRpc("second", "late", null)).rejects.toThrow("closed");
    await client.invokePluginRpc("second", "close", null);
    expect(daemon.daemon.agentManager.listProviderSubagentActivity()).toEqual([]);
    await client.disablePlugin("second");
  } finally {
    await observer.close();
    await client.close();
    await daemon.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);
