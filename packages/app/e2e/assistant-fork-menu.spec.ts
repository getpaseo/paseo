import { expect, test as base, type Page } from "./fixtures";
import { scrollAgentChatToBottom } from "./helpers/agent-bottom-anchor";
import { awaitAssistantMessage } from "./helpers/agent-stream";
import { expectComposerVisible, submitMessage } from "./helpers/composer";
import { getE2EDaemonPort } from "./helpers/daemon-port";
import {
  openAgentRoute,
  seedMockAgentWorkspace,
  type MockAgentOptions,
  type MockAgentWorkspace,
} from "./helpers/mock-agent";
import { getServerId } from "./helpers/server-id";
import { seedSavedSettingsHosts } from "./helpers/settings";
import { submitNewWorkspaceEmpty } from "./helpers/new-workspace";

const test = base.extend<{
  seedForkWorkspace: (options: MockAgentOptions) => Promise<MockAgentWorkspace>;
}>({
  seedForkWorkspace: async ({ browserName: _browserName }, provide) => {
    const sessions: MockAgentWorkspace[] = [];
    await provide(async (options) => {
      const session = await seedMockAgentWorkspace(options);
      sessions.push(session);
      return session;
    });
    await Promise.allSettled(sessions.map((session) => session.cleanup()));
  },
});

async function openAssistantForkMenu(page: Page): Promise<void> {
  await expect
    .poll(
      async () => {
        await scrollAgentChatToBottom(page);
        return page.getByTestId("assistant-fork-menu-trigger").count();
      },
      { timeout: 30_000 },
    )
    .toBeGreaterThan(0);
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

  test("focuses a forked assistant turn in a new workspace draft tab", async ({
    page,
    seedForkWorkspace,
  }) => {
    const session = await seedForkWorkspace({
      repoPrefix: "assistant-fork-focused-tab-",
      title: "Assistant fork focused tab",
      initialPrompt: "emit 1 coalesced agent stream updates for initial assistant fork turn.",
      model: "ten-second-stream",
    });

    await openAgentRoute(page, session);
    await expectComposerVisible(page);
    await awaitAssistantMessage(page);
    await session.client.waitForFinish(session.agentId, 45_000);

    await submitMessage(page, "emit 1 coalesced agent stream updates while this tab is visible.");
    await session.client.waitForFinish(session.agentId, 45_000);
    await awaitAssistantMessage(page);

    const agentTab = page.getByTestId(`workspace-tab-agent_${session.agentId}`);
    await expect(agentTab).toHaveAttribute("aria-selected", "true");

    await openAssistantForkMenu(page);
    await page.getByTestId("assistant-fork-menu-new-tab").click();

    const selectedTab = page
      .getByTestId("workspace-tabs-row")
      .getByRole("button")
      .and(page.locator('[aria-selected="true"]'));
    await expect(selectedTab).toHaveAttribute("data-testid", /^workspace-tab-draft_/, {
      timeout: 30_000,
    });
    await expect(agentTab).toHaveAttribute("aria-selected", "false");
    await expectChatHistoryPill(page);
  });

  test("keeps the fork attachment after submitting an existing-workspace draft tab", async ({
    page,
    seedForkWorkspace,
  }) => {
    const session = await seedForkWorkspace({
      repoPrefix: "assistant-fork-tab-submit-",
      title: "Assistant fork tab submit",
      initialPrompt: "emit 1 coalesced agent stream updates for assistant fork tab submit.",
      model: "ten-second-stream",
    });

    await openAgentRoute(page, session);
    await expectComposerVisible(page);
    await awaitAssistantMessage(page);
    await session.client.waitForFinish(session.agentId, 45_000);

    await openAssistantForkMenu(page);
    await page.getByTestId("assistant-fork-menu-new-tab").click();
    await expectChatHistoryPill(page);

    await submitMessage(page, "");

    const userMessage = page.getByTestId("user-message").filter({ hasText: "Chat history" }).last();
    await expect(userMessage).toBeVisible({ timeout: 30_000 });
    await expect(userMessage).not.toContainText("Source agent:");
  });

  test("forks an assistant turn into New Workspace and keeps the attachment across host changes", async ({
    page,
    seedForkWorkspace,
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
        // The host does not need to be reachable; this pins that the draft-scoped
        // attachment survives changing the selected target host.
        endpoint: "127.0.0.1:9",
      },
    ]);

    const session = await seedForkWorkspace({
      repoPrefix: "assistant-fork-workspace-",
      title: "Assistant fork workspace",
      initialPrompt: "emit 1 coalesced agent stream updates for assistant fork new workspace.",
      model: "ten-second-stream",
    });

    await openAgentRoute(page, session);
    await expectComposerVisible(page);
    await awaitAssistantMessage(page);
    await session.client.waitForFinish(session.agentId, 45_000);

    await openAssistantForkMenu(page);
    await page.getByTestId("assistant-fork-menu-new-workspace").click();

    await expect(page).toHaveURL(/\/new\?.*draftId=/, { timeout: 30_000 });
    await expectChatHistoryPill(page);

    await page.getByTestId("host-picker-trigger").click();
    await page
      .getByTestId("new-workspace-host-picker-option-secondary-assistant-fork-host")
      .click();
    await expectChatHistoryPill(page);
  });

  test("keeps the fork attachment after the new agent receives its user message", async ({
    page,
    seedForkWorkspace,
  }) => {
    const session = await seedForkWorkspace({
      repoPrefix: "assistant-fork-submit-",
      title: "Assistant fork submit",
      initialPrompt: "emit 1 coalesced agent stream updates for assistant fork submit.",
      model: "ten-second-stream",
    });

    await openAgentRoute(page, session);
    await expectComposerVisible(page);
    await awaitAssistantMessage(page);
    await session.client.waitForFinish(session.agentId, 45_000);

    await openAssistantForkMenu(page);
    await page.getByTestId("assistant-fork-menu-new-workspace").click();
    await expectChatHistoryPill(page);

    await submitNewWorkspaceEmpty(page);

    const userMessage = page.getByTestId("user-message").filter({ hasText: "Chat history" }).last();
    await expect(userMessage).toBeVisible({ timeout: 30_000 });
    await expect(userMessage).not.toContainText("Source agent:");
  });
});
