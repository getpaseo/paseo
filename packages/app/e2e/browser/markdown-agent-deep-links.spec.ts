import { writeFile } from "node:fs/promises";
import path from "node:path";
import { buildAgentDeepLink } from "@getpaseo/protocol/agent-deep-link";
import { expect, test, type Page } from "../support/fixtures";
import { awaitAssistantMessage } from "../support/helpers/agent-stream";
import {
  archiveAgentFromDaemon,
  createMockIdleAgent,
  expectArchivedAgentFocused,
  expectWorkspaceTabVisible,
  fetchAgentArchivedAt,
} from "../support/helpers/archive-tab";
import { openFileExplorer, openFileFromExplorer } from "../support/helpers/file-explorer";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";
import { getServerId } from "../support/helpers/server-id";

async function expectSettledTargetWorkspace(
  page: Page,
  workspaceId: string,
  agentId: string,
): Promise<void> {
  await page.waitForURL(
    (url) => url.pathname.includes(`/workspace/${workspaceId}`) && !url.searchParams.has("open"),
    { timeout: 60_000 },
  );
  await expectWorkspaceTabVisible(page, agentId);
}

test("navigates paseo:// agent deep links in-app from chat Markdown and file previews", async ({
  page,
}, testInfo) => {
  testInfo.setTimeout(180_000);

  const serverId = getServerId();
  const targetActive = await seedMockAgentWorkspace({
    repoPrefix: "deep-link-target-",
    title: "Target Active Agent",
    featureValues: {
      mockStreamingAssistantResponse: "Distinctive active target conversation",
      mockStreamingAssistantIntervalMs: 5,
    },
  });

  let source: Awaited<ReturnType<typeof seedMockAgentWorkspace>> | null = null;
  try {
    await targetActive.client.sendAgentMessage(targetActive.agentId, "Init active target");
    await targetActive.client.waitForFinish(targetActive.agentId, 30_000);

    const targetArchived = await createMockIdleAgent(targetActive.client, {
      cwd: targetActive.cwd,
      workspaceId: targetActive.workspaceId,
      title: "Target Archived Agent",
    });
    await archiveAgentFromDaemon(targetActive.client, targetArchived.id);
    await expect
      .poll(() => fetchAgentArchivedAt(targetActive.client, targetArchived.id), {
        timeout: 30_000,
      })
      .not.toBeNull();

    const activeLink = buildAgentDeepLink({ serverId, agentId: targetActive.agentId });
    const archivedLink = buildAgentDeepLink({ serverId, agentId: targetArchived.id });

    source = await seedMockAgentWorkspace({
      repoPrefix: "deep-link-source-",
      title: "Source Markdown Agent",
      featureValues: {
        mockStreamingAssistantResponse: [
          `Explicit [Open Target Active](${activeLink}) link.`,
          "",
          `Bare 见 ${activeLink}，请查看。`,
          "",
          "Invalid [Invalid Link](paseo://invalid) and plain paseo://invalid.",
        ].join("\n\n"),
        mockStreamingAssistantIntervalMs: 5,
      },
    });

    await writeFile(
      path.join(source.cwd, "README.md"),
      `# Agent Links\n\nInline code: \`${archivedLink}\`\n`,
    );

    await openAgentRoute(page, source);
    await source.client.sendAgentMessage(source.agentId, "Show deep links");
    await source.client.waitForFinish(source.agentId, 30_000);
    await awaitAssistantMessage(page, "Open Target Active");

    const assistantMessage = page.getByTestId("assistant-message").first();
    await expect(
      assistantMessage.getByRole("link", { name: "paseo://invalid", exact: true }),
    ).toHaveCount(0);

    await assistantMessage.getByRole("link", { name: "Invalid Link", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/workspace/${source.workspaceId}`));
    await expect(page.getByText(/No file found/i)).toHaveCount(0);

    await assistantMessage.getByRole("link", { name: "Open Target Active", exact: true }).click();
    await expectSettledTargetWorkspace(page, targetActive.workspaceId, targetActive.agentId);
    await awaitAssistantMessage(page, "Distinctive active target conversation");

    await openAgentRoute(page, source);
    await awaitAssistantMessage(page, "Open Target Active");
    await page
      .getByTestId("assistant-message")
      .first()
      .getByRole("link", { name: activeLink, exact: true })
      .click();
    await expectSettledTargetWorkspace(page, targetActive.workspaceId, targetActive.agentId);

    await openAgentRoute(page, source);
    await openFileExplorer(page);
    await openFileFromExplorer(page, "README.md");
    await page
      .getByTestId("markdown-preview-frame")
      .getByRole("link", { name: archivedLink, exact: true })
      .click();

    await expectSettledTargetWorkspace(page, targetActive.workspaceId, targetArchived.id);
    await expectArchivedAgentFocused(page, targetArchived.id);
  } finally {
    await source?.cleanup();
    await targetActive.cleanup();
  }
});
