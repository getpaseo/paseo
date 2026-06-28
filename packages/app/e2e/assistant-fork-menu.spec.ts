import { expect, test, type Page } from "./fixtures";
import { awaitAssistantMessage } from "./helpers/agent-stream";
import { expectComposerVisible } from "./helpers/composer";
import { getE2EDaemonPort } from "./helpers/daemon-port";
import { openAgentRoute, seedMockAgentWorkspace } from "./helpers/mock-agent";
import { getServerId } from "./helpers/server-id";
import { seedSavedSettingsHosts } from "./helpers/settings";

async function openAssistantForkMenu(page: Page): Promise<void> {
  const trigger = page.getByTestId("assistant-fork-menu-trigger").last();
  await expect(trigger).toBeVisible({ timeout: 30_000 });
  await trigger.click();
  await expect(page.getByTestId("assistant-fork-menu-content")).toBeVisible({
    timeout: 10_000,
  });
}

async function expectChatHistoryPill(page: Page): Promise<void> {
  const pill = page.getByTestId("composer-chat-history-attachment-pill").first();
  await expect(pill).toBeVisible({ timeout: 30_000 });
  await expect(pill).toContainText("Chat history");
}

test.describe("Assistant fork menu", () => {
  test.describe.configure({ timeout: 180_000 });

  test("forks an assistant turn into a new workspace draft tab", async ({ page }) => {
    const session = await seedMockAgentWorkspace({
      repoPrefix: "assistant-fork-tab-",
      title: "Assistant fork tab",
      initialPrompt: "Prepare a deterministic assistant turn for fork tab.",
      model: "ten-second-stream",
    });

    try {
      await session.client.waitForFinish(session.agentId, 45_000);
      await openAgentRoute(page, session);
      await expectComposerVisible(page);
      await awaitAssistantMessage(page, "Cycle 1");

      await openAssistantForkMenu(page);
      await page.getByTestId("assistant-fork-menu-new-tab").click();

      await expectChatHistoryPill(page);
    } finally {
      await session.cleanup();
    }
  });

  test("forks an assistant turn into New Workspace and keeps the attachment across host changes", async ({
    page,
  }) => {
    await seedSavedSettingsHosts(page, [
      {
        serverId: getServerId(),
        label: "localhost",
        endpoint: `127.0.0.1:${getE2EDaemonPort()}`,
      },
      {
        serverId: "secondary-assistant-fork-host",
        label: "Secondary host",
        endpoint: "127.0.0.1:9",
      },
    ]);

    const session = await seedMockAgentWorkspace({
      repoPrefix: "assistant-fork-workspace-",
      title: "Assistant fork workspace",
      initialPrompt: "Prepare a deterministic assistant turn for new workspace fork.",
      model: "ten-second-stream",
    });

    try {
      await session.client.waitForFinish(session.agentId, 45_000);
      await openAgentRoute(page, session);
      await expectComposerVisible(page);
      await awaitAssistantMessage(page, "Cycle 1");

      await openAssistantForkMenu(page);
      await page.getByTestId("assistant-fork-menu-new-workspace").click();

      await expect(page).toHaveURL(/\/new\?.*draftId=/, { timeout: 30_000 });
      await expectChatHistoryPill(page);

      await page.getByTestId("host-picker-trigger").click();
      await page
        .getByTestId("new-workspace-host-picker-option-secondary-assistant-fork-host")
        .click();
      await expectChatHistoryPill(page);
    } finally {
      await session.cleanup();
    }
  });
});
