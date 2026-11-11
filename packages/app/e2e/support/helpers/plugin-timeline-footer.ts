import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { expect, type Page, type TestInfo } from "@playwright/test";
import { connectDaemonClient } from "./daemon-client-loader";
import {
  buildAgentRoute,
  openAgentRoute,
  seedMockAgentWorkspace,
  type MockAgentWorkspace,
} from "./mock-agent";
import { addConnectedHostAndReload } from "./hosts";
import { startIsolatedHostDaemon } from "./isolated-host-daemon";
import { getServerId } from "./server-id";
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
    await client.removePlugin(FOOTER_PLUGIN_ID);
    await client.patchDaemonConfig({ pluginsEnabled: previous.config.pluginsEnabled ?? false });
    await client.close();
    await agent.cleanup();
    await rm(directory, { recursive: true, force: true });
  }
}

function scrollableHeight(node: HTMLElement): number {
  return node.scrollHeight - node.clientHeight;
}

function scrollTop(node: HTMLElement): number {
  return node.scrollTop;
}

function replacedRows(page: Page) {
  return page
    .getByTestId("agent-chat-scroll")
    .locator(
      `[data-history-row-id$="${FOOTER_PLUGIN_ID}/missing"], [data-history-row-id$="${FOOTER_PLUGIN_ID}/invalid"], [data-history-row-id$="${FOOTER_PLUGIN_ID}/replaced"]`,
    );
}

async function captureFooterScreenshot(page: Page, info: TestInfo, name: string): Promise<void> {
  await info.attach(name, {
    body: await page.screenshot({ path: info.outputPath(`${name}.png`) }),
    contentType: "image/png",
  });
}

export async function expectPinnedFooter(page: Page, agent: MockAgentWorkspace): Promise<void> {
  const footer = page.getByTestId("plugin-timeline-footer");
  const history = page.getByTestId("agent-chat-scroll");
  await expect(
    footer.getByText(`Pinned on ${getServerId()} for ${agent.agentId}`, { exact: true }),
  ).toBeVisible();
  await expect(history.getByText("Plugin timeline item unavailable.", { exact: true })).toHaveCount(
    0,
  );
  await expect(page.getByText("Inline pending card", { exact: true })).toHaveCount(0);
  await expect(replacedRows(page)).toHaveCount(0);
  await expect(history.getByText("Other version stays inline", { exact: true })).toBeVisible();
}

export async function scrollHistoryAndUsePinnedControls(
  page: Page,
  agent: MockAgentWorkspace,
  info: TestInfo,
): Promise<void> {
  const footer = page.getByTestId("plugin-timeline-footer");
  const history = page.getByTestId("agent-chat-scroll");
  await expect(history.getByTestId("plugin-timeline-footer")).toHaveCount(0);
  await expect.poll(() => history.evaluate(scrollableHeight)).toBeGreaterThan(500);
  const before = await footer.boundingBox();
  if (!before) throw new Error("Footer has no bounds");
  const initialScroll = await history.evaluate(scrollTop);
  await history.hover();
  await page.mouse.wheel(0, -600);
  await expect.poll(() => history.evaluate(scrollTop)).toBeLessThan(initialScroll - 100);
  await expect
    .poll(async () => {
      const after = await footer.boundingBox();
      return after ? Math.abs(after.y - before.y) : Infinity;
    })
    .toBeLessThan(1);
  await footer.getByRole("button", { name: "Footer clicks 0", exact: true }).click();
  await expect(footer.getByRole("button", { name: "Footer clicks 1", exact: true })).toBeVisible();
  await history.evaluate((node) => {
    node.scrollTop = node.scrollHeight;
  });
  await expectPinnedFooter(page, agent);
  await captureFooterScreenshot(page, info, "pinned-layout");
}

