import { expect, test, type Page } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";
import { connectNewWorkspaceDaemonClient } from "../support/helpers/new-workspace";
import { copyPluginExample } from "../support/helpers/plugin-fixture";

const PLUGIN_ID = "agent-timeline-example";
const AGENT_TITLE = "Billing retries";
const FIRST_PROMPT = "Summarize the billing retry failures.";

function embed(page: Page) {
  return page.getByTestId("example-agent-timeline");
}

async function openAgentInEmbed(page: Page): Promise<void> {
  await gotoAppShell(page);
  await page.getByRole("button", { name: "Agents", exact: true }).click();
  await page
    .getByTestId("example-agent-list")
    .getByRole("button", { name: AGENT_TITLE, exact: true })
    .click();
}

async function sendFromEmbed(page: Page, text: string): Promise<void> {
  const box = embed(page).getByRole("textbox", { name: "Message agent..." });
  await box.fill(text);
  await box.press("Enter");
}

test.describe("AgentTimeline", () => {
  test("a plugin screen embeds an agent's timeline with the composer it chose", async ({
    page,
    context,
  }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width: 1280, height: 800 });
    const agent = await seedMockAgentWorkspace({
      repoPrefix: "plugin-agent-timeline-",
      title: AGENT_TITLE,
      initialPrompt: FIRST_PROMPT,
    });
    const client = await connectNewWorkspaceDaemonClient({ ownProjects: false });
    const previous = await client.getDaemonConfig();
    const example = await copyPluginExample("agent-timeline");
    try {
      await agent.client.waitForFinish(agent.agentId, 30_000);
      await client.patchDaemonConfig({ pluginsEnabled: true });
      await client.installDirectoryPlugin(example.directory);
      await openAgentInEmbed(page);

      await test.step("the simple composer is a message box and Send", async () => {
        await expect(embed(page).getByTestId("user-message")).toContainText(FIRST_PROMPT);
        await expect(embed(page).getByTestId("assistant-message").first()).toBeVisible();
        await expect(
          embed(page).getByRole("textbox", { name: "Message agent..." }),
        ).toHaveAttribute("placeholder", "Message this agent");
        await expect(embed(page).getByTestId("agent-controls-toolbar")).toHaveCount(0);
        await expect(embed(page).getByTestId("message-input-attach-button")).toHaveCount(0);
        await expect(embed(page).getByTestId("context-window-meter")).toHaveCount(0);
        const choices = await page.getByTestId("example-composer-choices").boundingBox();
        const timeline = await embed(page).boundingBox();
        expect(timeline!.y).toBeGreaterThanOrEqual(choices!.y + choices!.height);
      });

      await test.step("a message sent from the embed streams into it", async () => {
        await sendFromEmbed(page, "Check the invoice PDFs next.");
        await expect(embed(page).getByTestId("user-message").last()).toContainText(
          "Check the invoice PDFs next.",
        );
        await agent.client.waitForFinish(agent.agentId, 30_000);
      });

      await test.step("slash text in the simple box reaches the agent as typed", async () => {
        await sendFromEmbed(page, "/exit");
        await expect(embed(page).getByTestId("user-message").last()).toContainText("/exit");
        await agent.client.waitForFinish(agent.agentId, 30_000);
        const fetched = await agent.client.fetchAgent({ agentId: agent.agentId });
        expect(fetched?.agent.archivedAt ?? null).toBeNull();
      });

      await test.step("the full composer hides only the controls the plugin named", async () => {
        await page.getByRole("button", { name: "Full", exact: true }).click();
        await expect(embed(page).getByTestId("agent-controls-toolbar")).toBeVisible();
        await expect(embed(page).getByTestId("message-input-attach-button")).toHaveCount(0);
        await expect(embed(page).getByTestId("context-window-meter")).toBeVisible();
      });

      await test.step("composer={false} shows the timeline without a composer", async () => {
        await page.getByRole("button", { name: "No composer", exact: true }).click();
        await expect(embed(page).getByTestId("user-message").first()).toContainText(FIRST_PROMPT);
        await expect(embed(page).getByRole("textbox", { name: "Message agent..." })).toHaveCount(0);
      });

      await test.step("the agent's tab and the embed stay live together", async () => {
        await page.getByRole("button", { name: "Simple", exact: true }).click();
        const tab = await context.newPage();
        await openAgentRoute(tab, { workspaceId: agent.workspaceId, agentId: agent.agentId });
        const tabBox = tab.getByRole("textbox", { name: "Message agent..." }).first();
        await tabBox.fill("Sent from the tab.");
        await tabBox.press("Enter");
        await expect(embed(page).getByTestId("user-message").last()).toContainText(
          "Sent from the tab.",
        );
        await sendFromEmbed(page, "Sent from the embed.");
        await expect(tab.getByTestId("user-message").last()).toContainText("Sent from the embed.");
        await tab.close();
      });
    } finally {
      await client.removePlugin(PLUGIN_ID).catch(() => undefined);
      await client
        .patchDaemonConfig({ pluginsEnabled: previous.config.pluginsEnabled ?? false })
        .catch(() => undefined);
      await client.close().catch(() => undefined);
      await example.cleanup();
      await agent.cleanup();
    }
  });
});
