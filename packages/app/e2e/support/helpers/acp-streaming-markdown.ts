import path from "node:path";
import { expect, type Page, type TestInfo } from "@playwright/test";
import { seedWorkspace, type SeedDaemonClient } from "./seed-client";
import { openAgentRoute } from "./mock-agent";
import { connectNewWorkspaceDaemonClient } from "./new-workspace";

interface AcpMarkdownAgent {
  client: SeedDaemonClient;
  agentId: string;
}

export async function withAcpStreamingMarkdown(
  page: Page,
  run: (agent: AcpMarkdownAgent) => Promise<void>,
): Promise<void> {
  const workspace = await seedWorkspace({ repoPrefix: "acp-markdown-" });
  const { client } = workspace;
  const pluginClient = await connectNewWorkspaceDaemonClient();
  const previous = await pluginClient.getDaemonConfig();
  try {
    await pluginClient.patchDaemonConfig({ pluginsEnabled: true });
    await pluginClient.installDirectoryPlugin(
      path.resolve(__dirname, "../fixtures/acp-chunks-plugin"),
    );
    const agent = await client.createAgent({
      provider: "acp-chunks",
      cwd: workspace.repoPath,
      workspaceId: workspace.workspaceId,
      title: "ACP Markdown",
    });
    await openAgentRoute(page, { workspaceId: workspace.workspaceId, agentId: agent.id });
    await run({ client, agentId: agent.id });
  } finally {
    try {
      await pluginClient.removePlugin("acp-chunks-test");
      await pluginClient.patchDaemonConfig({ pluginsEnabled: previous.config.pluginsEnabled });
    } finally {
      await pluginClient.close();
      await workspace.cleanup();
    }
  }
}

export async function requestAcpMarkdown(agent: AcpMarkdownAgent): Promise<void> {
  await agent.client.sendAgentMessage(agent.agentId, "Show the temperature and docs.");
  await agent.client.waitForFinish(agent.agentId, 30_000);
}

export async function expectAcpMarkdown(page: Page, count: number): Promise<void> {
  // The message container has no semantic role; text and links inside it are user-facing assertions.
  const messages = page.getByTestId("assistant-message");
  await expect(messages).toHaveCount(count);
  for (let index = 0; index < count; index++) {
    const message = messages.nth(index);
    await expect(message).toHaveText("•Current temperature: 25°C. Read Paseo docs.");
    await expect(
      message.getByRole("link", { name: "Paseo docs" }).and(message.locator("a")),
    ).toHaveAttribute("href", "https://example.com/docs");
    await expect(message.locator('[data-paseo-markdown-tag="strong"]')).toHaveText(
      "Current temperature",
    );
  }
}

export async function reloadAcpMarkdown(page: Page, testInfo: TestInfo): Promise<void> {
  await page.reload({ waitUntil: "domcontentloaded" });
  await expectAcpMarkdown(page, 2);
  await testInfo.attach("acp-markdown-after-reload", {
    body: await page.screenshot({ path: testInfo.outputPath("acp-markdown-after-reload.png") }),
    contentType: "image/png",
  });
}