export async function unpinAndRestoreTimelineCards(page: Page): Promise<void> {
  const footer = page.getByTestId("plugin-timeline-footer");
  const history = page.getByTestId("agent-chat-scroll");
  await footer.getByRole("button", { name: "Unpin cards", exact: true }).click();
  await expect(footer).toHaveCount(0);
  await expect(history.getByText("Inline pending card", { exact: true })).toBeVisible();
  await expect(history.getByText("Plugin timeline item unavailable.", { exact: true })).toHaveCount(
    2,
  );
  await expect(replacedRows(page)).toHaveCount(3);
}

export async function repinTimelineCardsAndReload(
  page: Page,
  agent: MockAgentWorkspace,
): Promise<void> {
  await page
    .getByTestId("agent-chat-scroll")
    .getByRole("button", { name: "Pin cards", exact: true })
    .last()
    .click();
  await expectPinnedFooter(page, agent);
  await page.reload({ waitUntil: "domcontentloaded" });
  await expectPinnedFooter(page, agent);
}

export async function recoverFooterOnSessionChange(
  page: Page,
  agent: MockAgentWorkspace,
): Promise<void> {
  const footer = page.getByTestId("plugin-timeline-footer");
  await footer.getByRole("button", { name: "Crash footer", exact: true }).click();
  await expect(
    footer.getByText("Plugin failed: footer regression failure", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Message agent..." }).first()).toBeVisible();
  const next = await agent.client.createAgent({
    provider: "mock",
    cwd: agent.cwd,
    workspaceId: agent.workspaceId,
    title: "Footer recovery",
    model: "e2e-fast-stream",
    modeId: "load-test",
  });
  await openAgentRoute(page, { workspaceId: agent.workspaceId, agentId: next.id });
  await expect(
    footer.getByText(`Pinned on ${getServerId()} for ${next.id}`, { exact: true }),
  ).toBeVisible();
  await expect(
    footer.getByText("Plugin failed: footer regression failure", { exact: true }),
  ).toHaveCount(0);
}

export async function switchHostsAndVerifyFooterIsolation(
  page: Page,
  primary: MockAgentWorkspace,
): Promise<void> {
  const secondaryDaemon = await startIsolatedHostDaemon("timeline-footer-secondary");
  try {
    const secondary = await seedMockAgentWorkspace({
      repoPrefix: "footer-secondary-",
      title: "Other host",
      port: secondaryDaemon.port,
    });
    try {
      await addConnectedHostAndReload(page, {
        serverId: secondaryDaemon.serverId,
        label: "Other footer host",
        port: secondaryDaemon.port,
      });
      await expect(page.getByTestId("plugin-timeline-footer")).toBeVisible();
      await page.evaluate(() => {
        const nonce = localStorage.getItem("@paseo:e2e-seed-nonce");
        if (!nonce) throw new Error("Missing fixture seed nonce");
        localStorage.setItem("@paseo:e2e-disable-default-seed-once", nonce);
      });
      await page.goto(
        buildAgentRoute(secondary.workspaceId, secondary.agentId, secondaryDaemon.serverId),
      );
      await expect(page.getByRole("textbox", { name: "Message agent..." }).first()).toBeVisible();
      await expect(page.getByTestId("plugin-timeline-footer")).toHaveCount(0);
      await openAgentRoute(page, primary);
      await expectPinnedFooter(page, primary);
    } finally {
      await secondary.cleanup();
    }
  } finally {
    await secondaryDaemon.close();
  }
}

export async function closePageAndVerifyFooterCleanup(page: Page, info: TestInfo): Promise<void> {
  const client = await connectDaemonClient<DaemonClient>({ clientIdPrefix: "footer-cleanup" });
  const previous = await client.getDaemonConfig();
  try {
    const failure = new Error("Footer action failed after closing the page");
    await expect(
      withTimelineFooterPlugin(page, info, async () => {
        await page.close();
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect((await client.listPlugins()).map((plugin) => plugin.id)).not.toContain(FOOTER_PLUGIN_ID);
    expect((await client.getDaemonConfig()).config.pluginsEnabled ?? false).toBe(
      previous.config.pluginsEnabled ?? false,
    );
  } finally {
    await client.close();
  }
}
