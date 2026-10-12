import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { expect, type Page, type TestInfo } from "@playwright/test";
import { connectDaemonClient } from "./daemon-client-loader";
import { openAgentRoute, seedMockAgentWorkspace, type MockAgentWorkspace } from "./mock-agent";
import { pluginRequirements } from "./plugin-fixture";

export const FOOTER_PLUGIN_ID = "timeline-footer-e2e";
const clientSource = `import React, { useState } from "react";
import { Text, View, Pressable } from "react-native";
import { z } from "zod";
export default function contribute(client) {
  let remove;
  function pin() {
    remove = client.addTimelineFooter({
      id: "pending",
      replaces: ["card", "missing", "invalid"].map(kind => ({ kind, version: 1 })),
      Component: React.memo(React.forwardRef(function Footer({ agentId, host }, ref) {
        const [count, setCount] = useState(0);
        const [crash, setCrash] = useState(false);
        if (crash) throw new Error("footer regression failure");
        return <View ref={ref}>
          <Text>{"Pinned on " + host.id + " for " + agentId}</Text>
          <Pressable accessibilityRole="button" onPress={() => setCount(count + 1)}><Text>{"Footer clicks " + count}</Text></Pressable>
          <Pressable accessibilityRole="button" onPress={() => remove()}><Text>Unpin cards</Text></Pressable>
          <Pressable accessibilityRole="button" onPress={() => setCrash(true)}><Text>Crash footer</Text></Pressable>
        </View>;
      })),
    });
  }
  function Card({ item }) {
    return <View>
      <Text>{item.data.label}</Text>
      <Pressable accessibilityRole="button" onPress={pin}><Text>Pin cards</Text></Pressable>
    </View>;
  }
  for (const version of [1, 2]) {
    client.addTimelineRenderer({ kind: "card", version, schema: z.object({ label: z.string() }), Component: Card });
  }
  client.addTimelineRenderer({ kind: "invalid", version: 1, schema: z.object({ label: z.string() }), Component: Card });
  pin();
  return () => remove();
}`;

const serverSource = `import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
const seed = defineRpc({
  name: "seed",
  input: z.object({ agentId: z.string() }),
  output: z.object({}),
});
export default function contribute(server) {
  server.handle(seed, async ({ agentId }, { paseo }) => {
    for (const [id, kind, version, data] of [
      ["missing", "missing", 1, {}],
      ["invalid", "invalid", 1, { label: 42 }],
      ["replaced", "card", 1, { label: "Inline pending card" }],
      ["retained", "card", 2, { label: "Other version stays inline" }],
    ]) {
      await paseo.agents.ref(agentId).timeline.append({ type: "plugin", id, kind, version, data });
    }
    return {};
  });
  return () => {};
}`;

export async function withTimelineFooterPlugin(
  page: Page,
  info: TestInfo,
  run: (agent: MockAgentWorkspace) => Promise<void>,
): Promise<void> {
  info.setTimeout(120_000);
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-footer-plugin-"));
  const agent = await seedMockAgentWorkspace({
    repoPrefix: "timeline-footer-",
    title: "Timeline footer regression",
    initialPrompt: "Create a long transcript.",
    featureValues: {
      mockAssistantResponse: Array.from(
        { length: 50 },
        (_, index) =>
          `History paragraph ${index}: keep the real conversation independently scrollable.`,
      ).join("\n\n"),
    },
  });
  const client = await connectDaemonClient<DaemonClient>({ clientIdPrefix: "footer-plugin" });
  const previous = await client.getDaemonConfig();
  try {
    await agent.client.waitForFinish(agent.agentId, 30_000);
    await writeFile(
      path.join(directory, "paseo-plugin.json"),
      JSON.stringify({ id: FOOTER_PLUGIN_ID, requirements: pluginRequirements }),
    );
    await writeFile(path.join(directory, "index.client.tsx"), clientSource);
    await writeFile(path.join(directory, "index.server.ts"), serverSource);
    await client.patchDaemonConfig({ pluginsEnabled: true });
    await client.installDirectoryPlugin(directory);
    await client.invokePluginRpc(FOOTER_PLUGIN_ID, "seed", { agentId: agent.agentId });
    await openAgentRoute(page, agent);
    await expect(page.getByRole("textbox", { name: "Message agent..." }).first()).toBeVisible();
    await run(agent);
  } finally {
    await info.attach("timeline-footer", {
      body: await page.screenshot({ path: info.outputPath("timeline-footer.png") }),
      contentType: "image/png",
    });
    await client.removePlugin(FOOTER_PLUGIN_ID);
    await client.patchDaemonConfig({ pluginsEnabled: previous.config.pluginsEnabled ?? false });
    await client.close();
    await agent.cleanup();
    await rm(directory, { recursive: true, force: true });
  }
}
